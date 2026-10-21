import { definePlugin, EXTENSION_POINTS, PluginError } from '@stackpanel/sdk';
import type {
  AdminDashboardWidgetMeta,
  AuthUser,
  ExtensionInstance,
  HttpReply,
  HttpRequest,
  NotificationTypeDefinition,
} from '@stackpanel/sdk';
import { z } from 'zod';
import {
  authService,
  bindContext,
  bus,
  extensions,
  notifications,
  resetContext,
  runTransaction,
  TicketError,
} from './context.js';
import {
  ticketMessageModel,
  ticketModel,
  type TicketData,
  type TicketMessageData,
} from './data.js';

interface TicketView extends TicketData {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageView extends TicketMessageData {
  id: string;
  createdAt: string;
}

const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(191),
  body: z.string().trim().min(1).max(10000),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

const ticketStatuses = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
const ticketPriorities = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

const updateTicketSchema = z
  .object({
    status: ticketStatuses,
    priority: ticketPriorities,
    assigneeId: z.string().min(1).max(191),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要一个更新字段',
  });

const adminFiltersSchema = z.object({
  status: ticketStatuses.optional(),
  priority: ticketPriorities.optional(),
  assigneeId: z.string().min(1).max(191).optional(),
});

function parsePagination(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  const parsed = z
    .object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    })
    .safeParse(query);
  return parsed.success ? parsed.data : { page: 1, pageSize: 20 };
}

function parseAdminFilters(query: Record<string, unknown>): {
  status?: string;
  priority?: string;
  assigneeId?: string;
} {
  const parsed = adminFiltersSchema.safeParse(query);
  if (!parsed.success) throw new TicketError(400, '查询参数无效');
  return {
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
    ...(parsed.data.assigneeId !== undefined ? { assigneeId: parsed.data.assigneeId } : {}),
  };
}

function requireUser(req: HttpRequest): string {
  const id = req.user?.id;
  if (!id) throw new TicketError(401, '未登录');
  return id;
}

/**
 * 工单业务通知（站内）。best-effort：写入失败只告警，绝不回滚工单本身。
 * 回复/状态变化用 `dedupeKey` 合并重放，避免刷屏。
 */

/** 本插件会发出的通知类型（`notification.type` 扩展点，供内核偏好目录展示）。 */
export const TICKET_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  { type: 'ticket.created', category: 'support', label: '新工单', audience: 'admin', order: 10 },
  { type: 'ticket.replied', category: 'support', label: '工单回复', order: 20 },
  { type: 'ticket.status.changed', category: 'support', label: '工单状态变更', order: 30 },
];

async function notifyTicket(input: {
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string;
  dedupeKey?: string;
}): Promise<void> {
  try {
    const service = notifications();
    if (input.dedupeKey) {
      await service.upsert({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
        dedupeKey: input.dedupeKey,
      });
    } else {
      await service.create({
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
      });
    }
  } catch (error) {
    // 通知失败不影响工单流程。
    console.warn(`ticket: notification ${input.type} failed: ${String(error)}`);
  }
}

/** 广播给持有 ticket.admin 权限的处理人（内核解析收件人）。 */
async function notifyTicketAdmins(input: {
  type: string;
  title: string;
  body: string;
  link: string;
}): Promise<void> {
  try {
    await notifications().notifyPermissionHolders('ticket.admin', {
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
    });
  } catch (error) {
    console.warn(`ticket: admin notification ${input.type} failed: ${String(error)}`);
  }
}

function isAdmin(req: HttpRequest): boolean {
  return req.user?.role === 'ADMIN';
}

/** 将 Extension 实例映射为工单视图（供既有前端消费）。 */
function toTicketView(instance: ExtensionInstance<TicketData>): TicketView {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

function toMessageView(instance: ExtensionInstance<TicketMessageData>): MessageView {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt.toISOString(),
  };
}

async function loadMessages(ticketId: string): Promise<MessageView[]> {
  const rows = await extensions().listAll<TicketMessageData>(ticketMessageModel, {
    where: { ticketId: { eq: ticketId } },
    orderBy: { field: 'createdAt' },
  });
  return rows.map(toMessageView);
}

