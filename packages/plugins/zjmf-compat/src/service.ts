import { z } from 'zod';
import type { PluginContext } from '@stackpanel/sdk';
import { EXTENSION_POINTS, PluginError } from '@stackpanel/sdk';
import type { ExtensionInstance } from '@stackpanel/sdk';
import type { CommerceOperations } from '@stackpanel/sdk';
import { commerceClient, type SpV1Client } from './bridge.js';
import { issueToken, hashCredential, verifyCredential } from './credential.js';
import { zjmfConnectionModel, type ConnectionData } from './data.js';
import {
  collectSelections,
  envelope,
  errorEnvelope,
  field,
  intField,
  minorToMajor,
  provisionAction,
  toZjmfHost,
  toZjmfProduct,
  type FormBody,
} from './protocol.js';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const CART_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'zjmf-compat:token:';
const CART_PREFIX = 'zjmf-compat:cart:';

/**
 * Native login throttling (audit M-3). The legacy `/zjmf_api_login` endpoint
 * bypassed the kernel login plugin's limiter, leaving connection credentials
 * open to brute force. Counters live in shared state so every replica enforces
 * the same window, and repeated failures lock the account briefly.
 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_USER = 10;
const LOGIN_MAX_PER_IP = 30;
const LOGIN_FAIL_LIMIT = 8;
const LOGIN_LOCK_MS = 10 * 60_000;
const LOGIN_WINDOW_PREFIX = 'zjmf-compat:login:win:';
const LOGIN_FAIL_PREFIX = 'zjmf-compat:login:fail:';
const LOGIN_LOCK_PREFIX = 'zjmf-compat:login:lock:';

interface CartItem {
  productId: string;
  quantity: number;
  selections: Record<string, string>;
}

/**
 * ZJMF-compat protocol service: authenticates legacy clients against
 * plugin-owned connection credentials, then translates each wire call into the
 * platform's `commerce` operations through the narrow {@link SpV1Client} port.
 * It holds a per-token server-side cart in shared state so the legacy
 * add-to-cart / settle flow maps onto a single platform order.
 */
export class ZjmfCompatService {
  constructor(private readonly ctx: PluginContext) {}

  /* ------------------------------- auth ---------------------------------- */

  /** Fixed-window admission check for a login attempt (per user and per IP). */
  private async allowLogin(username: string, clientIp: string | undefined): Promise<boolean> {
    const userCount = await this.ctx.state.incr(
      `${LOGIN_WINDOW_PREFIX}u:${username}`,
      LOGIN_WINDOW_MS,
    );
    if (userCount > LOGIN_MAX_PER_USER) return false;
    if (clientIp) {
      const ipCount = await this.ctx.state.incr(
        `${LOGIN_WINDOW_PREFIX}ip:${clientIp}`,
        LOGIN_WINDOW_MS,
      );
      if (ipCount > LOGIN_MAX_PER_IP) return false;
    }
    return true;
  }

  /** Record a failed attempt and lock the account once the threshold is hit. */
  private async recordLoginFailure(username: string): Promise<void> {
    const failures = await this.ctx.state.incr(`${LOGIN_FAIL_PREFIX}${username}`, LOGIN_LOCK_MS);
    if (failures >= LOGIN_FAIL_LIMIT) {
      await this.ctx.state.set(`${LOGIN_LOCK_PREFIX}${username}`, '1', LOGIN_LOCK_MS);
    }
  }

  async login(form: FormBody, clientIp?: string): Promise<string> {
    const username = field(form, 'username');
    const password = field(form, 'password');
    if (!username || !password) return errorEnvelope(401, '用户名或密码不能为空');

    if (await this.ctx.state.get(`${LOGIN_LOCK_PREFIX}${username}`)) {
      return errorEnvelope(429, '尝试太频繁，请稍后再试');
    }
    if (!(await this.allowLogin(username, clientIp))) {
      return errorEnvelope(429, '尝试太频繁，请稍后再试');
    }

    const rows = await this.ctx.extensions.list<ConnectionData>(zjmfConnectionModel, {
      where: { username: { eq: username } },
      page: 1,
      pageSize: 1,
    });
    const connection = rows.items[0];
    if (
      !connection ||
      !connection.spec.enabled ||
      !verifyCredential(password, connection.spec.passwordHash, connection.spec.passwordSalt)
    ) {
      await this.recordLoginFailure(username);
      return errorEnvelope(401, '用户名或密码错误');
    }

    const anchor = await this.ctx.auth.getUser(connection.spec.userId);
    if (!anchor || anchor.status !== 'ACTIVE') {
      await this.recordLoginFailure(username);
      return errorEnvelope(401, '绑定的平台用户不可用');
    }

    await this.ctx.state.del(`${LOGIN_FAIL_PREFIX}${username}`);
    const token = issueToken();
    await this.ctx.state.set(
      `${TOKEN_PREFIX}${token}`,
      JSON.stringify({ connectionId: connection.name, username }),
      TOKEN_TTL_MS,
    );
    return envelope(200, { jwt: token });
  }

