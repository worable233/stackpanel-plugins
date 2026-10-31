import type { FrontendPackage } from '@stackpanel/sdk';
import { messages } from './i18n.js';

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/settings',
        permission: 'altcha.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 126 },
        // Declarative data (ADR-0027): the host performs the kernel GET, so this
        // panel needs no server execution grant.
        data: [{ fetch: { path: '/altcha/admin/config' }, as: 'status' }],
      },
    ],
  },
};

export default frontend;
