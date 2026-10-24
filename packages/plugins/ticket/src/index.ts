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
  ACTIVE_STATUSES,
  ticketMessageModel,
  ticketModel,
  TICKET_STATUSES,
  type TicketData,
  type TicketMessageData,
  type TicketStatus,
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
  category: z.string().trim().min(1).max(64).optional(),
  /** 可选的部门：不传则由管理员后置分配。 */
  departmentId: z.string().trim().min(1).max(191).optional(),
  /** 「从订单/服务发起工单」时带上关联对象。 */
  relatedType: z.enum(['order', 'service', 'product']).optional(),
  relatedId: z.string().trim().min(1).max(191).optional(),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  /** 仅管理员可置 true：内部备注，用户不可见。 */
  internal: z.boolean().optional(),
});

const ticketStatuses = z.enum(TICKET_STATUSES);
const ticketPriorities = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

/**
 * 空字符串归一成 `null`。
 *
 * 管理端的表单控件在「清空」时提交的是 `''` 而不是缺省字段 —— 若直接落库，
 * 会得到 `assigneeId: ''`，从此这条工单既算不上「已指派」（非 null）又对不上
 * 任何用户 id，「待接单」队列也会把它漏掉。
 */
const optionalRef = z
  .string()
  .trim()
  .max(191)
  .nullable()
  .transform((value) => (value === null || value.length === 0 ? null : value));

/** 管理员更新：状态/优先级/处理人/部门/分类。 */
const updateTicketSchema = z
  .object({
    status: ticketStatuses,
    priority: ticketPriorities,
    assigneeId: optionalRef,
    departmentId: optionalRef,
    category: optionalRef,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: '至少需要一个更新字段',
  });

/** 用户侧「关闭」：可选填一句原因，作为普通消息写入时间线。 */
const closeTicketSchema = z.object({
  reason: z.string().trim().max(10000).optional(),
});

