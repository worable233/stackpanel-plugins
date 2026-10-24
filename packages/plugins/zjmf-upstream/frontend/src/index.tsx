import type { FrontendPackage } from '@stackpanel/sdk';
import { messages } from './i18n.js';

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    actions: [
      {
        id: 'zjmf-upstream.create',
        method: 'POST',
        path: '/zjmf-upstream/admin/upstreams',
        permission: 'zjmf-upstream.admin',
        successFeedback: { messageKey: 'feedback.created' },
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 191 },
          { name: 'baseUrl', type: 'string', required: true, maxLength: 191 },
          { name: 'downstreamUrl', type: 'string', maxLength: 191 },
          { name: 'protocol', type: 'string', required: true, maxLength: 8 },
          { name: 'username', type: 'string', required: true, maxLength: 191 },
          { name: 'password', type: 'string', required: true, maxLength: 191 },
          { name: 'currency', type: 'string', required: true, maxLength: 8 },
          {
            name: 'markupBps',
            type: 'integer',
            required: true,
            min: 0,
            max: 100000,
          },
          {
            name: 'defaultStock',
            type: 'integer',
            required: true,
            min: 1,
            max: 1000000,
          },
          {
            name: 'syncIntervalMinutes',
            type: 'integer',
            required: true,
            min: 15,
            max: 1440,
          },
        ],
      },
      {
        id: 'zjmf-upstream.sync',
        method: 'POST',
        path: '/zjmf-upstream/admin/upstreams/sync',
        permission: 'zjmf-upstream.admin',
        successFeedback: {
          messageKey: 'action.syncSuccess',
          message: '同步完成：已更新 {updated} 个商品，跳过 {skipped} 个。',
          params: {
            updated: 'updated',
            skipped: 'skipped',
          },
        },
        input: [{ name: 'sourceId', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'zjmf-upstream.update',
        method: 'PATCH',
        path: '/zjmf-upstream/admin/upstreams/:id',
        permission: 'zjmf-upstream.admin',
        successFeedback: { messageKey: 'feedback.updated' },
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', required: true, maxLength: 191 },
          { name: 'baseUrl', type: 'string', required: true, maxLength: 191 },
          { name: 'downstreamUrl', type: 'string', maxLength: 191 },
          { name: 'protocol', type: 'string', required: true, maxLength: 8 },
          { name: 'username', type: 'string', maxLength: 191 },
          { name: 'password', type: 'string', maxLength: 191 },
          { name: 'currency', type: 'string', required: true, maxLength: 8 },
          { name: 'markupBps', type: 'integer', required: true, min: 0, max: 100000 },
          { name: 'defaultStock', type: 'integer', required: true, min: 1, max: 1000000 },
          { name: 'syncIntervalMinutes', type: 'integer', required: true, min: 15, max: 1440 },
          { name: 'allowUnverifiedV10Routes', type: 'boolean', required: true },
          { name: 'v10Module', type: 'string', required: true, maxLength: 32 },
        ],
      },
      {
        id: 'zjmf-upstream.delete',
        method: 'DELETE',
        path: '/zjmf-upstream/admin/upstreams/:id',
        permission: 'zjmf-upstream.admin',
        successFeedback: { messageKey: 'feedback.deleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: '/instances',
        component: 'admin/instances',
        permission: 'zjmf-upstream.admin',
        nav: { labelKey: 'nav.instances', groupKey: 'nav.group', order: 20 },
        data: [{ fetch: { path: '/zjmf-upstream/admin/instances' }, as: 'inventory' }],
      },
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'zjmf-upstream.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        data: [{ fetch: { path: '/zjmf-upstream/admin/upstreams' }, as: 'upstreams' }],
      },
      {
        path: '/connections',
        component: 'admin/overview',
        permission: 'zjmf-upstream.admin',
        nav: { labelKey: 'nav.connections', groupKey: 'nav.group', order: 10 },
        data: [{ fetch: { path: '/zjmf-upstream/admin/upstreams' }, as: 'upstreams' }],
      },
    ],
  },
};

export default frontend;
