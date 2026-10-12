import { definePlugin } from '@stackpanel/sdk';
import type { HttpReply, HttpRequest } from '@stackpanel/sdk';

async function minimalInfo(_request: HttpRequest, _reply: HttpReply): Promise<unknown> {
  return {
    plugin: 'minimal',
    status: 'ok',
    message: 'Minimal plugin is live.',
  };
}

export default definePlugin({
  manifest: {
    id: 'minimal',
    name: '最小示例',
    version: '1.0.0',
    description: '最简单的 StackPanel 插件示例。',
  },
  routes: [{ method: 'GET', path: '/minimal', handler: minimalInfo }],
  onActivate: (ctx) => ctx.logger.info('minimal: activated'),
});
