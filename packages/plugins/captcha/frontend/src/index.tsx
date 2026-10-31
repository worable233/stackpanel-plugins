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
        permission: 'captcha.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 125 },
        // Declarative data (ADR-0027): the host performs the kernel GET, so this
        // settings panel works without granting the package server execution.
        data: [{ fetch: { path: '/captcha/admin/config' }, as: 'status' }],
      },
    ],
  },
};
export default frontend;