async function listMyTickets(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const userId = requireUser(req);
  const { page, pageSize } = parsePagination(req.query);
  const result = await extensions().list<TicketData>(ticketModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return {
    tickets: result.items.map(toTicketView),
    total: result.total,
    page,
    pageSize,
  };
}

async function createTicket(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const userId = requireUser(req);
  const body = createTicketSchema.safeParse(req.body);
  if (!body.success) throw new TicketError(400, '请求参数无效');
  const ticket = await runTransaction(async (tx) => {
    const created = await tx.extensions.create<TicketData>(ticketModel, {
      userId,
      subject: body.data.subject,
      status: 'OPEN',
      priority: 'NORMAL',
      assigneeId: null,
    });
    await tx.extensions.create<TicketMessageData>(ticketMessageModel, {
      ticketId: created.name,
      authorId: userId,
      body: body.data.body,
    });
    return created;
  });
  bus().publish('ticket.created', { ticketId: ticket.name, userId });
  await notifyTicketAdmins({
    type: 'ticket.created',
    title: '新工单待处理',
    body: `用户提交了新工单「${ticket.spec.subject}」。`,
    link: `/admin/tickets/${encodeURIComponent(ticket.name)}`,
  });
  return reply.code(201).send({
    ticket: toTicketView(ticket),
    redirectUrl: `/account/tickets/${encodeURIComponent(ticket.name)}`,
  });
}

async function loadTicket(
  id: string,
  userId: string,
  admin: boolean,
): Promise<{ ticket: ExtensionInstance<TicketData>; messages: MessageView[] }> {
  const ticket = await extensions().get<TicketData>(ticketModel, id);
  if (!ticket) throw new TicketError(404, '工单不存在');
  if (!admin && ticket.spec.userId !== userId) throw new TicketError(403, '无权访问该工单');
  const messages = await loadMessages(id);
  return { ticket, messages };
}

/** 批量解析用户邮箱与管理员标识，供前端给消息署名。 */
async function resolveAuthors(userIds: string[]): Promise<Map<string, AuthUser>> {
  const unique = Array.from(new Set(userIds)).filter(Boolean);
  const users = await authService().listUsersByIds(unique);
  return new Map(users.map((user) => [user.id, user]));
}

async function getTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const userId = requireUser(req);
  const { ticket, messages } = await loadTicket(id, userId, isAdmin(req));
  const userById = await resolveAuthors([
    ticket.spec.userId,
    ...(ticket.spec.assigneeId ? [ticket.spec.assigneeId] : []),
    ...messages.map((message) => message.authorId),
  ]);
  return {
    ...toTicketView(ticket),
    viewerId: userId,
    userEmail: userById.get(ticket.spec.userId)?.email ?? null,
    assigneeEmail: ticket.spec.assigneeId
      ? (userById.get(ticket.spec.assigneeId)?.email ?? null)
      : null,
    messages: messages.map((message) => ({
      ...message,
      authorEmail: userById.get(message.authorId)?.email ?? null,
      authorRole: userById.get(message.authorId)?.role ?? 'USER',
    })),
  };
}

async function addMessage(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const userId = requireUser(req);
  const body = messageSchema.safeParse(req.body);
  if (!body.success) throw new TicketError(400, '请求参数无效');
  const { ticket } = await loadTicket(id, userId, isAdmin(req));
  const message = await extensions().create<TicketMessageData>(ticketMessageModel, {
    ticketId: ticket.name,
    authorId: userId,
    body: body.data.body,
  });
  bus().publish('ticket.message.added', {
    ticketId: ticket.name,
    authorId: userId,
  });
  // 回复通知：管理员回复通知工单发起人；用户回复通知处理人/管理员。
  if (isAdmin(req)) {
    await notifyTicket({
      userId: ticket.spec.userId,
      type: 'ticket.replied',
      title: '工单有新回复',
      body: `你的工单「${ticket.spec.subject}」收到一条新回复。`,
      link: `/account/tickets/${encodeURIComponent(ticket.name)}`,
      dedupeKey: `ticket:${ticket.name}:reply`,
    });
  } else {
    await notifyTicketAdmins({
      type: 'ticket.replied',
      title: '工单有新回复',
      body: `工单「${ticket.spec.subject}」收到用户回复。`,
      link: `/admin/tickets/${encodeURIComponent(ticket.name)}`,
    });
  }
  return reply.code(201).send({ message: toMessageView(message) });
}

