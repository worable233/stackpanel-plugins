import { definePlugin } from '@stackpanel/sdk';

let activationsSeen = 0;

/**
 * Example plugin demonstrating the plugin SDK:
 * - lifecycle hooks (onRegister/onActivate/onDeactivate)
 * - a declarative route extension (GET /hello)
 * - an event listener (counts plugin.activated broadcasts)
 */
export const helloPlugin = definePlugin({
  manifest: {
    id: 'hello',
    name: 'Hello 插件',
    version: '0.1.0',
    description: '示例插件：演示生命周期、路由扩展与事件监听。',
  },
  routes: [
    {
      method: 'GET',
      path: '/hello',
      handler: async () => ({ message: 'Hello from the hello plugin!', activationsSeen }),
    },
  ],
  eventListeners: [
    {
      topic: 'plugin.activated',
      handler: () => {
        activationsSeen += 1;
      },
    },
  ],
  onRegister: (ctx) => ctx.logger.info('hello: registered'),
  onActivate: (ctx) => ctx.logger.info('hello: activated'),
  onDeactivate: (ctx) => ctx.logger.info('hello: deactivated'),
});

export default helloPlugin;
