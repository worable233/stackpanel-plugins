import { definePlugin } from '@stackpanel/sdk';
import type { HttpReply, HttpRequest } from '@stackpanel/sdk';

async function greeting(req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  const name = req.query['name'];
  return {
    message: `Hello${typeof name === 'string' && name.length > 0 ? `, ${name}` : ''}`,
  };
}

/**
 * Plugin scaffold. The manifest id (a-z0-9_-) must match the folder name and
 * must not collide with built-in ids (hello/store/ticket/wowid) or the
 * reserved ids kernel/default.
 */
export const myPlugin = definePlugin({
  manifest: {
    id: 'myname',
    name: '我的插件',
    version: '0.1.0',
    description: '基于模板创建的 StackPanel 插件。',
  },
  routes: [{ method: 'GET', path: '/myname', handler: greeting }],
  onActivate: (ctx) => ctx.logger.info('myname: activated'),
  onDeactivate: (ctx) => ctx.logger.info('myname: deactivated'),
});

export default myPlugin;
