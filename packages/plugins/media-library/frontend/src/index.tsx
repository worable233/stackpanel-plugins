import type { FrontendPackage } from '@stackpanel/sdk';
import { messages } from './i18n.js';

/**
 * Media library console entry.
 *
 * The page is client-rendered and fetches through this package's own bridge
 * routes, so the package stays `declarative`: no finder runs inside the web
 * process and the admin page needs no server-execution admission (ADR-0024).
 *
 * `nav.group` intentionally resolves to the same label the CMS package uses
 * ("内容" / "Content"), which makes both land in one sidebar group.
 */
export const mediaLibraryFrontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    adminRoutes: [
      {
        path: '/library',
        component: 'admin/library',
        nav: { labelKey: 'nav.library', groupKey: 'nav.group', order: 40 },
      },
    ],
  },
};

export default mediaLibraryFrontend;
