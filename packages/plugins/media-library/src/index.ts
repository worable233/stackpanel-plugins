import { definePlugin } from '@stackpanel/sdk';
import { createRoutes } from './routes.js';

/**
 * Media library console (media-library plugin).
 *
 * Scope split, deliberately: the kernel owns the attachment domain (storage,
 * sniffing, variants, reference integrity) and exposes `/media/admin/*` for the
 * cross-owner queries a console needs; this plugin owns the **console** — an
 * admin page plus the thin bridge routes that forward to the kernel with the
 * caller's own session token. Nothing here duplicates media policy, so the page
 * can never drift from the upload path.
 *
 * The frontend is client-rendered and fetches through these routes, which keeps
 * the package `declarative` (no server-side execution in the web process).
 */
export const mediaLibraryPlugin = definePlugin({
  manifest: {
    id: 'media-library',
    name: '媒体库',
    version: '0.1.0',
    description: '跨用户浏览、预览、删除附件，切换可见性并重建缩略图。',
    locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  },
  routes: createRoutes(),
});

export default mediaLibraryPlugin;
