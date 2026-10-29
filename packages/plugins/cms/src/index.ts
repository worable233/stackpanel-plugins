import { definePlugin, EXTENSION_POINTS } from '@stackpanel/sdk';
import type { JobContext } from '@stackpanel/sdk';
import { CMS_PERMISSIONS, createRoutes } from './routes.js';
import { pageModel, postModel, redirectModel, revisionModel } from './models.js';
import { ContentWorkflow } from './workflow.js';
import { createCmsSeoProvider } from './seo.js';

/**
 * Content management plugin (content workflow, F4/F5).
 *
 * Declares four Extension models — `cms/post`, `cms/page`, `cms/revision`,
 * `cms/redirect` — so the kernel derives real tables and indexes at activation:
 * **no plugin DDL and no Prisma migration.** The plugin owns the full content
 * lifecycle:
 *
 *   - drafts and an immutable revision history per item;
 *   - publish / unpublish / revert-to-draft;
 *   - scheduled publishing via a kernel worker job (`cms.publish-due`);
 *   - authenticated preview of a draft or any revision;
 *   - slug retirement: changing a published slug writes a redirect row and
 *     `GET /cms/redirects/resolve` returns the 301 target (F5).
 *
 * Public read surface:
 *   GET /cms/posts            → live posts
 *   GET /cms/pages            → live pages
 *   GET /cms/posts/:slug      → one live post
 *   GET /cms/pages/:slug      → one live page
 *   GET /cms/redirects/resolve?path=/blog/old → 301 target for a retired slug
 *
 * Admin authoring surface lives under `/cms/admin/**` (auth: admin).
 */

let workflow: ContentWorkflow | null = null;

function currentWorkflow(): ContentWorkflow | null {
  return workflow;
}

/** Fixed interval the scheduler runs at; a single job publishes every due item. */
const PUBLISH_SWEEP_MS = 60_000;

export const cmsPlugin = definePlugin({
  manifest: {
    id: 'cms',
    name: 'CMS 内容管理',
    version: '0.3.0',
    description:
      '文章与页面：草稿 / 版本 / 定时发布 / 预览 + slug 变更 301，含内容语言与译文分组。',
    permissions: CMS_PERMISSIONS,
    roleTemplates: [
      { role: 'USER', permissions: ['custom.cms.post.read', 'custom.cms.page.read'] },
    ],
    // A5: 声明插件支持的界面语言（ADR-0016 §5）。
    locales: ['zh-CN', 'en-US'],
  },
  customModels: [postModel, pageModel, revisionModel, redirectModel],
  routes: createRoutes(currentWorkflow),
  onRegister: (ctx) => ctx.logger.info('cms: registered'),
  onActivate: async (ctx) => {
    workflow = new ContentWorkflow(ctx.extensions, ctx.jobs);
    registerPublishSweep(ctx.jobs);
    // SEO 输送（ADR-0011）：把已发布内容作为 sitemap/feed/hreflang 来源登记；
    // 平台聚合，插件不自行拼 origin。停用时随注册的 effect 自动撤销。
    ctx.registerExtension(EXTENSION_POINTS.seoProvider, createCmsSeoProvider(workflow));
    ctx.logger.info('cms: activated');
  },
  onDeactivate: (ctx) => {
    workflow = null;
    ctx.logger.info('cms: deactivated');
  },
});

/** Arm the recurring sweep that promotes scheduled items when they come due. */
function registerPublishSweep(jobs: JobContext): void {
  // `publish-due` is both the recurring sweep handler and the handler a
  // per-item delayed job (`scheduleIfDue`) triggers at its scheduled time; both
  // run the same idempotent "publish everything currently due" pass. The
  // schedule must use that same name — scheduling `publish-sweep` armed a timer
  // that fired into nothing (`[jobs] 忽略未知任务：cms.publish-sweep`), so
  // scheduled content never went live on that path.
  jobs.handle('publish-due', async () => {
    await workflow?.publishDue();
  });
  void jobs.schedule('publish-due', { everyMs: PUBLISH_SWEEP_MS });
}

export default cmsPlugin;
