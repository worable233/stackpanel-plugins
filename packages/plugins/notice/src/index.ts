import { defineModel, definePlugin, PluginError } from '@stackpanel/sdk';
import type { ExtensionClient, ExtensionInstance, HttpReply, HttpRequest } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 站点公告插件（自定义模型示范）。
 *
 * 通过 `defineModel` 声明 `notice/announcement` 模型。Extension 引擎生成真实表与
 * 索引；插件读写全部经 `ctx.extensions`，不再接触裸 DB。
 *
 * 路由：
 *   GET  /notices                              公开：已发布公告列表
 *   GET  /notice/admin/announcements           管理：全部公告
 *   POST /notice/admin/announcements           管理：新建公告
 *   PATCH  /notice/admin/announcements/:id      管理：更新公告
 *   DELETE /notice/admin/announcements/:id      管理：删除公告
 */

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(191),
  content: z.string().trim().min(1).max(5000),
  published: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

type AnnouncementData = z.infer<typeof announcementSchema>;

const createSchema = announcementSchema;
const updateSchema = announcementSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个更新字段' });

const idSchema = z.object({ id: z.string().min(1).max(191) });

/** Stable codes for notice errors (ADR-0012). */
const NOTICE_ERROR_CODES: Record<string, string> = {
  '缺少公告 ID': 'notice.id_required',
  '公告参数无效': 'notice.params_invalid',
  公告不存在: 'notice.not_found',
  公告插件未就绪: 'notice.not_ready',
};

class NoticeError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.code = NOTICE_ERROR_CODES[message] ?? 'notice.error';
  }
}

export const announcementModel = defineModel({
  kind: 'notice/announcement',
  label: '站点公告',
  schema: announcementSchema,
  indexes: [
    { fields: ['published'], types: { published: 'boolean' } },
    { fields: ['sortOrder'], types: { sortOrder: 'integer' } },
  ],
});

let extensionClient: ExtensionClient | null = null;

function extensions(): ExtensionClient {
  if (!extensionClient) throw new NoticeError(503, '公告插件未就绪');
  return extensionClient;
}

interface AnnouncementView extends AnnouncementData {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

function toView(instance: ExtensionInstance<AnnouncementData>): AnnouncementView {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

async function viewById(id: string): Promise<AnnouncementView> {
  const instance = await extensions().get<AnnouncementData>(announcementModel, id);
  if (!instance) throw new NoticeError(404, '公告不存在');
  return toView(instance);
}

async function listAnnouncements(onlyPublished: boolean): Promise<unknown> {
  const items = await extensions().listAll<AnnouncementData>(
    announcementModel,
    onlyPublished ? { where: { published: { eq: true } } } : undefined,
  );
  const announcements = items
    .map(toView)
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || right.createdAt.getTime() - left.createdAt.getTime(),
    );
  return { announcements };
}

async function requireAnnouncement(id: string): Promise<void> {
  const instance = await extensions().get<AnnouncementData>(announcementModel, id);
  if (!instance) throw new NoticeError(404, '公告不存在');
}

async function createAnnouncement(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new NoticeError(400, '公告参数无效');
  const instance = await extensions().create<AnnouncementData>(announcementModel, parsed.data);
  return reply.code(201).send({ announcement: toView(instance) });
}

async function updateAnnouncement(req: HttpRequest): Promise<unknown> {
  const params = idSchema.safeParse(req.params);
  if (!params.success) throw new NoticeError(400, '缺少公告 ID');
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new NoticeError(400, '公告参数无效');
  const current = await viewById(params.data.id);
  const next: AnnouncementData = {
    title: parsed.data.title ?? current.title,
    content: parsed.data.content ?? current.content,
    published: parsed.data.published ?? current.published,
    sortOrder: parsed.data.sortOrder ?? current.sortOrder,
  };
  const instance = await extensions().update<AnnouncementData>(
    announcementModel,
    params.data.id,
    next,
  );
  return { announcement: toView(instance) };
}

async function deleteAnnouncement(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const params = idSchema.safeParse(req.params);
  if (!params.success) throw new NoticeError(400, '缺少公告 ID');
  await requireAnnouncement(params.data.id);
  await extensions().delete(announcementModel, params.data.id);
  return reply.code(204).send();
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof NoticeError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export const noticePlugin = definePlugin({
  manifest: {
    id: 'notice',
    name: '站点公告',
    version: '0.2.0',
    description: '站点公告：发布与维护前台公告，通过自定义模型（notice/announcement）实现。',
    permissions: ['notice.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['notice.admin'] }],
  },
  customModels: [announcementModel],
  routes: [
    {
      method: 'GET',
      path: '/notices',
      auth: 'public',
      handler: handle(() => listAnnouncements(true)),
    },
    {
      method: 'GET',
      path: '/notice/admin/announcements',
      auth: 'admin',
      permission: 'notice.admin',
      handler: handle(() => listAnnouncements(false)),
    },
    {
      method: 'POST',
      path: '/notice/admin/announcements',
      auth: 'admin',
      permission: 'notice.admin',
      handler: handle(createAnnouncement),
    },
    {
      method: 'PATCH',
      path: '/notice/admin/announcements/:id',
      auth: 'admin',
      permission: 'notice.admin',
      handler: handle(updateAnnouncement),
    },
    {
      method: 'DELETE',
      path: '/notice/admin/announcements/:id',
      auth: 'admin',
      permission: 'notice.admin',
      handler: handle(deleteAnnouncement),
    },
  ],
  onRegister: (ctx) => ctx.logger.info('notice: registered'),
  onActivate: (ctx) => {
    extensionClient = ctx.extensions;
    ctx.logger.info('notice: activated');
  },
  onDeactivate: (ctx) => {
    extensionClient = null;
    ctx.logger.info('notice: deactivated');
  },
});

export default noticePlugin;