  private async resolveClient(token: string | undefined): Promise<SpV1Client | null> {
    if (!token) return null;
    const raw = await this.ctx.state.get(`${TOKEN_PREFIX}${token}`);
    if (!raw) return null;
    let session: { connectionId?: string };
    try {
      session = JSON.parse(raw) as { connectionId?: string };
    } catch {
      return null;
    }
    if (!session.connectionId) return null;
    const connection = await this.ctx.extensions
      .get<ConnectionData>(zjmfConnectionModel, session.connectionId)
      .catch(() => null);
    if (!connection || !connection.spec.enabled) return null;
    const ops = this.ctx.getExtensions<CommerceOperations>(EXTENSION_POINTS.commerce)[0];
    if (!ops) return null;
    return commerceClient(ops, connection.spec.userId, connection.spec.productIds);
  }

  /* ------------------------------ catalog -------------------------------- */

  async listProducts(token: string | undefined): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const { items, currency } = await client.listProducts();
    return envelope(200, {
      data: { list: items.map(toZjmfProduct), currency_code: currency ?? 'CNY' },
    });
  }

  async getProduct(token: string | undefined, id: string): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const product = await client.getProduct(id);
    if (!product) return errorEnvelope(404, '商品不存在');
    return envelope(200, { data: { product: toZjmfProduct(product) } });
  }

  /** Single-price platform products expose one monthly cycle and no options. */
  async getConfig(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const productId = field(form, 'pid');
    if (!productId) return errorEnvelope(400, '缺少商品 ID');
    const product = await client.getProduct(productId);
    if (!product) return errorEnvelope(404, '商品不存在');
    return envelope(200, {
      data: {
        product: {
          cycle: [
            {
              billingcycle: 'monthly',
              billingcycle_zh: '月付',
              product_price: minorToMajor(product.price, product.currency),
            },
          ],
        },
        option: [],
      },
    });
  }

  async getTotal(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const productId = field(form, 'pid');
    if (!productId) return errorEnvelope(400, '缺少商品 ID');
    const product = await client.getProduct(productId);
    if (!product) return errorEnvelope(404, '商品不存在');
    const quantity = intField(form, 'qty');
    const total = minorToMajor(product.price * quantity, product.currency);
    return envelope(200, {
      products: { sale_total: total, total, currency_code: product.currency, child: [] },
    });
  }

  /* -------------------------------- cart --------------------------------- */

  async addToCart(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client || !token) return errorEnvelope(401, '未登录或登录已过期');
    const productId = field(form, 'pid');
    if (!productId) return errorEnvelope(400, '缺少商品 ID');
    const product = await client.getProduct(productId);
    if (!product) return errorEnvelope(404, '商品不存在');

    const cart = await this.readCart(token);
    cart.push({
      productId,
      quantity: intField(form, 'qty'),
      selections: collectSelections(form),
    });
    await this.writeCart(token, cart);
    return envelope(200, { msg: '已加入购物车', cart_count: cart.length });
  }

  async clearCart(token: string | undefined): Promise<string> {
    if (token) await this.ctx.state.del(`${CART_PREFIX}${token}`);
    return envelope(200, { msg: '购物车已清空' });
  }

  async settle(token: string | undefined): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client || !token) return errorEnvelope(401, '未登录或登录已过期');
    const cart = await this.readCart(token);
    if (cart.length === 0) return errorEnvelope(400, '购物车为空');

    const before = new Set((await client.listServices()).map((service) => service.id));
    const orders: string[] = [];
    for (const item of cart) {
      const order = await client.createOrder({ productId: item.productId, quantity: item.quantity });
      orders.push(order.id);
    }
    await this.ctx.state.del(`${CART_PREFIX}${token}`);

    // Fulfillment may be synchronous; surface any service created by the order.
    const created = (await client.listServices())
      .filter((service) => !before.has(service.id))
      .map((service) => service.id);
    const hostIds = created.length > 0 ? created : orders;
    return envelope(200, {
      data: { hostid: hostIds, invoiceid: orders[0] ?? null, order_ids: orders },
    });
  }

  /* -------------------------------- host --------------------------------- */

  async listHosts(token: string | undefined): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const services = await client.listServices();
    return envelope(200, { data: { list: services.map(toZjmfHost) } });
  }

  async hostHeader(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const id = field(form, 'host_id');
    if (!id) return errorEnvelope(400, '缺少 host_id');
    const service = await client.getService(id);
    if (!service) return errorEnvelope(404, '服务不存在');
    return envelope(200, { data: { host_data: toZjmfHost(service) } });
  }

  async hostMonitor(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const id = field(form, 'host_id');
    if (!id) return errorEnvelope(400, '缺少 host_id');
    const service = await client.getService(id);
    if (!service) return errorEnvelope(404, '服务不存在');
    // The platform does not expose per-host metrics through the commerce outlet.
    return envelope(200, { data: { host_id: service.id, list: [] } });
  }

  async provision(token: string | undefined, form: FormBody): Promise<string> {
    const client = await this.resolveClient(token);
    if (!client) return errorEnvelope(401, '未登录或登录已过期');
    const id = field(form, 'id');
    const func = field(form, 'func') ?? '';
    if (!id) return errorEnvelope(400, '缺少服务 ID');
    const action = provisionAction(func);
    if (!action) return errorEnvelope(400, `不支持的操作：${func}`);
    const service = await client.lifecycle(id, action);
    if (!service) return errorEnvelope(404, '服务不存在');
    return envelope(200, { msg: '操作已受理', data: toZjmfHost(service) });
  }

  /* ------------------------------- admin --------------------------------- */

  async listConnections(): Promise<Record<string, unknown>[]> {
    const rows = await this.ctx.extensions.listAll<ConnectionData>(zjmfConnectionModel);
    return rows.map(redactConnection);
  }

  async createConnection(input: unknown): Promise<Record<string, unknown>> {
    const parsed = connectionInputSchema.safeParse(input);
    if (!parsed.success) throw new PluginError('zjmf-compat.invalid_input', 400, '连接参数无效');
    const data = parsed.data;
    const existing = await this.ctx.extensions.list<ConnectionData>(zjmfConnectionModel, {
      where: { username: { eq: data.username } },
      page: 1,
      pageSize: 1,
    });
    if (existing.items.length > 0) {
      throw new PluginError('zjmf-compat.username_taken', 409, '用户名已存在');
    }
    await this.assertAnchor(data.userId);
    const credential = hashCredential(data.password);
    const spec: ConnectionData = {
      name: data.name,
      username: data.username,
      passwordHash: credential.hash,
      passwordSalt: credential.salt,
      userId: data.userId,
      enabled: data.enabled,
      productIds: data.productIds,
    };
    const created = await this.ctx.extensions.create<ConnectionData>(zjmfConnectionModel, spec);
    return redactConnection(created);
  }

  async updateConnection(id: string, patch: unknown): Promise<Record<string, unknown>> {
    const parsed = connectionPatchSchema.safeParse(patch);
    if (!parsed.success) throw new PluginError('zjmf-compat.invalid_input', 400, '连接参数无效');
    const current = await this.ctx.extensions.get<ConnectionData>(zjmfConnectionModel, id);
    if (!current) throw new PluginError('zjmf-compat.not_found', 404, '连接不存在');
    const change = parsed.data;
    if (change.userId) await this.assertAnchor(change.userId);
    const spec: ConnectionData = {
      ...current.spec,
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(change.userId !== undefined ? { userId: change.userId } : {}),
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.productIds !== undefined ? { productIds: change.productIds } : {}),
      ...(change.password ? hashCredential(change.password) : {}),
    };
    const updated = await this.ctx.extensions.update<ConnectionData>(
      zjmfConnectionModel,
      id,
      spec,
    );
    return redactConnection(updated);
  }

  async deleteConnection(id: string): Promise<void> {
    await this.ctx.extensions.delete(zjmfConnectionModel, id).catch(() => undefined);
  }

  private async assertAnchor(userId: string): Promise<void> {
    const user = await this.ctx.auth.getUser(userId);
    if (!user) throw new PluginError('zjmf-compat.anchor_missing', 422, '绑定的平台用户不存在');
  }

  /* -------------------------------- cart I/O ----------------------------- */

  private async readCart(token: string): Promise<CartItem[]> {
    const raw = await this.ctx.state.get(`${CART_PREFIX}${token}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { items?: CartItem[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  private async writeCart(token: string, items: CartItem[]): Promise<void> {
    await this.ctx.state.set(`${CART_PREFIX}${token}`, JSON.stringify({ items }), CART_TTL_MS);
  }
}

function redactConnection(row: ExtensionInstance<ConnectionData>): Record<string, unknown> {
  const { passwordHash, passwordSalt, ...safe } = row.spec;
  void passwordHash;
  void passwordSalt;
  return { id: row.name, ...safe, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/* -------------------------------- schemas -------------------------------- */

const connectionInputSchema = z.object({
  name: z.string().min(1).max(100),
  username: z.string().min(1).max(100),
  password: z.string().min(6).max(200),
  userId: z.string().min(1).max(191),
  enabled: z.boolean().default(true),
  productIds: z.array(z.string()).default([]),
});

const connectionPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(6).max(200).optional(),
  userId: z.string().min(1).max(191).optional(),
  enabled: z.boolean().optional(),
  productIds: z.array(z.string()).optional(),
});