const adminFiltersSchema = z.object({
  status: ticketStatuses.optional(),
  priority: ticketPriorities.optional(),
  assigneeId: z.string().min(1).max(191).optional(),
  departmentId: z.string().min(1).max(191).optional(),
  category: z.string().min(1).max(64).optional(),
  /** `true` = 只看未指派；用于「待接单」队列。 */
  unassigned: z.enum(['true', 'false']).optional(),
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
  departmentId?: string;
  category?: string;
  unassigned?: boolean;
} {
  const parsed = adminFiltersSchema.safeParse(query);
  if (!parsed.success) throw new TicketError(400, '查询参数无效');
  return {
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
    ...(parsed.data.assigneeId !== undefined ? { assigneeId: parsed.data.assigneeId } : {}),
    ...(parsed.data.departmentId !== undefined ? { departmentId: parsed.data.departmentId } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
    ...(parsed.data.unassigned !== undefined
      ? { unassigned: parsed.data.unassigned === 'true' }
      : {}),
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
  { type: 'ticket.reminded', category: 'support', label: '工单催单', audience: 'admin', order: 40 },
  { type: 'ticket.assigned', category: 'support', label: '工单指派', order: 50 },
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

/**
 * 读取工单消息。
 *
 * `includeInternal` 只在管理员视角为真：内部备注绝不能泄漏给工单发起人，
 * 否则「内部备注」就失去了意义（也是最容易在视图层漏掉的越权）。
 */
async function loadMessages(ticketId: string, includeInternal: boolean): Promise<MessageView[]> {
  // `internal` 刻意不建索引：它只用于视图层过滤，进 `where` 会让内核报
  // 「字段不可寻址」。单张工单的消息量有界，内存过滤比为一个布尔标记
  // 新增一列索引更划算（索引还会拖慢每次写入）。
  const rows = await extensions().listAll<TicketMessageData>(ticketMessageModel, {
    where: { ticketId: { eq: ticketId } },
    orderBy: { field: 'createdAt' },
  });
  const visible = includeInternal ? rows : rows.filter((row) => row.spec.internal !== true);
  return visible.map(toMessageView);
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
  // relatedType 与 relatedId 必须成对出现：单边数据没有追溯价值，还会让
  // 「按订单查工单」漏掉这些脏数据。
  const hasType = body.data.relatedType !== undefined;
  const hasId = body.data.relatedId !== undefined;
  if (hasType !== hasId) throw new TicketError(400, '请求参数无效');
  const ticket = await runTransaction(async (tx) => {
    const created = await tx.extensions.create<TicketData>(ticketModel, {
      userId,
      subject: body.data.subject,
      status: 'OPEN',
      priority: 'NORMAL',
      assigneeId: null,
      category: body.data.category ?? null,
      departmentId: body.data.departmentId ?? null,
      relatedId: body.data.relatedId ?? null,
      relatedType: body.data.relatedType ?? null,
      reminderCount: 0,
      lastRemindedAtMs: null,
      closedAtMs: null,
      closedBy: null,
    });
    await tx.extensions.create<TicketMessageData>(ticketMessageModel, {
      ticketId: created.name,
      authorId: userId,
      body: body.data.body,
      internal: false,
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
  const messages = await loadMessages(id, admin);
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
  const admin = isAdmin(req);
  const { ticket, messages } = await loadTicket(id, userId, admin);
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
  const admin = isAdmin(req);
  const body = messageSchema.safeParse(req.body);
  if (!body.success) throw new TicketError(400, '请求参数无效');
  if (body.data.internal && !admin) throw new TicketError(403, '无权发内部备注');
  const { ticket } = await loadTicket(id, userId, admin);
  if (!ACTIVE_STATUSES.includes(ticket.spec.status)) {
    throw new TicketError(409, '工单已关闭，无法继续回复');
  }
  // 用户回话会改变「谁在等对方」：从 PENDING_USER/RESOLVED 回到 IN_PROGRESS，
  // 否则工单会一直停在「等用户」而实际用户在等客服。
  const nextStatus: TicketStatus | null =
    !admin && (ticket.spec.status === 'PENDING_USER' || ticket.spec.status === 'RESOLVED')
      ? 'IN_PROGRESS'
      : null;
  const message = await runTransaction(async (tx) => {
    const created = await tx.extensions.create<TicketMessageData>(ticketMessageModel, {
      ticketId: ticket.name,
      authorId: userId,
      body: body.data.body,
      internal: body.data.internal ?? false,
    });
    if (nextStatus) {
      await tx.extensions.update<TicketData>(ticketModel, ticket.name, {
        ...ticket.spec,
        status: nextStatus,
      });
    }
    return created;
  });
  bus().publish('ticket.message.added', {
    ticketId: ticket.name,
    authorId: userId,
  });
  if (body.data.internal) {
    // 内部备注：不通知用户，只提示其他处理人。
    await notifyTicketAdmins({
      type: 'ticket.replied',
      title: '工单有内部备注',
      body: `工单「${ticket.spec.subject}」新增一条内部备注。`,
      link: `/admin/tickets/${encodeURIComponent(ticket.name)}`,
    });
  } else if (admin) {
    // 管理员回复：把状态推到 PENDING_USER（等用户确认），并通知发起人。
    if (ticket.spec.status === 'OPEN' || ticket.spec.status === 'IN_PROGRESS') {
      await extensions().update<TicketData>(ticketModel, ticket.name, {
        ...ticket.spec,
        status: 'PENDING_USER',
      });
    }
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

/**
 * 用户关闭自己的工单。
 *
 * 允许从任意非 CLOSED 状态关闭（用户不该被「已解决」卡住）。关闭原因写成一条
 * 普通消息而不是单独的字段：它属于时间线的一部分，未来查看时上下文才不会断。
 */
async function closeMyTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const userId = requireUser(req);
  const parsed = closeTicketSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new TicketError(400, '请求参数无效');
  const ticket = await extensions().get<TicketData>(ticketModel, id);
  if (!ticket) throw new TicketError(404, '工单不存在');
  if (ticket.spec.userId !== userId) throw new TicketError(403, '无权访问该工单');
  if (ticket.spec.status === 'CLOSED') {
    // 幂等：重复关闭不报错，也不重复写消息。
    return { ticket: toTicketView(ticket) };
  }
  const closed = await runTransaction(async (tx) => {
    if (parsed.data.reason) {
      await tx.extensions.create<TicketMessageData>(ticketMessageModel, {
        ticketId: ticket.name,
        authorId: userId,
        body: parsed.data.reason,
        internal: false,
      });
    }
    return tx.extensions.update<TicketData>(ticketModel, ticket.name, {
      ...ticket.spec,
      status: 'CLOSED',
      closedAtMs: Date.now(),
      closedBy: 'user',
    });
  });
  bus().publish('ticket.status.changed', { ticketId: closed.name, status: 'CLOSED' });
  return { ticket: toTicketView(closed) };
}

/** 用户催单：累计计数 + 通知处理人，不写消息（不污染时间线）。 */
async function remindTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const userId = requireUser(req);
  const ticket = await extensions().get<TicketData>(ticketModel, id);
  if (!ticket) throw new TicketError(404, '工单不存在');
  if (ticket.spec.userId !== userId) throw new TicketError(403, '无权访问该工单');
  if (!ACTIVE_STATUSES.includes(ticket.spec.status)) {
    throw new TicketError(409, '工单已关闭，无法催单');
  }
  const now = Date.now();
  // 同一工单 10 分钟内只提醒一次：防止刷屏，也避免管理员被同一诉求反复打断。
  const COOLDOWN_MS = 10 * 60 * 1000;
  if (ticket.spec.lastRemindedAtMs !== null && now - ticket.spec.lastRemindedAtMs < COOLDOWN_MS) {
    throw new TicketError(429, '催单过于频繁，请稍后再试');
  }
  const updated = await extensions().update<TicketData>(ticketModel, ticket.name, {
    ...ticket.spec,
    reminderCount: ticket.spec.reminderCount + 1,
    lastRemindedAtMs: now,
  });
  bus().publish('ticket.reminded', {
    ticketId: ticket.name,
    userId,
    reminderCount: updated.spec.reminderCount,
  });
  await notifyTicketAdmins({
    type: 'ticket.reminded',
    title: '用户催单',
    body: `工单「${ticket.spec.subject}」被用户催办（第 ${updated.spec.reminderCount} 次）。`,
    link: `/admin/tickets/${encodeURIComponent(ticket.name)}`,
  });
  return { ticket: toTicketView(updated) };
}

async function listAdminTickets(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const filters = parseAdminFilters(req.query);
  if (filters.assigneeId !== undefined && filters.unassigned) {
    throw new TicketError(400, '查询参数无效');
  }
  const where: Record<string, { eq: string | null }> = {};
  if (filters.status !== undefined) where['status'] = { eq: filters.status };
  if (filters.priority !== undefined) where['priority'] = { eq: filters.priority };
  if (filters.assigneeId !== undefined) where['assigneeId'] = { eq: filters.assigneeId };
  if (filters.departmentId !== undefined) where['departmentId'] = { eq: filters.departmentId };
  if (filters.category !== undefined) where['category'] = { eq: filters.category };
  // 未指派在存储层是 null；`{ eq: null }` 是引擎支持的写法。
  if (filters.unassigned) where['assigneeId'] = { eq: null };
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
  const messages = await loadMessages(id, true);
  const userById = await resolveAuthors([
    ticket.spec.userId,
    ...(ticket.spec.assigneeId ? [ticket.spec.assigneeId] : []),
    ...messages.map((message) => message.authorId),
  ]);
  return {
    ...toTicketView(ticket),
    viewerId: req.user?.id ?? null,
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

/**
 * 管理员更新工单。
 *
 * 「接单」= 把 `assigneeId` 设为自己且状态从 OPEN 变 IN_PROGRESS；
 * 「转交」= 改 `assigneeId`。「接单」不是单独接口：避免为同一语义维护两套状态写入。
 */
async function updateAdminTicket(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new TicketError(400, '缺少工单 ID');
  const body = updateTicketSchema.safeParse(req.body);
  if (!body.success) throw new TicketError(400, '请求参数无效');
  const existing = await extensions().get<TicketData>(ticketModel, id);
  if (!existing) throw new TicketError(404, '工单不存在');
  const previousAssignee = existing.spec.assigneeId;
  const previousStatus = existing.spec.status;
  const nextStatus = body.data.status;
  // 终态不可回退：CLOSED 之后只能靠用户新建工单，否则「关闭」就成了摆设。
  if (previousStatus === 'CLOSED' && nextStatus !== undefined && nextStatus !== 'CLOSED') {
    throw new TicketError(409, '已关闭的工单不能重新打开');
  }
  const nextAssignee = body.data.assigneeId !== undefined ? body.data.assigneeId : previousAssignee;
  // 接单：从 OPEN 指派给某人时自动进入 IN_PROGRESS（调用方未显式指定状态时）。
  const derivedStatus: TicketStatus | undefined =
    nextStatus ?? (previousStatus === 'OPEN' && nextAssignee !== null ? 'IN_PROGRESS' : undefined);
  const closedExtra =
    derivedStatus === 'CLOSED' && previousStatus !== 'CLOSED'
      ? { closedAtMs: Date.now(), closedBy: 'admin' }
      : derivedStatus !== undefined && derivedStatus !== 'CLOSED' && previousStatus === 'CLOSED'
        ? { closedAtMs: null, closedBy: null }
        : {};
  const ticket = await extensions().update<TicketData>(ticketModel, id, {
    ...existing.spec,
    ...(body.data.status !== undefined ? { status: body.data.status } : {}),
    ...(derivedStatus !== undefined ? { status: derivedStatus } : {}),
    ...(body.data.priority !== undefined ? { priority: body.data.priority } : {}),
    ...(body.data.assigneeId !== undefined ? { assigneeId: body.data.assigneeId } : {}),
    ...(body.data.departmentId !== undefined ? { departmentId: body.data.departmentId } : {}),
    ...(body.data.category !== undefined ? { category: body.data.category } : {}),
    ...closedExtra,
  });
  if (derivedStatus !== undefined && derivedStatus !== previousStatus) {
    bus().publish('ticket.status.changed', {
      ticketId: id,
      status: derivedStatus,
    });
    await notifyTicket({
      userId: ticket.spec.userId,
      type: 'ticket.status.changed',
      title: '工单状态已更新',
      body: `你的工单「${ticket.spec.subject}」状态已更新为 ${derivedStatus}。`,
      link: `/account/tickets/${encodeURIComponent(id)}`,
      dedupeKey: `ticket:${id}:status`,
    });
  }
  // 指派变化通知新处理人（含「转交」）。自己指派给自己不通知。
  const assigneeChanged = nextAssignee !== previousAssignee;
  if (assigneeChanged && nextAssignee !== null) {
    await notifyTicket({
      userId: nextAssignee,
      type: 'ticket.assigned',
      title: '工单已指派给你',
      body: `工单「${ticket.spec.subject}」已指派给你处理。`,
      link: `/admin/tickets/${encodeURIComponent(id)}`,
      dedupeKey: `ticket:${id}:assignee`,
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
    version: '0.3.0',
    description:
      '工单系统：用户提交/关闭/催单，管理员接单/转交/内部备注，支持分类、部门与关联订单。',
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
      method: 'POST',
      path: '/tickets/:id/close',
      auth: 'user',
      permission: 'ticket.create',
      handler: handle(closeMyTicket),
    },
    {
      method: 'POST',
      path: '/tickets/:id/remind',
      auth: 'user',
      permission: 'ticket.create',
      handler: handle(remindTicket),
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
