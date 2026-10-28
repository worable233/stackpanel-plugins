import { definePlugin } from '@stackpanel/sdk';
import type { PluginContext } from '@stackpanel/sdk';

/**
 * API 市场插件入口。
 *
 * 阶段 0 只落骨架：确认 manifest / 路由 / 前端产物能被内核装载并让 `/ready`
 * 通过。模型、仓库层、网关与计费在阶段 1–5 逐层补齐。
 */
let ctx: PluginContext | undefined;

export default definePlugin({
  manifest: {
    id: 'api-market',
    name: 'API 市场',
    version: '0.1.0',
    description: '管理员录入第三方 REST 接口，用户自助签发 key，网关按模板转发并按次扣额度。',
    permissions: [
      { key: 'api-market.use', scope: 'api-market' },
      { key: 'api-market.admin', scope: 'api-market' },
    ],
    roleTemplates: [
      { role: 'USER', permissions: ['api-market.use'] },
      { role: 'ADMIN', permissions: ['api-market.admin'] },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/api-market/health',
      auth: 'public',
      handler: async () => ({ ok: true, plugin: 'api-market' }),
    },
  ],
  onActivate(pluginCtx) {
    ctx = pluginCtx;
    ctx.logger.info('api-market: activated');
  },
});
