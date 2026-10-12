import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isUnsafeHostname, isUnsafeIpAddress } from '@stackpanel/net-guard';
import { z } from 'zod';

export { isUnsafeIpAddress };

export type ZJMFProtocol = 'finance' | 'v10';

export interface ZJMFConnection {
  id: string;
  baseUrl: string;
  protocol: ZJMFProtocol;
  username: string;
  password: string;
}

export interface ZJMFProduct {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string | null;
  raw: Record<string, unknown>;
}

/** 上游已购服务（主机）条目（来自 /host/list 或 /api/v1/service）。 */
export interface ZJMFHost {
  id: string;
  name: string;
  productName: string | null;
  status: string | null;
  statusLabel: string | null;
  host: string | null;
  expiresAt: string | null;
  amount: number | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

/** 上游商品的可配置项（来自 /cart/set_config，pricing 可能为空，计价走 get_total）。 */
export interface ZJMFConfigOption {
  id: string;
  label: string;
  type: 'select' | 'quantity';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  choices: Array<{
    id: string;
    label: string;
    price?: number;
    qtyMin?: number;
    qtyMax?: number;
  }>;
}

/** 上游商品结账配置：周期 + 配置项。 */
export interface ZJMFProductConfig {
  cycles: Array<{ id: string; label: string; price: number; renewPrice?: number }>;
  options: ZJMFConfigOption[];
}

/** Stable codes for ZJMF client errors (ADR-0012). */
const ZJMF_CLIENT_ERROR_CODES: Record<string, string> = {
  '上游商品数据无效': 'zjmf.client.product_data_invalid',
  '上游未返回服务 ID': 'zjmf.client.service_id_missing',
  '上游结算未返回服务 ID': 'zjmf.client.settlement_service_id_missing',
  '清空购物车超时': 'zjmf.client.cart_clear_timeout',
  '上游请求失败': 'zjmf.client.request_failed',
  '上游凭证被拒绝': 'zjmf.client.credentials_rejected',
  '上游登录响应缺少 JWT': 'zjmf.client.jwt_missing',
  '上游 URL 无效': 'zjmf.client.url_invalid',
  '上游 URL 必须为公网地址': 'zjmf.client.url_not_public',
  '上游 URL 必须解析到公网地址': 'zjmf.client.url_not_public',
  '无法连接上游': 'zjmf.client.unreachable',
  '上游返回了无效的 JSON': 'zjmf.client.invalid_json',
  '上游响应无效': 'zjmf.client.invalid_response',
  '上游商品价格无效': 'zjmf.client.price_invalid',
  '上游商品价格超出范围': 'zjmf.client.price_out_of_range',
  '无法解析上游主机': 'zjmf.client.host_unresolved',
};

/** Resolve a stable code from a ZJMF client error message (exact, then prefix). */
function zjmfClientErrorCode(message: string): string {
  const exact = ZJMF_CLIENT_ERROR_CODES[message];
  if (exact) return exact;
  if (message.startsWith('上游返回 HTTP ')) return 'zjmf.client.http_error';
  return 'zjmf.client.error';
}

export class ZJMFClientError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;
  /** Alias so Fastify's error handler maps the error to an HTTP status. */
  readonly statusCode: number;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ZJMFClientError';
    this.statusCode = status;
    this.code = zjmfClientErrorCode(message);
  }
}

type Fetch = typeof fetch;

