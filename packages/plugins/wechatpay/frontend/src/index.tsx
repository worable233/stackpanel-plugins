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
        permission: 'wechatpay.admin',
        nav: { labelKey: 'nav.settings', groupKey: 'nav.group', order: 31 },
        data: [{ fetch: { path: '/wechatpay/admin/config' }, as: 'status' }],
      },
    ],
  },
};

export default frontend;
