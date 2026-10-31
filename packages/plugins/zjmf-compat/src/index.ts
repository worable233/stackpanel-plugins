import type {
  HttpRequest,
  PluginContext,
  RawHttpReply,
  RawHttpRequest,
  RawRouteHandler,
} from '@stackpanel/sdk';
import { definePlugin } from '@stackpanel/sdk';
import { zjmfConnectionModel } from './data.js';
import { parseForm, type FormBody } from './protocol.js';
import { ZjmfCompatService } from './service.js';

let service: ZjmfCompatService | null = null;

function current(): ZjmfCompatService {
  if (!service) throw new Error('zjmf-compat: 插件未激活');
  return service;
}

function bearer(request: RawHttpRequest): string | undefined {
  const header = request.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || undefined;
}

async function readBody(request: RawHttpRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(reply: RawHttpReply, body: string): void {
  reply.status(200);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(body);
}

/**
 * Wrap a protocol handler: decode the form-urlencoded body once, run the
 * translation and always answer HTTP 200 with the ZJMF `{status,msg,data}`
 * envelope (the wire contract legacy clients switch on).
 */
function rawRoute(
  handler: (request: RawHttpRequest, form: FormBody) => Promise<string>,
): RawRouteHandler {
  return async (request, reply) => {
    try {
      const form = parseForm(await readBody(request));
      // GET protocol calls carry `host_id` / `pid` in the query string; the form
      // body wins on collision (POST calls never repeat them in the query).
      for (const [key, value] of request.query) {
        if (form[key] === undefined) form[key] = value;
      }
      send(reply, await handler(request, form));
    } catch (error) {
      const message = error instanceof Error ? error.message : '内部错误';
      send(reply, JSON.stringify({ status: 500, msg: message }));
    }
  };
}

export const zjmfCompatPlugin = definePlugin({
  manifest: {
    id: 'zjmf-compat',
    name: '魔方兼容',
    version: '0.1.0',
    description: 'ZJMF 协议兼容层：把智简魔方客户端请求翻译为平台商业域操作。',
    requires: [{ id: 'store', range: '^0.3.0' }],
    consumes: [{ pluginId: 'store', extensionPoint: 'commerce.operations', optional: false }],
    permissions: ['zjmf-compat.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['zjmf-compat.admin'] }],
    // Open-platform surface: every entry mirrors one internal route below and
    // dispatches to the *same* handler, so the alias never widens auth.
    capabilities: [
      {
        id: 'zjmfCompat.admin.connections.list',
        method: 'GET',
        route: '/zjmf-compat/admin/connections',
        path: '/api/v1/zjmf-compat/admin/connections',
        summary: 'List legacy connection bindings',
        scope: 'zjmf-compat.admin',
      },
      {
        id: 'zjmfCompat.admin.connections.create',
        method: 'POST',
        route: '/zjmf-compat/admin/connections',
        path: '/api/v1/zjmf-compat/admin/connections',
        summary: 'Create a legacy connection binding',
        scope: 'zjmf-compat.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'zjmfCompat.admin.connections.update',
        method: 'PATCH',
        route: '/zjmf-compat/admin/connections/:id',
        path: '/api/v1/zjmf-compat/admin/connections/:id',
        summary: 'Update a legacy connection binding; params: {id}',
        scope: 'zjmf-compat.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'zjmfCompat.admin.connections.delete',
        method: 'DELETE',
        route: '/zjmf-compat/admin/connections/:id',
        path: '/api/v1/zjmf-compat/admin/connections/:id',
        summary: 'Delete a legacy connection binding; params: {id}',
        scope: 'zjmf-compat.admin',
        mutating: true,
        destructive: true,
      },
    ],
  },

  customModels: [zjmfConnectionModel],

  routes: [
    /* ------------------------------- 协议面 ------------------------------- */
    {
      kind: 'raw',
      method: 'POST',
      path: '/zjmf_api_login',
      handler: rawRoute((request, form) => current().login(form, request.ip)),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/api/product/list',
      handler: rawRoute((request) => current().listProducts(bearer(request))),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/api/v1/product',
      handler: rawRoute((request) => current().listProducts(bearer(request))),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/api/product/:id',
      handler: rawRoute((request) =>
        current().getProduct(bearer(request), request.params['id'] ?? ''),
      ),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/api/v1/product/:id',
      handler: rawRoute((request) =>
        current().getProduct(bearer(request), request.params['id'] ?? ''),
      ),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/cart/set_config',
      handler: rawRoute((request, form) => current().getConfig(bearer(request), form)),
    },
    {
      kind: 'raw',
      method: 'POST',
      path: '/cart/get_total',
      handler: rawRoute((request, form) => current().getTotal(bearer(request), form)),
    },
    {
      kind: 'raw',
      method: 'POST',
      path: '/cart/add_to_shop',
      handler: rawRoute((request, form) => current().addToCart(bearer(request), form)),
    },
    {
      kind: 'raw',
      method: 'POST',
      path: '/cart/settle',
      handler: rawRoute((request) => current().settle(bearer(request))),
    },
    {
      kind: 'raw',
      method: 'POST',
      path: '/cart/clear',
      handler: rawRoute((request) => current().clearCart(bearer(request))),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/host/list',
      handler: rawRoute((request) => current().listHosts(bearer(request))),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/host/header',
      handler: rawRoute((request, form) => current().hostHeader(bearer(request), form)),
    },
    {
      kind: 'raw',
      method: 'GET',
      path: '/host/monitor',
      handler: rawRoute((request, form) => current().hostMonitor(bearer(request), form)),
    },
    {
      kind: 'raw',
      method: 'POST',
      path: '/provision/default',
      handler: rawRoute((request, form) => current().provision(bearer(request), form)),
    },

    /* ------------------------------- 管理面 ------------------------------- */
    {
      method: 'GET',
      path: '/zjmf-compat/admin/connections',
      auth: 'admin',
      permission: 'zjmf-compat.admin',
      handler: () => current().listConnections(),
    },
    {
      method: 'POST',
      path: '/zjmf-compat/admin/connections',
      auth: 'admin',
      permission: 'zjmf-compat.admin',
      handler: (request: HttpRequest) => current().createConnection(request.body),
    },
    {
      method: 'PATCH',
      path: '/zjmf-compat/admin/connections/:id',
      auth: 'admin',
      permission: 'zjmf-compat.admin',
      handler: (request: HttpRequest) =>
        current().updateConnection(request.params['id'] ?? '', request.body),
    },
    {
      method: 'DELETE',
      path: '/zjmf-compat/admin/connections/:id',
      auth: 'admin',
      permission: 'zjmf-compat.admin',
      handler: async (request: HttpRequest) => {
        await current().deleteConnection(request.params['id'] ?? '');
        return { deleted: true };
      },
    },
  ],

  onActivate: (ctx: PluginContext) => {
    service = new ZjmfCompatService(ctx);
    ctx.logger.info('zjmf-compat: activated');
  },

  onDeactivate: (ctx: PluginContext) => {
    service = null;
    ctx.logger.info('zjmf-compat: deactivated');
  },
});

export default zjmfCompatPlugin;
