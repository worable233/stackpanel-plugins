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
        permission: 'smtp.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 130 },
        // The settings page must open on the *current* relay, not on an empty
        // form: a blank host/port pair that gets saved silently disables mail
        // delivery. `fetch` is right for this: the host performs a plain kernel
        // GET under the operator's own session (ADR-0027), so the page needs **no**
        // server-execution admission — nothing from this package runs in the web
        // process.
        data: [{ fetch: { path: '/smtp/admin/config' }, as: 'status' }],
      },
    ],
  },
};
export default frontend;