const upstreamResponseSchema = z
  .object({
    status: z.coerce.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    jwt: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

/**
 * Protocol client independently derived from the public V1/V10 route shapes.
 * It deliberately uses form-urlencoding because the reference implementation's
 * transport posts `http_build_query` data, not JSON.
 */
export class ZJMFClient {
  private token: string | null = null;

  constructor(
    private readonly connection: ZJMFConnection,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async listProducts(): Promise<{ products: ZJMFProduct[]; currency: string | null }> {
    const data = await this.authorizedGet(
      this.connection.protocol === 'finance' ? '/api/product/list' : '/api/v1/product',
    );
    const payload = object(data['data']);
    const list = Array.isArray(payload['list']) ? payload['list'] : [];
    return {
      products: list
        .map(normalizeProduct)
        .filter((product): product is ZJMFProduct => product !== null),
      currency: stringOrNull(payload['currency_code']),
    };
  }

  async getProduct(id: string): Promise<ZJMFProduct> {
    const encoded = encodeURIComponent(id);
    const data = await this.authorizedGet(
      this.connection.protocol === 'finance'
        ? `/api/product/${encoded}`
        : `/api/v1/product/${encoded}`,
    );
    const payload = object(data['data']);
    const product = normalizeProduct(payload['product']);
    if (!product) throw new ZJMFClientError(502, '上游商品数据无效');
    return product;
  }

  /**
   * 列出上游账号下已购买的服务（主机）。
   *
   * 财务协议走 `/host/list`；V10 走 `/api/v1/service`。管理端据此把已购主机
   * 绑定到平台账号。无法列出的协议/实例返回空数组（不阻断其它实例）。
   */
  async listHosts(limit = 200): Promise<ZJMFHost[]> {
    const path =
      this.connection.protocol === 'finance'
        ? `/host/list?limit=${encodeURIComponent(String(limit))}`
        : '/api/v1/service';
    const data = await this.authorizedGet(path);
    const payload = object(data['data']);
    const list = Array.isArray(payload['list']) ? payload['list'] : [];
    return list.map(normalizeHost).filter((host): host is ZJMFHost => host !== null);
  }

  /**
   * 拉取商品的可配置项 + 周期（老财务走前台 /cart/set_config，V10 无等价公开端点时返回空）。
   * 返回 null 表示该商品不可配置。
   */
  async getConfig(productId: string): Promise<ZJMFProductConfig | null> {
    if (this.connection.protocol !== 'finance') return null;
    const params = new URLSearchParams({ pid: productId, billingcycle: 'monthly' });
    const data = await this.authorizedGet(`/cart/set_config?${params.toString()}`);
    // set_config 响应是扁平的（product/option 在顶层），兼容可能的 data 包裹。
    const payload = object(data['data'] ?? data);
    const product = object(payload['product']);
    const cycleRows = Array.isArray(product['cycle']) ? product['cycle'] : [];
    const cycles = cycleRows
      .map((row) => {
        const o = object(row);
        const id = stringOrNull(o['billingcycle']);
        const label = stringOrNull(o['billingcycle_zh']);
        const price = decimalToMinor(stringOrNull(o['product_price']) ?? '0');
        if (!id) return null;
        return { id, label: label ?? id, price };
      })
      .filter((cycle): cycle is NonNullable<typeof cycle> => cycle !== null);
    const optionRows = Array.isArray(payload['option']) ? payload['option'] : [];
    const options = optionRows
      .map((row) => normalizeConfigOption(row))
      .filter((option): option is ZJMFConfigOption => option !== null);
    if (cycles.length === 0) return null;
    return { cycles, options };
  }

  /**
   * 按所选配置试算上游价格（老财务 /cart/get_total）。返回上游权威总价（minor units，
   * 未含我方 markup；上游侧客户等级折扣已含在内）。无法试算时返回 null。
   */
  async calculatePrice(
    productId: string,
    opts: { cycle?: string; selections?: Record<string, string | number>; quantity?: number } = {},
  ): Promise<{
    price: number;
    breakdown: Array<{ label: string; value: string; price?: number }>;
    summary: string;
  } | null> {
    if (this.connection.protocol !== 'finance') return null;
    const cycle = opts.cycle ?? 'monthly';
    const body: FormBody = {
      pid: productId,
      billingcycle: cycle,
      qty: String(opts.quantity ?? 1),
    };
    for (const [optionId, value] of Object.entries(opts.selections ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      body[`configoption[${optionId}]`] = String(value);
    }
    const data = await this.authorizedPost('/cart/get_total', body);
    const products = object(data['products']);
    const saleTotal = stringOrNull(products['sale_total']) ?? stringOrNull(products['total']);
    if (!saleTotal) return null;
    let price: number;
    try {
      price = decimalToMinor(saleTotal);
    } catch {
      return null;
    }
    const breakdown: Array<{ label: string; value: string; price?: number }> = [];
    const child = Array.isArray(products['child']) ? products['child'] : [];
    for (const row of child) {
      const o = object(row);
      const label = stringOrNull(o['option_name']);
      const value = stringOrNull(o['suboption_name']);
      if (!label || !value) continue;
      const subPrice = stringOrNull(o['suboption_price']);
      const minorPrice = safeMinor(subPrice);
      const entry: { label: string; value: string; price?: number } = {
        label,
        value: `${value}${o['qty'] ? ` ×${o['qty']}` : ''}`,
      };
      if (minorPrice !== undefined) entry.price = minorPrice;
      breakdown.push(entry);
    }
    return {
      price,
      breakdown,
      summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
    };
  }

  /**
   * 在上游开通一个服务实例（云服务器等）。
   *
   * 老财务（finance）没有 `/api/service` 开放端点，真实开通走前台购物车链路：
   *   /cart/clear → /cart/add_to_shop(带 configoption[]) → /cart/settle → /apply_credit(余额支付)。
   * V10 走 /api/v1/service。
   */
  async createService(
    productId: string,
    opts: {
      quantity?: number;
      reference?: string;
      cycle?: string;
      selections?: Record<string, string | number>;
    } = {},
  ): Promise<{
    providerServiceId: string;
    credentials: Record<string, string>;
    runtime: Record<string, unknown>;
  }> {
    if (this.connection.protocol === 'finance') {
      return this.createServiceFinance(productId, opts);
    }
    const body: FormBody = { product_id: String(productId) };
    if (opts.quantity && opts.quantity > 1) body['quantity'] = String(opts.quantity);
    if (opts.reference) body['ref'] = opts.reference;
    for (const [optionId, value] of Object.entries(opts.selections ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      body[`configoption[${optionId}]`] = String(value);
    }
    const path = '/api/v1/service';
    const data = await this.authorizedPost(path, body);
    const payload = object(data['data']);
    const providerServiceId =
      stringOrNull(payload['service_id']) ??
      stringOrNull(payload['id']) ??
      stringOrNull(payload['instance_id']) ??
      '';
    if (!providerServiceId) throw new ZJMFClientError(502, '上游未返回服务 ID');
    return {
      providerServiceId,
      credentials: extractCredentials(payload),
      runtime: {
        upstreamId: stringOrNull(payload['upstream_id']),
        host: stringOrNull(payload['ip']) ?? stringOrNull(payload['hostname']),
        ip: stringOrNull(payload['ip']),
        status: stringOrNull(payload['status']) ?? 'PROVISIONING',
        specs: pickSpecs(payload),
        raw: payload,
      },
    };
  }

  /** 清空购物车（尽力而为，15s 超时即放弃）。 */
  private async clearCartWithTimeout(): Promise<void> {
    try {
      await Promise.race([
        this.authorizedPost('/cart/clear', {}),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new ZJMFClientError(504, '清空购物车超时')), 15_000),
        ),
      ]);
    } catch {
      // 忽略：清空失败不阻塞下单。
    }
  }

  /** 老财务前台购物车链路开通：clear → add_to_shop → settle → apply_credit。 */
  private async createServiceFinance(
    productId: string,
    opts: { quantity?: number; cycle?: string; selections?: Record<string, string | number> },
  ): Promise<{
    providerServiceId: string;
    credentials: Record<string, string>;
    runtime: Record<string, unknown>;
  }> {
    const billingCycle = opts.cycle ?? 'monthly';
    // 清空购物车是幂等优化：上游偶发慢/挂起，短超时尽力而为，失败不阻塞下单。
    await this.clearCartWithTimeout();

    const addBody: FormBody = {
      pid: productId,
      billingcycle: billingCycle,
      qty: String(opts.quantity ?? 1),
      currencyid: '1',
      is_api: '1',
    };
    for (const [optionId, value] of Object.entries(opts.selections ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      addBody[`configoption[${optionId}]`] = String(value);
    }
    await this.authorizedPost('/cart/add_to_shop', addBody);

    const settle = await this.authorizedPost('/cart/settle', {});
    const settlePayload = object(settle['data']);
    const hostIds = settlePayload['hostid'];
    const invoiceId = stringOrNull(settlePayload['invoiceid']);
    const providerServiceId = Array.isArray(hostIds)
      ? stringOrNull(hostIds[0])
      : stringOrNull(hostIds);
    if (!providerServiceId) {
      throw new ZJMFClientError(502, '上游结算未返回服务 ID');
    }

    // 用上游余额支付发票（enough=1 视为足够；不足时回退按可用余额支付）。
    let paid = false;
    if (invoiceId) {
      try {
        const credit = await this.authorizedPost('/apply_credit', {
          invoiceid: invoiceId,
          use_credit: '1',
          enough: '1',
        });
        paid = credit['status'] === 1001 || credit['status'] === 200;
      } catch {
        paid = false;
      }
      if (!paid) {
        try {
          const partial = await this.authorizedPost('/apply_credit', {
            invoiceid: invoiceId,
            use_credit: '1',
            enough: '0',
          });
          paid = partial['status'] === 1001 || partial['status'] === 200;
        } catch {
          paid = false;
        }
      }
    }

    return {
      providerServiceId,
      credentials: {},
      runtime: {
        upstreamId: null,
        host: null,
        ip: null,
        status: paid ? 'PROVISIONING' : 'PENDING_INVOICE',
        invoiceId: invoiceId ?? null,
        paid,
        billingCycle,
        config: opts.selections ?? {},
        raw: { settle },
      },
    };
  }

  async getService(serviceId: string): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      const [header, summary] = await Promise.all([
        this.authorizedGet(`/host/header?host_id=${encoded}`),
        this.getHostSummary(serviceId),
      ]);
      const payload = object(header['data']);
      const host = object(payload['host_data']);
      // 魔方财务：domainstatus 才是运行状态；status 常为账单状态（如 Paid）。
      const status =
        stringOrNull(host['domainstatus']) ??
        stringOrNull(host['status']) ??
        stringOrNull(host['status_text']);
      const statusLabel =
        stringOrNull(host['domainstatus_desc']) ?? stringOrNull(host['status_text']);
      return pickServiceDetail({
        ...(summary ?? {}),
        ...host,
        ip: stringOrNull(host['dedicatedip']) ?? stringOrNull(host['ip']),
        ...(status ? { status } : {}),
        ...(statusLabel ? { statusLabel } : {}),
      });
    }
    const path = `/api/v1/service/${encoded}`;
    const data = await this.authorizedGet(path);
    const payload = object(data['data']);
    return pickServiceDetail(payload);
  }

  /**
   * 财务协议的 host/header 不含 CPU/内存/磁盘等规格，从 host/list 补齐。
   * host/list 不支持按 id 过滤，故按 id 精确匹配；失败时静默降级为无规格。
   */
  private async getHostSummary(serviceId: string): Promise<Record<string, unknown> | null> {
    try {
      const data = await this.authorizedGet('/host/list?limit=200');
      const list = object(data['data'])['list'];
      if (!Array.isArray(list)) return null;
      const item = list.map(object).find((entry) => String(entry['id']) === serviceId);
      if (!item) return null;
      const summary: Record<string, unknown> = {};
      const copy = (from: string, to: string): void => {
        const value = item[from];
        if (value !== undefined && value !== null && value !== '') summary[to] = value;
      };
      copy('cpu', 'cpu');
      copy('memory', 'memory');
      copy('system_disk_size', 'disk');
      copy('bw', 'bandwidth');
      const area = stringOrNull(item['area']) ?? stringOrNull(item['area_name']);
      if (area) {
        summary['region'] = area.includes('^') ? area.split('^').slice(1).join('^').trim() : area;
      }
      return summary;
    } catch {
      return null;
    }
  }

  async runServiceAction(serviceId: string, action: string): Promise<void> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      const func = SERVICE_ACTION_FUNC[action] ?? action;
      await this.authorizedPost('/provision/default', { id: encoded, func, is_api: '1' });
      return;
    }
    const path = `/api/v1/service/${encoded}/action`;
    await this.authorizedPost(path, { action });
  }

  async getServiceMetrics(serviceId: string): Promise<ZJMFMetric[]> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      try {
        const data = await this.authorizedGet(`/host/monitor?host_id=${encoded}`);
        const payload = object(data['data']);
        return normalizeMetrics(payload);
      } catch {
        return [];
      }
    }
    const path = `/api/v1/service/${encoded}/monitor`;
    const data = await this.authorizedGet(path);
    const payload = object(data['data']);
    return normalizeMetrics(payload);
  }

  private async authorizedGet(path: string): Promise<Record<string, unknown>> {
    return this.authorizedRequest(path, 'GET');
  }

  private async authorizedPost(path: string, body: FormBody): Promise<Record<string, unknown>> {
    return this.authorizedRequest(path, 'POST', true, body);
  }

  private async authorizedRequest(
    path: string,
    method: 'GET' | 'POST',
    retry = true,
    body?: FormBody,
  ): Promise<Record<string, unknown>> {
    const token = await this.authenticate();
    const response = await this.request(path, method, token, body);
    if (retry && (response.status === 401 || response.status === 405)) {
      this.token = null;
      return this.authorizedRequest(path, method, false, body);
    }
    // 老财务前台接口的成功状态既有 200 也有 1001（已支付/已结算）。
    if (response.status !== undefined && response.status !== 200 && response.status !== 1001) {
      throw new ZJMFClientError(502, response.message ?? '上游请求失败');
    }
    return response.data;
  }

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const loginPath = this.connection.protocol === 'finance' ? '/zjmf_api_login' : '/api/v1/auth';
    const response = await this.request(loginPath, 'POST', null, {
      username: this.connection.username,
      password: this.connection.password,
    });
    if (response.status !== undefined && response.status !== 200) {
      throw new ZJMFClientError(401, response.message ?? '上游凭证被拒绝');
    }
    const token =
      this.connection.protocol === 'finance'
        ? stringOrNull(response.data['jwt'])
        : stringOrNull(object(response.data['data'])['jwt']);
    if (!token) throw new ZJMFClientError(502, '上游登录响应缺少 JWT');
    this.token = token;
    return token;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    token: string | null,
    body?: FormBody,
  ): Promise<{
    status: number | undefined;
    message: string | undefined;
    data: Record<string, unknown>;
  }> {
    const url = new URL(path, normalizeBaseUrl(this.connection.baseUrl));
    // Re-validate DNS immediately before each real request so a hostname that
    // was public during configuration/sync start cannot be rebound to an
    // internal address at connection time (DNS rebinding SSRF mitigation).
    // Resolution failures are allowed to fall through to the transport so a
    // test double or transient DNS outage does not block a legitimate request;
    // only a host that resolves to a private address is rejected here.
    await assertNoPrivateResolution(this.connection.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { body: buildForm(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ZJMFClientError(502, '无法连接上游');
    }
    if (!response.ok) throw new ZJMFClientError(502, `上游返回 HTTP ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ZJMFClientError(502, '上游返回了无效的 JSON');
    }
    const parsed = upstreamResponseSchema.safeParse(json);
    if (!parsed.success) throw new ZJMFClientError(502, '上游响应无效');
    return {
      status: parsed.data.status,
      message: parsed.data.msg ?? parsed.data.message,
      data: parsed.data,
    };
  }
}

/** 表单字段值：标量或数组（数组以同名 key 多次追加，如 configoption[1]=a）。 */
export type FormBody = Record<string, string | string[]>;

/** 构建 x-www-form-urlencoded 请求体（数组键按上游约定转成 `key[i]=v`）。 */
function buildForm(body: FormBody): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, value);
    }
  }
  return params;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ZJMFClientError(400, '上游 URL 无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ZJMFClientError(400, '上游 URL 无效');
  }
  if (isUnsafeHostname(url.hostname)) throw new ZJMFClientError(400, '上游 URL 必须为公网地址');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return `${url.toString().replace(/\/$/, '')}/`;
}

/**
 * Resolve the hostname immediately before a synchronization run and reject
 * private destinations. This prevents a saved public-looking host from being
 * used as a simple server-side request forgery target.
 */
export async function assertPublicUpstreamUrl(value: string): Promise<string> {
  const normalized = normalizeBaseUrl(value);
  const hostname = new URL(normalized).hostname;
  const literal = normalizedIp(hostname);
  if (literal) {
    if (isUnsafeIpAddress(literal)) throw new ZJMFClientError(400, '上游 URL 必须为公网地址');
    return normalized;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ZJMFClientError(502, '无法解析上游主机');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeIpAddress(address))) {
    throw new ZJMFClientError(400, '上游 URL 必须解析到公网地址');
  }
  return normalized;
}

/**
 * Request-time DNS rebinding guard. Unlike {@link assertPublicUpstreamUrl}, a
 * resolution failure is tolerated (the fetch transport will surface it later
 * for a genuinely unreachable host); only a host that currently resolves to a
 * private/loopback address is rejected.
 */
async function assertNoPrivateResolution(value: string): Promise<void> {
  const normalized = normalizeBaseUrl(value);
  const hostname = new URL(normalized).hostname;
  const literal = normalizedIp(hostname);
  if (literal) {
    if (isUnsafeIpAddress(literal)) throw new ZJMFClientError(400, '上游 URL 必须解析到公网地址');
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return;
  }
  if (addresses.some(({ address }) => isUnsafeIpAddress(address))) {
    throw new ZJMFClientError(400, '上游 URL 必须解析到公网地址');
  }
}

/** Convert a decimal upstream price to minor units without floating point loss. */
export function decimalToMinor(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ZJMFClientError(502, '上游商品价格无效');
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const minor = whole * 100n + BigInt(fraction || '0');
  if (minor > 2_000_000_000n) throw new ZJMFClientError(502, '上游商品价格超出范围');
  return Number(minor);
}

export function applyMarkup(price: number, markupBps: number): number {
  const result = (BigInt(price) * BigInt(10_000 + markupBps) + 5_000n) / 10_000n;
  if (result < 1n || result > 2_000_000_000n)
    throw new ZJMFClientError(422, '计算后的价格超出范围');
  return Number(result);
}

function normalizeProduct(value: unknown): ZJMFProduct | null {
  const raw = object(value);
  const id = stringOrNull(raw['id']);
  const name = stringOrNull(raw['name']);
  const price = stringOrNull(raw['sale_price']) ?? stringOrNull(raw['price']);
  if (!id || !name || !price) return null;
  return {
    id,
    name: name.slice(0, 191),
    description: stringOrNull(raw['description'])?.slice(0, 191) ?? null,
    price,
    currency: stringOrNull(raw['currency_code']) ?? stringOrNull(raw['currency']),
    raw,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 规范化上游主机条目。财务协议的 `domainstatus` 才是运行状态（`status` 常为账单
 * 状态）；V10 用 `status`。字段缺失时降级为 null，不丢整条记录。
 */
function normalizeHost(value: unknown): ZJMFHost | null {
  const raw = object(value);
  const id =
    stringOrNull(raw['id']) ??
    stringOrNull(raw['service_id']) ??
    stringOrNull(raw['host_id']) ??
    stringOrNull(raw['instance_id']);
  if (!id) return null;
  const productName =
    stringOrNull(raw['product_name']) ??
    stringOrNull(raw['name']) ??
    stringOrNull(raw['domain']);
  const status =
    stringOrNull(raw['domainstatus']) ??
    stringOrNull(raw['status']) ??
    stringOrNull(raw['status_text']);
  const statusLabel =
    stringOrNull(raw['domainstatus_desc']) ??
    stringOrNull(raw['status_text']) ??
    stringOrNull(raw['status_label']);
  const host = stringOrNull(raw['ip']) ?? stringOrNull(raw['hostname']) ?? stringOrNull(raw['host']);
  const expiresAt =
    stringOrNull(raw['nextduedate']) ??
    stringOrNull(raw['expires_at']) ??
    stringOrNull(raw['expire_at']) ??
    stringOrNull(raw['due_date']);
  const priceText =
    stringOrNull(raw['amount']) ?? stringOrNull(raw['price']) ?? stringOrNull(raw['total']);
  let amount: number | null = null;
  if (priceText) {
    try {
      amount = decimalToMinor(priceText);
    } catch {
      amount = null;
    }
  }
  return {
    id,
    name: stringOrNull(raw['domain']) ?? productName ?? `#${id}`,
    productName,
    status,
    statusLabel,
    host,
    expiresAt,
    amount,
    currency: stringOrNull(raw['currency_code']) ?? stringOrNull(raw['currency']),
    raw,
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

/** 从 /cart/set_config 的 option 行规范化成平台配置项。 */
function normalizeConfigOption(raw: unknown): ZJMFConfigOption | null {
  const o = object(raw);
  const id = stringOrNull(o['id']);
  const label = stringOrNull(o['option_name']);
  if (!id || !label) return null;
  const rawType = Number(o['option_type']);
  const type: 'select' | 'quantity' = rawType === 14 ? 'quantity' : 'select';
  const choices: ZJMFConfigOption['choices'] = [];
  const sub = o['sub'];
  if (rawType === 5 && sub !== null && typeof sub === 'object' && !Array.isArray(sub)) {
    // 操作系统：sub 是按系统名的对象，child[] 为具体版本。
    for (const group of Object.values(sub as Record<string, unknown>)) {
      const g = object(group);
      const child = Array.isArray(g['child']) ? g['child'] : [];
      for (const row of child) {
        const c = object(row);
        const cid = stringOrNull(c['id']);
        const version = stringOrNull(c['version']) ?? stringOrNull(c['show_pricing']);
        if (!cid || !version) continue;
        choices.push({ id: cid, label: version });
      }
    }
  } else if (Array.isArray(sub)) {
    for (const row of sub) {
      const s = object(row);
      const area = Array.isArray(s['area']) ? s['area'] : [];
      const areaFirst = area[0] !== undefined ? object(area[0]) : {};
      const cid = stringOrNull(areaFirst['id']) ?? stringOrNull(s['id']);
      const name = stringOrNull(s['option_name']) ?? stringOrNull(s['show_pricing']);
      if (!cid || !name) continue;
      const qtyMin = typeof s['qty_minimum'] === 'number' ? s['qty_minimum'] : undefined;
      const qtyMax = typeof s['qty_maximum'] === 'number' ? s['qty_maximum'] : undefined;
      const unitPrice = typeof s['pricing'] === 'number' ? s['pricing'] : undefined;
      choices.push({
        id: cid,
        label: name,
        ...(qtyMin !== undefined ? { qtyMin } : {}),
        ...(qtyMax !== undefined ? { qtyMax } : {}),
        ...(unitPrice !== undefined && unitPrice >= 0 ? { price: unitPrice } : {}),
      });
    }
  }
  if (choices.length === 0) return null;
  const min = typeof o['qty_minimum'] === 'number' ? o['qty_minimum'] : undefined;
  const max = typeof o['qty_maximum'] === 'number' ? o['qty_maximum'] : undefined;
  return {
    id,
    label,
    type,
    ...(typeof o['unit'] === 'string' && o['unit'] ? { unit: o['unit'] } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    choices,
  };
}

/** 宽松解析上游小数字符串为 minor units（失败返回 0）。 */
function safeMinor(value: unknown): number | undefined {
  const text = stringOrNull(value);
  if (!text) return undefined;
  try {
    return decimalToMinor(text);
  } catch {
    return undefined;
  }
}

/** 平台运维动作 → 老财务 /provision/default 的 func。 */
const SERVICE_ACTION_FUNC: Record<string, string> = {
  power_on: 'on',
  power_off: 'off',
  reboot: 'reboot',
  terminate: 'terminate',
};

/** 一条监控时序（CPU/内存等），unit 为 '%' 等。 */
export interface ZJMFMetric {
  id: string;
  label: string;
  unit: string;
  points: Array<{ t: number; v: number }>;
}

const METRIC_FIELD_MAP: Array<[string, string, string]> = [
  ['cpu', 'CPU 占用率', '%'],
  ['cpu_usage', 'CPU 占用率', '%'],
  ['memory', '内存占用率', '%'],
  ['mem', '内存占用率', '%'],
  ['memory_usage', '内存占用率', '%'],
  ['disk', '磁盘占用率', '%'],
  ['bandwidth', '带宽', 'Mbps'],
  ['network_in', '入站流量', 'KB/s'],
  ['network_out', '出站流量', 'KB/s'],
];

/** 从原始负载里提取监控时序（兼容上游多种字段形态）。 */
function normalizeMetrics(payload: Record<string, unknown>): ZJMFMetric[] {
  const result: ZJMFMetric[] = [];
  for (const [key, label, unit] of METRIC_FIELD_MAP) {
    const raw = payload[key] ?? payload[key.replace(/_/g, '')];
    const points = toPoints(raw);
    if (points.length) {
      result.push({ id: key, label, unit, points });
    }
  }
  // 兼容 { data: [{name, unit, points}] } 或 { list: [...] } 形态
  for (const candidate of [payload['list'], payload['series']]) {
    if (Array.isArray(candidate)) {
      for (const series of candidate) {
        const o = object(series);
        const name = stringOrNull(o['name']) ?? stringOrNull(o['label']) ?? '';
        const pts = toPoints(o['points'] ?? o['data']);
        if (name && pts.length)
          result.push({ id: name, label: name, unit: stringOrNull(o['unit']) ?? '', points: pts });
      }
    }
  }
  return result;
}

function toPoints(value: unknown): Array<{ t: number; v: number }> {
  if (!Array.isArray(value)) return [];
  const points: Array<{ t: number; v: number }> = [];
  for (const item of value) {
    if (Array.isArray(item) && item.length >= 2) {
      const t = Number(item[0]);
      const v = Number(item[1]);
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
    } else {
      const o = object(item);
      const t = Number(o['t'] ?? o['time'] ?? o['ts']);
      const v = Number(o['v'] ?? o['value']);
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
    }
  }
  return points;
}

/** 从开通/详情负载里提取服务字段（ROOT/密码/IP/状态/规格）。 */
function pickServiceDetail(payload: Record<string, unknown>): Record<string, unknown> {
  const status =
    stringOrNull(payload['status']) ??
    (payload['status'] === true ? 'ACTIVE' : stringOrNull(payload['status_text']));
  return {
    providerServiceId:
      stringOrNull(payload['service_id']) ??
      stringOrNull(payload['id']) ??
      stringOrNull(payload['instance_id']),
    host: stringOrNull(payload['ip']) ?? stringOrNull(payload['hostname']),
    ip: stringOrNull(payload['ip']),
    username:
      stringOrNull(payload['username']) ??
      stringOrNull(payload['root']) ??
      stringOrNull(payload['account']),
    password: stringOrNull(payload['password']) ?? stringOrNull(payload['root_password']),
    status,
    statusLabel: stringOrNull(payload['status_text']) ?? stringOrNull(payload['statusLabel']),
    specs: pickSpecs(payload),
    raw: payload,
  };
}

/** 常见的规格字段（CPU 核数/内存/磁盘/带宽等）。 */
function pickSpecs(payload: Record<string, unknown>): Record<string, unknown> {
  const specs: Record<string, unknown> = {};
  const map: Array<[string, string]> = [
    ['cpu', 'cpu'],
    ['cores', 'cpu'],
    ['cpu_count', 'cpu'],
    ['memory', 'memory'],
    ['ram', 'memory'],
    ['memory_mb', 'memory'],
    ['disk', 'disk'],
    ['disk_gb', 'disk'],
    ['bandwidth', 'bandwidth'],
    ['os', 'os'],
    ['os_name', 'os'],
    ['region', 'region'],
    ['datacenter', 'region'],
  ];
  for (const [from, to] of map) {
    const value = payload[from];
    if (value !== undefined && value !== null) specs[to] = value;
  }
  return specs;
}

/** 从开通响应里提取登录凭证（主机账号/密码）。 */
function extractCredentials(payload: Record<string, unknown>): Record<string, string> {
  const credentials: Record<string, string> = {};
  const username =
    stringOrNull(payload['username']) ??
    stringOrNull(payload['root']) ??
    stringOrNull(payload['account']);
  const password =
    stringOrNull(payload['password']) ??
    stringOrNull(payload['root_password']) ??
    stringOrNull(payload['pass']);
  const ip = stringOrNull(payload['ip']) ?? stringOrNull(payload['hostname']);
  if (username) credentials['username'] = username;
  if (password) credentials['password'] = password;
  if (ip) credentials['ip'] = ip;
  return credentials;
}

function normalizedIp(hostname: string): string | null {
  const address = hostname.replace(/^\[|\]$/g, '');
  return isIP(address) ? address : null;
}

