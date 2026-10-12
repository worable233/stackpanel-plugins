import type { FinderContext, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';

const statusSchema = z.object({
  configured: z.boolean(),
  secretsEnabled: z.boolean(),
  baseUrl: z.string().optional(),
  pid: z.string().optional(),
  methods: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
});

const finders = {
  'epay.status': {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get('/epay/admin/config', statusSchema),
  },
};

export const frontend: FrontendPackage = {
  finders,
  ui: {
    actions: [
      {
        id: 'epay.configure',
        method: 'POST',
        path: '/epay/admin/config',
        permission: 'epay.admin',
        input: [
          { name: 'baseUrl', type: 'string', required: true, maxLength: 191 },
          { name: 'pid', type: 'string', required: true, maxLength: 64 },
          { name: 'privateKey', type: 'string', required: true, maxLength: 20000 },
          { name: 'platformPublicKey', type: 'string', required: true, maxLength: 20000 },
          { name: 'methods', type: 'string', required: true, maxLength: 64 },
        ],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/overview',
        permission: 'epay.admin',
        nav: { label: '易支付', group: '商店插件' },
        data: [{ finder: 'epay.status', as: 'status' }],
      },
    ],
  },
};

export default frontend;
