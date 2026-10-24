import type { FrontendPackage } from '@stackpanel/sdk';
import { messages } from './i18n.js';

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    actions: [
      {
        id: 'epay.configure',
        method: 'POST',
        path: '/epay/admin/config',
        permission: 'epay.admin',
        // The admin form submits directly and toasts its own result.
        silent: true,
        input: [
          { name: 'baseUrl', type: 'string', required: true, maxLength: 191 },
          { name: 'pid', type: 'string', required: true, maxLength: 64 },
          {
            name: 'privateKey',
            type: 'string',
            required: true,
            maxLength: 20000,
          },
          {
            name: 'platformPublicKey',
            type: 'string',
            required: true,
            maxLength: 20000,
          },
          { name: 'methods', type: 'string', required: true, maxLength: 64 },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/settings',
        component: 'admin/overview',
        permission: 'epay.admin',
        nav: { labelKey: 'nav.settings', groupKey: 'nav.group', order: 20 },
        data: [{ fetch: { path: '/epay/admin/config' }, as: 'status' }],
      },
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'epay.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 10 },
        data: [{ fetch: { path: '/epay/admin/config' }, as: 'status' }],
      },
    ],
  },
};

export default frontend;
