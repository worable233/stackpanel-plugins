import type { FrontendPackage } from '@stackpanel/sdk';
import { messages } from './i18n.js';

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/settings',
        permission: 'alipay.admin',
        nav: { labelKey: 'nav.settings', groupKey: 'nav.group', order: 30 },
        data: [{ fetch: { path: '/alipay/admin/config' }, as: 'status' }],
      },
    ],
  },
};

export default frontend;
