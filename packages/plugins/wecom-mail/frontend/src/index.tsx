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
        permission: 'wecom-mail.admin',
        systemSettings: { labelKey: 'admin.systemSettings', order: 135 },
        // The page must open on the *current* app credentials (corpid, sender,
        // exclusions), not on an empty form: re-saving a blank form would wipe a
        // working mail channel. `fetch` is the right channel — the host performs
        // a plain kernel GET under the operator's own session (ADR-0027), so this
        // page needs **no** server-execution admission: nothing from this package
        // runs inside the web process.
        data: [{ fetch: { path: '/wecom-mail/admin/config' }, as: 'status' }],
      },
    ],
  },
};
export default frontend;
