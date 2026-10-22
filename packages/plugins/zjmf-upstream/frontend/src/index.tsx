import type { FinderContext, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';
import { messages } from './i18n.js';

const upstreamListSchema = z.object({
  secretsEnabled: z.boolean(),
  upstreams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      downstreamUrl: z.string().optional(),
      protocol: z.enum(['finance', 'v10']),
      currency: z.string(),
      markupBps: z.number(),
      defaultStock: z.number(),
      syncIntervalMinutes: z.number(),
      enabled: z.boolean(),
      allowUnverifiedV10Routes: z.boolean().optional(),
      v10Module: z
        .enum(['auto', 'mf_cloud', 'remf_cloud', 'mf_dcim', 'idcsmart_common'])
        .optional(),
      lastSyncedAt: z.string().nullable(),
      productCount: z.number(),
      credentialsConfigured: z.boolean(),
    }),
  ),
});

const finders = {
  'zjmf-upstream.instances': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get(
        '/zjmf-upstream/admin/instances',
        z.object({
          errors: z.array(z.object({ sourceName: z.string(), message: z.string() })),
          instances: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              productName: z.string().nullish(),
              productId: z.string().nullish(),
              sourceRef: z.string().nullish(),
              sourceName: z.string(),
              status: z.string().nullish(),
              statusLabel: z.string().nullish(),
              host: z.string().nullish(),
              expiresAt: z.string().nullish(),
              openedAt: z.string().nullish(),
              products: z.array(z.object({ id: z.string(), name: z.string() })),
              boundUserId: z.string().nullable(),
              boundServiceId: z.string().nullable(),
              bindingKnown: z.boolean(),
            }),
          ),
          accounts: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
        }),
      ),
  },
  'zjmf-upstream.upstreams': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get('/zjmf-upstream/admin/upstreams', upstreamListSchema),
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  finders,
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
        data: [{ finder: 'zjmf-upstream.instances', as: 'inventory' }],
      },
      {
        path: '/overview',
        component: 'admin/summary',
        permission: 'zjmf-upstream.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        data: [{ finder: 'zjmf-upstream.upstreams', as: 'upstreams' }],
      },
      {
        path: '/connections',
        component: 'admin/overview',
        permission: 'zjmf-upstream.admin',
        nav: { labelKey: 'nav.connections', groupKey: 'nav.group', order: 10 },
        data: [{ finder: 'zjmf-upstream.upstreams', as: 'upstreams' }],
      },
    ],
  },
};

export default frontend;