async function listAdminTickets(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const filters = parseAdminFilters(req.query);
  const where: Record<string, { eq: string }> = {};
  if (filters.status !== undefined) where['status'] = { eq: filters.status };
  if (filters.priority !== undefined) where['priority'] = { eq: filters.priority };
  if (filters.assigneeId !== undefined) where['assigneeId'] = { eq: filters.assigneeId };
  const result = await extensions().list<TicketData>(ticketModel, {
    where,
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  const userById = await resolveAuthors(
    result.items.flatMap((ticket) => [
      ticket.spec.userId,
      ...(ticket.spec.assigneeId ? [ticket.spec.assigneeId] : []),
    ]),
  );
  return {
    tickets: result.items.map((ticket) => ({
      ...toTicketView(ticket),
      userEmail: userById.get(ticket.spec.userId)?.email ?? null,
      assigneeEmail: ticket.spec.assigneeId
        ? (userById.get(ticket.spec.assigneeId)?.email ?? null)
        : null,
    })),
    total: result.total,
    page,
    pageSize,
  };
}

async function getAdminTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const ticket = await extensions().get<TicketData>(ticketModel, id);
  if (!ticket) throw new TicketError(404, '工单不存在');
  const messages = await loadMessages(id);
  const userById = await resolveAuthors([
    ticket.spec.userId,
    ...(ticket.spec.assigneeId ? [ticket.spec.assigneeId] : []),
    ...messages.map((message) => message.authorId),
  ]);
  return {
    ...toTicketView(ticket),
    userEmail: userById.get(ticket.spec.userId)?.email ?? null,
    assigneeEmail: ticket.spec.assigneeId
      ? (userById.get(ticket.spec.assigneeId)?.email ?? null)
      : null,
    messages: messages.map((message) => ({
      ...message,
      authorEmail: userById.get(message.authorId)?.email ?? null,
      authorRole: userById.get(message.authorId)?.role ?? 'USER',
    })),
  };
}

async function updateAdminTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const body = updateTicketSchema.safeParse(req.body);
  if (!body.success) throw new TicketError(400, '请求参数无效');
  const existing = await extensions().get<TicketData>(ticketModel, id);
  if (!existing) throw new TicketError(404, '工单不存在');
  const ticket = await extensions().update<TicketData>(ticketModel, id, {
    ...existing.spec,
    ...(body.data.status !== undefined ? { status: body.data.status } : {}),
    ...(body.data.priority !== undefined ? { priority: body.data.priority } : {}),
    ...(body.data.assigneeId !== undefined ? { assigneeId: body.data.assigneeId } : {}),
  });
  if (body.data.status !== undefined) {
    bus().publish('ticket.status.changed', {
      ticketId: id,
      status: body.data.status,
    });
    await notifyTicket({
      userId: ticket.spec.userId,
      type: 'ticket.status.changed',
      title: '工单状态已更新',
      body: `你的工单「${ticket.spec.subject}」状态已更新为 ${body.data.status}。`,
      link: `/account/tickets/${encodeURIComponent(id)}`,
      dedupeKey: `ticket:${id}:status`,
    });
  }
  return { ticket: toTicketView(ticket) };
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (err) {
      if (err instanceof TicketError) {
        throw new PluginError(err.code, err.status, err.message);
      }
      throw err;
    }
  };
}

export const ticketPlugin = definePlugin({
  manifest: {
    id: 'ticket',
    name: '工单插件',
    version: '0.2.0',
    description: '工单系统：用户提交工单，管理员跟进处理，支持多轮消息回复。',
    permissions: ['ticket.view', 'ticket.create', 'ticket.admin'],
    roleTemplates: [
      { role: 'USER', permissions: ['ticket.view', 'ticket.create'] },
      { role: 'ADMIN', permissions: ['ticket.admin'] },
    ],
    capabilities: [
      {
        id: 'ticket.list',
        method: 'GET',
        route: '/tickets',
        path: '/api/v1/tickets',
        summary: "The caller's own tickets",
      },
      {
        id: 'ticket.read',
        method: 'GET',
        route: '/tickets/:id',
        path: '/api/v1/tickets/:id',
        summary: 'Read one of the caller tickets',
      },
    ],
  },
  customModels: [ticketModel, ticketMessageModel],
  routes: [
    {
      method: 'GET',
      path: '/tickets',
      auth: 'user',
      permission: 'ticket.view',
      handler: handle(listMyTickets),
    },
    {
      method: 'POST',
      path: '/tickets',
      auth: 'user',
      permission: 'ticket.create',
      handler: handle(createTicket),
    },
    {
      method: 'GET',
      path: '/tickets/:id',
      auth: 'user',
      permission: 'ticket.view',
      handler: handle(getTicket),
    },
    {
      method: 'POST',
      path: '/tickets/:id/messages',
      auth: 'user',
      permission: 'ticket.create',
      handler: handle(addMessage),
    },
    {
      method: 'GET',
      path: '/ticket/admin/tickets',
      auth: 'admin',
      permission: 'ticket.admin',
      handler: handle(listAdminTickets),
    },
    {
      method: 'GET',
      path: '/ticket/admin/tickets/:id',
      auth: 'admin',
      permission: 'ticket.admin',
      handler: handle(getAdminTicket),
    },
    {
      method: 'PATCH',
      path: '/ticket/admin/tickets/:id',
      auth: 'admin',
      permission: 'ticket.admin',
      handler: handle(updateAdminTicket),
    },
  ],
  onActivate: (ctx) => {
    bindContext(ctx.extensions, ctx.events, ctx.auth, ctx.tx, ctx.notifications);
    // 声明本插件发出的通知类型，供内核偏好目录展示（未声明不可关闭）。
    for (const def of TICKET_NOTIFICATION_TYPES) {
      ctx.registerExtension<NotificationTypeDefinition>(EXTENSION_POINTS.notificationType, def);
    }
    ctx.registerExtension<AdminDashboardWidgetMeta>(EXTENSION_POINTS.adminDashboard, {
      id: 'ticket-summary',
      title: '最近工单',
      description: '待处理的用户工单与最近动态。',
    });
    ctx.logger.info('ticket: activated (extension engine)');
  },
  onDeactivate: (ctx) => {
    resetContext();
    ctx.logger.info('ticket: deactivated');
  },
});

export default ticketPlugin;
