import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isUnsafeHostname, isUnsafeIpAddress } from '@stackpanel/net-guard';
import { z } from 'zod';
import type { ServiceChangeOption } from '@stackpanel/sdk';

export { isUnsafeIpAddress };

export type ZJMFProtocol = 'finance' | 'v10';

/**
 * V10 服务生命周期所在的 console 路由家族（取决于上游装的模块）。
 *
 * 证据：`10.4.6/public/plugins/server/` 与 `reserver/` 下各模块的 route.php
 * 都把实例接口挂在 `console/v1/<family>/:id/...` 下：
 * - `mf_cloud`      直营云（server/mf_cloud）
 * - `remf_cloud`    代理云（reserver/mf_cloud，上游本身也是代理商时）
 * - `mf_dcim`       物理机
 * - `idcsmart_common` 通用产品（走 provision/:func）
 *
 * `auto` 表示按实例详情路由自动探测并缓存。
 */
export type ZJMFV10Module = 'auto' | 'mf_cloud' | 'remf_cloud' | 'mf_dcim' | 'idcsmart_common';

export interface ZJMFConnection {
  id: string;
  baseUrl: string;
  protocol: ZJMFProtocol;
  username: string;
  password: string;
  /** V10 console 路由家族；默认 auto（探测）。 */
  v10Module?: ZJMFV10Module;
  /**
   * 实验开关：允许调用**未取证**的 V10 路由（换商品/转移所有权）。
   * 服务生命周期（开关机/重装/VNC/续费/快照/备份）已有源码证据，不再受此开关限制。
   */
  allowUnverifiedV10Routes?: boolean;
}

export interface ZJMFProduct {
  id: string;
  name: string;
  description: string | null;
  price: string;
  currency: string | null;
  raw: Record<string, unknown>;
}

/** 上游已购服务（主机）条目（财务：`/host/list`；V10：`console/v1/host`）。 */
export interface ZJMFHost {
  productId: string | null;
  id: string;
  name: string;
  productName: string | null;
  status: string | null;
  statusLabel: string | null;
  host: string | null;
  expiresAt: string | null;
  openedAt: string | null;
  amount: number | null;
  currency: string | null;
  raw: Record<string, unknown>;
}

/** 上游商品的可配置项（来自 /cart/set_config，pricing 可能为空，计价走 get_total）。 */
export interface ZJMFConfigOption {
  id: string;
  label: string;
  type: 'select' | 'quantity';
  /** 维度分组（由 upstream option_type 推断：位置/规格/镜像/网络…）。 */
  group?: string;
  /** 说明文案（来自 description）。 */
  help?: string;
  /** 默认选中档位（来自 default/default_sub）。 */
  defaultChoice?: string;
  /** 条件显隐：父配置项选中指定项时该配置项才可见（联动）。 */
  visibleWhen?: { field: string; equals?: string; in?: string[] };
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  choices: Array<{
    id: string;
    label: string;
    price?: number;
    /** 按周期定价（cycleId → minor）。 */
    prices?: Record<string, number>;
    /** 层级联动：该档位仅在父配置项选中指定项时可用。 */
    requires?: Record<string, string | string[]>;
    qtyMin?: number;
    qtyMax?: number;
  }>;
}

/** 上游商品结账配置：周期 + 配置项。 */
export interface ZJMFProductConfig {
  cycles: Array<{
    id: string;
    label: string;
    price: number;
    renewPrice?: number;
  }>;
  options: ZJMFConfigOption[];
}

/** Stable codes for ZJMF client errors (ADR-0012). */
const ZJMF_CLIENT_ERROR_CODES: Record<string, string> = {
  上游商品数据无效: 'zjmf.client.product_data_invalid',
  '上游未返回服务 ID': 'zjmf.client.service_id_missing',
  '上游结算未返回服务 ID': 'zjmf.client.settlement_service_id_missing',
  清空购物车超时: 'zjmf.client.cart_clear_timeout',
  上游请求失败: 'zjmf.client.request_failed',
  上游凭证被拒绝: 'zjmf.client.credentials_rejected',
  '上游登录响应缺少 JWT': 'zjmf.client.jwt_missing',
  '上游 URL 无效': 'zjmf.client.url_invalid',
  '上游 URL 必须为公网地址': 'zjmf.client.url_not_public',
  '上游 URL 必须解析到公网地址': 'zjmf.client.url_not_public',
  无法连接上游: 'zjmf.client.unreachable',
  '上游返回了无效的 JSON': 'zjmf.client.invalid_json',
  上游响应无效: 'zjmf.client.invalid_response',
  上游商品价格无效: 'zjmf.client.price_invalid',
  上游商品价格超出范围: 'zjmf.client.price_out_of_range',
  无法解析上游主机: 'zjmf.client.host_unresolved',
  上游不支持该能力: 'zjmf.client.unsupported',
  '上游结算结果无法确认，且账单反查未成功；请稍后自动重试核对':
    'zjmf.client.invoice_trace_unavailable',
  '上游未留下账单痕迹，可安全重试下单': 'zjmf.client.invoice_trace_empty',
};

/** Resolve a stable code from a ZJMF client error message (exact, then prefix). */
function zjmfClientErrorCode(message: string): string {
  const exact = ZJMF_CLIENT_ERROR_CODES[message];
  if (exact) return exact;
  if (message.startsWith('上游不支持')) return 'zjmf.client.unsupported';
  if (message.startsWith('上游返回 HTTP ')) return 'zjmf.client.http_error';
  // 「账单已定位但实例未建立」带具体账单号，只能按前缀认。
  if (message.startsWith('上游账单')) return 'zjmf.client.invoice_pending_host';
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
  /** 探测到的 console 路由家族（per-instance 缓存，避免每条请求都探测）。 */
  private moduleFamily: Exclude<ZJMFV10Module, 'auto'> | null = null;

  constructor(
    private readonly connection: ZJMFConnection,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** 上游协议（`finance` = 魔方财务；`v10` = 魔方 V10 控制台）。 */
  get protocol(): ZJMFProtocol {
    return this.connection.protocol;
  }

  /**
   * 未取证路由守卫（工单 #2 §3.3）。
   *
   * V10 的服务生命周期路由**已有源码证据**（`console/v1/<family>/:id/...`）：
   * - `public/plugins/server/mf_cloud/route.php`
   * - `public/plugins/reserver/mf_cloud/route.php`（代理家族）
   * - `public/plugins/server/mf_dcim/route.php`
   * 这些不再受实验开关限制，只有真正没有证据的两条（换商品、转移所有权）保留守卫。
   */
  private assertVerifiedV10Route(capability = '该能力'): void {
    if (this.connection.protocol !== 'v10') return;
    if (this.connection.allowUnverifiedV10Routes) return;
    throw new ZJMFClientError(501, `上游不支持${capability}`);
  }

  /** 显式配置的家族（非 auto）或已探测结果。 */
  private knownFamily(): Exclude<ZJMFV10Module, 'auto'> | null {
    if (this.connection.v10Module && this.connection.v10Module !== 'auto') {
      return this.connection.v10Module;
    }
    return this.moduleFamily;
  }

  /**
   * 解析某个实例所属的 console 路由家族。
   *
   * 优先用显式配置；否则按 `mf_cloud → remf_cloud → mf_dcim → idcsmart_common`
   * 顺序探测详情路由，命中后缓存（一个上游实例通常只装一种模块）。
   * 全部 404/400 时回退 `mf_cloud`（最常见），让真实错误浮出而不是静默失败。
   */
  private async resolveFamily(serviceId: string): Promise<Exclude<ZJMFV10Module, 'auto'>> {
    const known = this.knownFamily();
    if (known) return known;
    const candidates: Array<Exclude<ZJMFV10Module, 'auto'>> = [
      'mf_cloud',
      'remf_cloud',
      'mf_dcim',
      'idcsmart_common',
    ];
    const encoded = encodeURIComponent(serviceId);
    for (const family of candidates) {
      const path =
        family === 'idcsmart_common'
          ? `console/v1/idcsmart_common/host/${encoded}/configoption`
          : `console/v1/${family}/${encoded}`;
      try {
        const response = await this.authorizedRequest(path, 'GET', false);
        // 不存在的实例常以 HTTP 200 + `{status:400}` 返回，因此必须看到非空 `data`
        // 才认为该家族命中，否则会把 400 误判成成功。
        if (response && Object.keys(object(response['data'])).length > 0) {
          this.moduleFamily = family;
          return family;
        }
      } catch {
        // 该家族不存在或该实例不属于它，继续下一个。
      }
    }
    this.moduleFamily = 'mf_cloud';
    return 'mf_cloud';
  }

  /** console 家族的实例基础路径。 */
  private familyBase(family: Exclude<ZJMFV10Module, 'auto'>): string {
    return family === 'idcsmart_common'
      ? 'console/v1/idcsmart_common/host'
      : `console/v1/${family}`;
  }

  /**
   * 家族「实例详情」路径。
   *
   * `idcsmart_common` 没有 `host/:id` 详情，只有 `host/:id/configoption`
   * （配置项即它的详情面）。证据：`public/plugins/server/idcsmart_common/route.php:22`。
   */
  private familyDetailPath(family: Exclude<ZJMFV10Module, 'auto'>, serviceId: string): string {
    const encoded = encodeURIComponent(serviceId);
    return family === 'idcsmart_common'
      ? `${this.familyBase(family)}/${encoded}/configoption`
      : `${this.familyBase(family)}/${encoded}`;
  }

  async listProducts(): Promise<{
    products: ZJMFProduct[];
    currency: string | null;
  }> {
    // 证据：10.4.6/route/api.php:13 `Route::get('product', ...)`（V10 开放 API 已取证）。
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
    // 证据：10.4.6/route/api.php:15 `Route::get('product/:id', ...)`（V10 开放 API 已取证）。
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
   * - 财务协议：`/host/list`
   * - V10：`/console/v1/host?page=&limit=`（证据 `10.4.6/route/home.php`
   *   `Route::get('host', 'home/host/list')`，返回 `data.list` / `data.count`）
   *
   * 无法列出的协议/实例返回空数组（不阻断其它实例）。
   */
  async listHosts(limit?: number): Promise<ZJMFHost[]> {
    const cap = limit === undefined ? Infinity : Math.max(1, Math.floor(limit));
    const pageSize = Math.min(cap, 50);
    const hosts = new Map<string, ZJMFHost>();
    for (let page = 1; page <= 10000; page++) {
      const path =
        this.connection.protocol === 'finance'
          ? `/host/list?page=${page}&limit=${pageSize}`
          : `console/v1/host?page=${page}&limit=${pageSize}`;
      const data = await this.authorizedGet(path);
      const payload = object(data['data']);
      const list = Array.isArray(payload['list']) ? payload['list'] : [];
      const before = hosts.size;
      for (const row of list) {
        const host = normalizeHost(row);
        if (host) hosts.set(host.id, host);
      }
      if (hosts.size >= cap) return [...hosts.values()].slice(0, cap);
      const total = Number(payload['count'] ?? payload['total']);
      if (
        list.length === 0 ||
        (Number.isFinite(total) && hosts.size >= total) ||
        (!Number.isFinite(total) && list.length < pageSize)
      )
        return [...hosts.values()];
      if (hosts.size === before)
        throw new ZJMFClientError(502, '上游实例分页未前进，无法确认完整列表');
    }
    throw new ZJMFClientError(502, '上游实例分页超过安全限制，未返回不完整列表');
  }

  /**
   * 拉取商品的可配置项 + 周期。
   *
   * - 财务：前台 `/cart/set_config`
   * - V10：`POST /console/v1/product/:id/config_option?is_downstream=1`
   *   （证据 `app/common/logic/ResModuleLogic.php:983`：上游代理正是用这条路由
   *   取下游配置；响应 `data.billing_cycle` / `data.preview` / `data.price`）
   *
   * 返回 null 表示该商品不可配置。
   */
  async getConfig(
    productId: string,
    opts: { cycle?: string; selections?: Record<string, string | number> } = {},
  ): Promise<ZJMFProductConfig | null> {
    if (this.connection.protocol !== 'finance') {
      const encoded = encodeURIComponent(productId);
      const body: FormBody = {
        qty: '1',
        config_options: { configoption: opts.selections ?? {} },
      };
      if (opts.cycle)
        body['config_options'] = {
          ...(body['config_options'] as Record<string, unknown>),
          cycle: opts.cycle,
        };
      const data = await this.authorizedPost(
        `console/v1/product/${encoded}/config_option?is_downstream=1`,
        body,
      );
      const payload = object(data['data']);
      const preview = Array.isArray(payload['preview']) ? payload['preview'] : [];
      const cycleName = stringOrNull(payload['billing_cycle']);
      if (!cycleName && preview.length === 0) return null;
      const cycles = cycleName
        ? [
            {
              id: cycleName,
              label: cycleName,
              price: safeMinor(stringOrNull(payload['renew_price'])) ?? 0,
            },
          ]
        : [];
      const options = preview
        .map((row) => {
          const o = object(row);
          const name = stringOrNull(o['name']);
          if (!name) return null;
          const option: ZJMFConfigOption = {
            id: name,
            label: name,
            type: 'select',
            choices: [
              {
                id: stringOrNull(o['value']) ?? '',
                label: stringOrNull(o['value']) ?? '',
                price: safeMinor(stringOrNull(o['price'])) ?? 0,
              },
            ],
          };
          return option;
        })
        .filter((option): option is ZJMFConfigOption => option !== null);
      return cycles.length > 0 ? { cycles, options } : null;
    }
    const params = new URLSearchParams({
      pid: productId,
      billingcycle: opts.cycle ?? 'monthly',
    });
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
   * 财务版：这台机器**实际能改哪些配置项**。
   *
   * `GET /upgrade/index/:id` 是上游自己的「变更配置」面板数据源：`data.host[]`
   * 每行一个可选配置项（`oid` 与商品配置项 id 同域），`sub[]` 是允许改成的档位
   * （带 `fee`）。实测响应约 200ms。
   *
   * 之所以要这份白名单：商品配置里有区域/系统/CPU 等一堆项，上游只受理其中
   * 少数几项（这台机器是「快照数量」「IP 数量」）。没有它，报价会对任何选择
   * 都说「可以」，用户付款后变更才被上游 400 打回。
   *
   * V10 的变更面是 `upgrade_config`/`common_config`，语义不同，先返回 undefined
   * （store 回退到商品全量配置）。
   */
  async listChangeOptions(serviceId: string): Promise<ServiceChangeOption[] | undefined> {
    if (this.connection.protocol !== 'finance') return undefined;
    const data = await this.authorizedGet(`upgrade/index/${encodeURIComponent(serviceId)}`);
    const payload = object(data['data']);
    const rows = Array.isArray(payload['host']) ? payload['host'] : [];
    const options: ServiceChangeOption[] = [];
    for (const raw of rows) {
      const row = object(raw);
      const key = stringOrNull(row['oid']) ?? stringOrNull(row['id']);
      const label = stringOrNull(row['option_name']);
      if (!key || !label) continue;
      const subRows = Array.isArray(row['sub']) ? row['sub'] : [];
      const choices: ServiceChangeOption['choices'] = [];
      for (const sub of subRows) {
        const choice = object(sub);
        const value = stringOrNull(choice['id']);
        const choiceLabel =
          stringOrNull(choice['option_name']) ?? stringOrNull(choice['show_pricing']);
        if (!value || !choiceLabel) continue;
        const fee = Number(choice['fee']);
        choices.push({
          value,
          label: choiceLabel,
          ...(Number.isFinite(fee) && fee > 0 ? { fee } : {}),
        });
      }
      if (choices.length === 0) continue;
      const current = stringOrNull(row['subid']);
      const currentLabel = stringOrNull(row['suboption_name']);
      options.push({
        key,
        label,
        ...(current ? { current } : {}),
        ...(currentLabel ? { currentLabel } : {}),
        choices,
      });
    }
    return options;
  }

  /**
   * 按所选配置试算上游价格。返回上游权威总价（minor units，未含我方 markup；
   * 上游侧客户等级折扣已含在内）。无法试算时返回 null。
   *
   * - 财务：`/cart/get_total`
   * - V10：`POST /console/v1/product/:id/config_option?is_downstream=1`
   *   （证据 `app/common/logic/ResModuleLogic.php:983`，响应 `data.price` /
   *   `data.preview[].{name,value,price}`）
   */
  async calculatePrice(
    productId: string,
    opts: {
      cycle?: string;
      selections?: Record<string, string | number>;
      quantity?: number;
    } = {},
  ): Promise<{
    price: number;
    breakdown: Array<{ label: string; value: string; price?: number }>;
    summary: string;
  } | null> {
    if (this.connection.protocol !== 'finance') {
      const encoded = encodeURIComponent(productId);
      const body: FormBody = {
        qty: String(opts.quantity ?? 1),
        config_options: {
          ...(opts.cycle ? { cycle: opts.cycle } : {}),
          configoption: opts.selections ?? {},
        },
      };
      const data = await this.authorizedPost(
        `console/v1/product/${encoded}/config_option?is_downstream=1`,
        body,
      );
      const payload = object(data['data']);
      const priceText = stringOrNull(payload['price']);
      const price = safeMinor(priceText);
      if (price === undefined) return null;
      const breakdown: Array<{ label: string; value: string; price?: number }> = [];
      const preview = Array.isArray(payload['preview']) ? payload['preview'] : [];
      for (const row of preview) {
        const o = object(row);
        const label = stringOrNull(o['name']);
        const value = stringOrNull(o['value']);
        if (!label || !value) continue;
        const entry: { label: string; value: string; price?: number } = {
          label,
          value,
        };
        const minor = safeMinor(stringOrNull(o['price']));
        if (minor !== undefined) entry.price = minor;
        breakdown.push(entry);
      }
      return {
        price,
        breakdown,
        summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
      };
    }
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
    const quotedTotal = safeMinor(saleTotal);
    if (quotedTotal === undefined) return null;
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
    const price = financeCartTotal(products, quotedTotal, child);
    return {
      price,
      breakdown,
      summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
    };
  }

  /**
   * 在上游开通一个服务实例（云服务器等）。
   *
   * 两条协议都走前台购物车链路，只是路径与字段名不同：
   * - 财务：`/cart/clear → /cart/add_to_shop → /cart/settle → /apply_credit`
   * - V10：`DELETE /console/v1/cart → POST /console/v1/cart →
   *   POST /console/v1/cart/settle → POST /console/v1/pay(gateway=credit)`
   *   证据：`app/common/logic/ResModuleLogic.php:382-435`（上游代理自己的下单流程）。
   */
  async createService(
    productId: string,
    opts: {
      quantity?: number;
      reference?: string;
      downstream?: { id: string; token: string; url: string };
      checkpoint?: (service: {
        providerServiceId: string;
        runtime: Record<string, unknown>;
      }) => Promise<void>;
      cycle?: string;
      selections?: Record<string, string | number>;
    } = {},
  ): Promise<{
    providerServiceId: string;
    credentials: Record<string, string>;
    runtime: Record<string, unknown>;
  }> {
    if ((opts.quantity ?? 1) !== 1)
      throw new ZJMFClientError(409, '上游实例必须逐台下单，禁止丢弃批量实例标识');
    if (
      opts.downstream &&
      (!/^\d+$/.test(opts.downstream.id) ||
        !/^[a-f0-9]{32}$/.test(opts.downstream.token) ||
        !/^https:\/\/[^/?#]+\/?$/.test(opts.downstream.url))
    )
      throw new ZJMFClientError(409, '下游关联参数无效，禁止提交上游请求');
    if (this.connection.protocol === 'finance') {
      return this.createServiceFinance(productId, opts);
    }
    return this.createServiceV10(productId, opts);
  }

  /** V10 下单：清空购物车 → 加入 → 结算 → 余额支付。 */
  private async createServiceV10(
    productId: string,
    opts: {
      quantity?: number;
      reference?: string;
      downstream?: { id: string; token: string; url: string };
      checkpoint?: (service: {
        providerServiceId: string;
        runtime: Record<string, unknown>;
      }) => Promise<void>;
      cycle?: string;
      selections?: Record<string, string | number>;
    },
  ): Promise<{
    providerServiceId: string;
    credentials: Record<string, string>;
    runtime: Record<string, unknown>;
  }> {
    const attemptStartedMs = Date.now();
    // An uncertain clear must not race with a new add/settle request.
    await this.authorizedRequest('console/v1/cart', 'DELETE', false);
    const body: FormBody = {
      product_id: String(productId),
      qty: String(opts.quantity ?? 1),
      config_options: { configoption: opts.selections ?? {} },
    };
    if (opts.cycle) {
      body['config_options'] = {
        ...(body['config_options'] as Record<string, unknown>),
        cycle: opts.cycle,
      };
    }
    await this.authorizedPost('console/v1/cart', body);

    // 结算参数照抄上游下游实现：`positions` 是数组（只买了 1 件 → [0]），
    // 另带下游标识，便于上游把实例回挂到我方订单。
    // 证据：`app/common/logic/ResModuleLogic.php:415-425`。
    const settle = await this.authorizedPost('console/v1/cart/settle', {
      positions: ['0'],
      ...(opts.downstream
        ? {
            downstream_host_id: opts.downstream.id,
            downstream_token: opts.downstream.token,
            downstream_url: opts.downstream.url,
          }
        : {}),
    });
    const payload = object(settle['data']);
    // V10 返回 host_ids[]，财务返回 hostid。
    const hostIds = payload['host_ids'];
    let providerServiceId = Array.isArray(hostIds)
      ? stringOrNull(hostIds[0])
      : (stringOrNull(hostIds) ??
        stringOrNull(payload['hostid']) ??
        stringOrNull(payload['host_id']));
    let invoiceId = stringOrNull(payload['order_id']);
    let settledPaid = false;
    if (!providerServiceId) {
      // 结算响应不可用（超时、断连、字段缺失）不等于上游没动作：账单已经开出来了。
      // 账单是上游唯一的记账凭证，只读反查它；凭猜测重下单会真的多买一台。
      const rescued = await this.rescueSettleEvidence({
        invoiceId,
        amount: payload['amount'],
        sinceMs: attemptStartedMs,
      });
      if (rescued === 'unknown') {
        throw new ZJMFClientError(409, '上游结算结果无法确认，且账单反查未成功；请稍后自动重试核对');
      }
      if (rescued === 'no-trace') {
        const error = new ZJMFClientError(409, '上游未留下账单痕迹，可安全重试下单');
        Object.assign(error, { retryableBeforeSubmit: true });
        throw error;
      }
      invoiceId = rescued.invoiceId;
      providerServiceId = rescued.serviceId;
      if (!providerServiceId) {
        // 账单已定位但实例 id 未读到：先付这笔**已知账单**（同一账单单次扣款，不会多付），
        // 付款会驱动上游建实例，随后再反查实例 id。
        const payable = !rescued.paid && !/^Cancel/i.test(rescued.status);
        if (payable) {
          const payment = await this.payServiceInvoice(invoiceId);
          settledPaid = payment.paid;
        }
        const afterPay = await this.inspectInvoice(invoiceId);
        providerServiceId = afterPay?.serviceIds.length === 1 ? afterPay.serviceIds[0]! : null;
      }
      if (!providerServiceId) {
        const error = new ZJMFClientError(409, `上游账单 ${invoiceId} 已定位，但实例尚未建立；请稍后自动重试核对`);
        Object.assign(error, { evidence: { invoiceId } });
        throw error;
      }
    }

    // 有金额才需要支付；0 元单直接算已支付。
    const amount = Number(payload['amount'] ?? 0);
    let paid = settledPaid || (payload['amount'] !== undefined && Number.isFinite(amount) && amount === 0);
    const orderId = invoiceId;
    const checkpointRuntime: Record<string, unknown> = {
      invoiceId: orderId,
      billingCycle: opts.cycle ?? 'monthly',
      config: opts.selections ?? {},
      paid: false,
      paymentState: 'ORDER_CREATED',
      status: 'PENDING_INVOICE',
    };
    await opts.checkpoint?.({ providerServiceId, runtime: checkpointRuntime });
    if (Array.isArray(hostIds) && hostIds.length !== 1) {
      await opts.checkpoint?.({
        providerServiceId,
        runtime: {
          ...checkpointRuntime,
          providerServiceIds: hostIds,
          paymentState: 'REQUIRES_RECONCILIATION',
        },
      });
      throw new ZJMFClientError(409, '上游返回了非预期数量的实例，已保留全部标识，禁止付款');
    }
    let paymentState = paid ? 'PAID' : 'PAYMENT_REQUIRED';
    if (!paid && orderId) {
      await opts.checkpoint?.({
        providerServiceId,
        runtime: { ...checkpointRuntime, paymentState: 'PAYMENT_IN_FLIGHT' },
      });
      try {
        const pay = await this.authorizedPost('console/v1/pay', {
          id: orderId,
          gateway: 'credit',
        });
        // V10 付费返回 code=Paid 表示完成，Unpaid 表示还需三方支付。
        paid = pay['code'] === 'Paid';
        paymentState = paid
          ? 'PAID'
          : pay['code'] === 'Unpaid'
            ? 'PAYMENT_REQUIRED'
            : 'PAYMENT_UNKNOWN';
      } catch {
        paid = false;
        paymentState = 'PAYMENT_UNKNOWN';
      }
    }

    return {
      providerServiceId,
      credentials: await this.fetchV10Credentials(providerServiceId),
      runtime: {
        upstreamId: null,
        host: null,
        ip: null,
        status: paid ? 'PROVISIONING' : 'PENDING_INVOICE',
        invoiceId: orderId ?? null,
        paid,
        paymentState,
        billingCycle: opts.cycle ?? 'monthly',
        config: opts.selections ?? {},
        raw: { settle },
      },
    };
  }

  /**
   * 开通后拉一次实例详情，提取初始登录凭证与 IP。
   * 上游此时可能仍在「开通中」，详情为空/失败都属正常 → 返回空对象。
   */
  private async fetchV10Credentials(serviceId: string): Promise<Record<string, string>> {
    try {
      const family = await this.resolveFamily(serviceId);
      const data = await this.authorizedGet(this.familyDetailPath(family, serviceId));
      return extractCredentials(object(data['data']));
    } catch {
      return {};
    }
  }

  /** 清空购物车必须完成；失败时停止下单，不能与后续购物车写操作并行。 */
  private async clearCartWithTimeout(body: FormBody = {}): Promise<Record<string, unknown>> {
    return this.authorizedPost('/cart/clear', body);
  }

  /** Pay a known invoice once. Caller must durably fence concurrent/repeated payments. */
  async payServiceInvoice(invoiceId: string): Promise<{ paid: boolean; paymentState: string }> {
    try {
      const payment =
        this.connection.protocol === 'finance'
          ? await this.authorizedPost('/apply_credit', {
              invoiceid: invoiceId,
              use_credit: '1',
              enough: '1',
              is_api: '1',
            })
          : await this.authorizedPost('console/v1/pay', { id: invoiceId, gateway: 'credit' });
      const paid =
        this.connection.protocol === 'finance'
          ? payment['status'] === 1001
          : payment['code'] === 'Paid';
      const unpaid =
        this.connection.protocol === 'finance'
          ? payment['status'] === 200
          : payment['code'] === 'Unpaid';
      return {
        paid,
        paymentState: paid ? 'PAID' : unpaid ? 'PAYMENT_REQUIRED' : 'PAYMENT_UNKNOWN',
      };
    } catch {
      // Unknown is not unpaid. Never automatically submit another debit.
      return { paid: false, paymentState: 'PAYMENT_UNKNOWN' };
    }
  }

  /**
   * 只读：读一张账单及其关联实例。
   *
   * 结算响应丢失后，账单是上游**唯一**的记账凭证；`null` 表示「无法判断」（探测本身失败），
   * 必须与「确认没有」严格区分——否则会把网络故障当成“上游什么都没做”，进而重复下单。
   */
  async inspectInvoice(invoiceId: string): Promise<{
    invoiceId: string;
    status: string;
    paid: boolean;
    cancelled: boolean;
    serviceIds: string[];
    amount: string | null;
  } | null> {
    try {
      const response =
        this.connection.protocol === 'finance'
          ? await this.authorizedGet(`/get_invoices_detail?id=${encodeURIComponent(invoiceId)}`)
          : await this.authorizedGet(`console/v1/invoice/${encodeURIComponent(invoiceId)}`);
      const data = object(response['data']);
      const detail = object(data['detail'] ?? data['invoice'] ?? data);
      const status = String(detail['status'] ?? '');
      const paidTime = detail['paid_time'];
      const items = Array.isArray(data['invoice_items']) ? data['invoice_items'] : [];
      const serviceIds = items
        .map(object)
        .filter((item) => item['type'] === 'host' || item['type'] === 'product')
        .map((item) => stringOrNull(item['rel_id']))
        .filter((id): id is string => Boolean(id));
      // 老财务把实例 id 放在详情链接里（`servicedetail?id=33337`）；没有 rel_id 时这是唯一线索。
      const fromUrl = serviceIdFromDetailUrl(detail['url']);
      if (fromUrl && !serviceIds.includes(fromUrl)) serviceIds.push(fromUrl);
      return {
        invoiceId,
        status,
        paid: status === 'Paid' || (typeof paidTime === 'number' && paidTime > 0),
        cancelled: /^Cancel/i.test(status),
        serviceIds,
        amount:
          stringOrNull(detail['subtotal']) ??
          stringOrNull(detail['total']) ??
          stringOrNull(detail['sub']),
      };
    } catch {
      return null;
    }
  }

  /** 只读：最近账单（响应丢失后按金额＋时间窗定位）。`null` 同样表示「未知」而非「没有」。 */
  async listRecentInvoices(
    options: { sinceMs?: number; limit?: number } = {},
  ): Promise<
    | Array<{
        id: string;
        status: string;
        paid: boolean;
        amount: string | null;
        createdMs: number | null;
      }>
    | null
  > {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    try {
      // V10 的账单列表端点在上游没有稳定证据（实测 404），宁可不猜也不乱调。
      if (this.connection.protocol !== 'finance') return null;
      const response = await this.authorizedGet(`/get_invoices?limit=${limit}`);
      const data = object(response['data']);
      if (!Array.isArray(data['invoices'])) return null;
      return data['invoices']
        .map(object)
        .map((invoice) => {
          const status = String(invoice['status'] ?? '');
          const paidTime = invoice['paid_time'];
          const stamp = invoice['create_time'] ?? invoice['due_time'];
          return {
            id: stringOrNull(invoice['id']) ?? '',
            status,
            paid: status === 'Paid' || (typeof paidTime === 'number' && paidTime > 0),
            amount:
              stringOrNull(invoice['subtotal']) ??
              stringOrNull(invoice['total']) ??
              stringOrNull(invoice['sub']),
            createdMs: typeof stamp === 'number' && stamp > 0 ? stamp * 1000 : null,
          };
        })
        .filter((invoice) => invoice.id !== '');
    } catch {
      return null;
    }
  }

  /**
   * 结算响应用不了时，反查上游到底做了什么。
   *
   * 返回三态而不是布尔值：`no-trace` 才能安全重下单；`unknown` 只能等下一次核对。
   */
  private async rescueSettleEvidence(options: {
    invoiceId: string | null;
    amount: unknown;
    sinceMs: number;
  }): Promise<
    | 'unknown'
    | 'no-trace'
    | { invoiceId: string; serviceId: string | null; status: string; paid: boolean }
  > {
    let invoiceId = options.invoiceId;
    if (!invoiceId) {
      const recent = await this.listRecentInvoices({ sinceMs: options.sinceMs, limit: 20 });
      if (recent === null) return 'unknown';
      const amount =
        typeof options.amount === 'number' || typeof options.amount === 'string'
          ? Number(options.amount)
          : null;
      const inWindow = recent.filter(
        (invoice) => invoice.createdMs === null || invoice.createdMs >= options.sinceMs - 120_000,
      );
      const candidates = inWindow.filter(
        (invoice) =>
          amount === null ||
          (invoice.amount !== null && Math.abs(Number(invoice.amount) - amount) < 0.005),
      );
      if (candidates.length === 0) return 'no-trace';
      // 多张账单金额相同 → 无法确定哪张是我们的，不猜。
      if (candidates.length > 1) return 'unknown';
      invoiceId = candidates[0]!.id;
    }
    const trace = await this.inspectInvoice(invoiceId);
    if (!trace) return 'unknown';
    return {
      invoiceId,
      serviceId: trace.serviceIds.length === 1 ? trace.serviceIds[0]! : null,
      status: trace.status,
      paid: trace.paid,
    };
  }

  /** Finance V1 UserInvoiceController::getInvoicesDetail: GET only, account-scoped. */
  async verifyCancelledInvoice(invoiceId: string, serviceIds: string[]): Promise<void> {
    if (
      this.connection.protocol !== 'finance' ||
      !/^\d+$/.test(invoiceId) ||
      serviceIds.length !== 1
    )
      throw new ZJMFClientError(409, '缺少可核验的老财务原账单及实例标识');
    const response = await this.authorizedGet(
      `/get_invoices_detail?id=${encodeURIComponent(invoiceId)}`,
    );
    const data = object(response['data']);
    const detail = object(data['detail']);
    const zero = (value: unknown) =>
      (typeof value === 'number' || typeof value === 'string') && /^0+(\.0+)?$/.test(String(value));
    const money = (value: unknown) =>
      (typeof value === 'number' || typeof value === 'string') &&
      /^\d+(\.\d+)?$/.test(String(value));
    if (
      stringOrNull(detail['id']) !== invoiceId ||
      detail['status'] !== 'Cancelled' ||
      !zero(detail['paid_time']) ||
      !zero(detail['credit']) ||
      !zero(detail['use_credit_limit']) ||
      !money(detail['subtotal']) ||
      !money(detail['total']) ||
      Number(detail['subtotal']) !== Number(detail['total']) ||
      !Array.isArray(data['accounts']) ||
      data['accounts'].length !== 0
    )
      throw new ZJMFClientError(409, '原账单未取消、存在付款/余额抵扣，或财务证据不完整，禁止重开');
    const items = data['invoice_items'];
    if (!Array.isArray(items)) throw new ZJMFClientError(409, '原账单缺少实例关联证据');
    const hosts = items
      .map(object)
      .filter((item) => item['type'] === 'host')
      .map((item) => stringOrNull(item['rel_id']));
    if (hosts.length !== serviceIds.length || !serviceIds.every((id) => hosts.includes(id)))
      throw new ZJMFClientError(409, '原账单与实例不匹配，禁止重开');
    for (const id of serviceIds) {
      const header = await this.authorizedGet(`/host/header?host_id=${encodeURIComponent(id)}`);
      const host = object(object(header['data'])['host_data']);
      if (!['Cancelled', 'Canceled'].includes(String(host['domainstatus'])))
        throw new ZJMFClientError(409, '原上游实例未确认取消，禁止重开');
    }
  }

  /** 老财务前台购物车链路开通：clear → add_to_shop → settle → apply_credit。 */
  private async createServiceFinance(
    productId: string,
    opts: {
      quantity?: number;
      downstream?: { id: string; token: string; url: string };
      cycle?: string;
      selections?: Record<string, string | number>;
      checkpoint?: (service: {
        providerServiceId: string;
        runtime: Record<string, unknown>;
      }) => Promise<void>;
    },
  ): Promise<{
    providerServiceId: string;
    credentials: Record<string, string>;
    runtime: Record<string, unknown>;
  }> {
    const billingCycle = opts.cycle ?? 'monthly';
    const attemptStartedMs = Date.now();
    // 共享购物车必须串行清空成功，失败则停止，避免混入其他请求的商品。
    const downstream: FormBody = opts.downstream
      ? {
          downstream_id: opts.downstream.id,
          downstream_token: opts.downstream.token,
          downstream_url: opts.downstream.url,
        }
      : {};
    const cleared = await this.clearCartWithTimeout(downstream);
    const restoredId = stringOrNull(cleared['hostid']);
    const restoredInvoice = stringOrNull(cleared['invoiceid']);
    if (restoredInvoice && !restoredId)
      throw new ZJMFClientError(409, '原上游账单已存在但缺少实例，禁止重新下单');
    if (restoredId && !restoredInvoice)
      throw new ZJMFClientError(409, '原上游实例已存在但缺少账单，禁止重新下单');

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
    if (!restoredId) await this.authorizedPost('/cart/add_to_shop', addBody);

    const settle = restoredId
      ? { data: { hostid: restoredId, invoiceid: restoredInvoice } }
      : await this.authorizedPost('/cart/settle', downstream);
    const settlePayload = object(settle['data']);
    const hostIds = settlePayload['hostid'];
    let invoiceId = stringOrNull(settlePayload['invoiceid']);
    let providerServiceId = Array.isArray(hostIds)
      ? stringOrNull(hostIds[0])
      : stringOrNull(hostIds);
    let settledPaid = false;
    if (!providerServiceId) {
      // 结算响应不可用（超时、断连、字段缺失）不等于上游没动作：账单已经开出来了。
      // 账单是上游唯一的记账凭证，只读反查它；凭猜测重下单会真的多买一台。
      const rescued = await this.rescueSettleEvidence({
        invoiceId,
        amount: settlePayload['total'] ?? settlePayload['amount'],
        sinceMs: attemptStartedMs,
      });
      if (rescued === 'unknown') {
        throw new ZJMFClientError(409, '上游结算结果无法确认，且账单反查未成功；请稍后自动重试核对');
      }
      if (rescued === 'no-trace') {
        const error = new ZJMFClientError(409, '上游未留下账单痕迹，可安全重试下单');
        Object.assign(error, { retryableBeforeSubmit: true });
        throw error;
      }
      invoiceId = rescued.invoiceId;
      providerServiceId = rescued.serviceId;
      // 账单已定位且未付：直接付这一张（单张账单只扣一次，不可能多付）。
      // 不付就永远停在 AWAITING_UPSTREAM_PAYMENT 等人工点「继续付款」。
      if (!rescued.paid && !/^Cancel/i.test(rescued.status)) {
        const payment = await this.payServiceInvoice(invoiceId);
        settledPaid = payment.paid;
      }
      // 账单 `items[].rel_id` 只是下单占位的记录 id：付款后上游会重新分配主机 id
      // （实测账单 875797 付款后真实主机是 33363，而 rel_id 指向不存在的 33360）。
      // 所以必须以会员主机列表为准确认；确认不到就不冒充证据。
      const resolvedHost = await this.resolveHostForAttempt({
        invoiceId,
        sinceMs: attemptStartedMs,
      });
      providerServiceId = resolvedHost ? stringOrNull(resolvedHost['id']) : null;
      if (!providerServiceId) {
        const error = new ZJMFClientError(409, `上游账单 ${invoiceId} 已定位，但实例尚未建立；请稍后自动重试核对`);
        Object.assign(error, { evidence: { invoiceId } });
        throw error;
      }
    }

    const checkpointRuntime: Record<string, unknown> = {
      invoiceId,
      billingCycle,
      config: opts.selections ?? {},
      paid: false,
      paymentState: 'ORDER_CREATED',
      status: 'PENDING_INVOICE',
    };
    // Durable identity must reach the provider/store before any payment can start.
    await opts.checkpoint?.({ providerServiceId, runtime: checkpointRuntime });

    if (Array.isArray(hostIds) && hostIds.length !== 1) {
      await opts.checkpoint?.({
        providerServiceId,
        runtime: {
          ...checkpointRuntime,
          providerServiceIds: hostIds,
          paymentState: 'REQUIRES_RECONCILIATION',
        },
      });
      throw new ZJMFClientError(409, '上游返回了非预期数量的实例，已保留全部标识，禁止付款');
    }

    // 仅对原发票全额支付一次；余额不足不进行部分扣款。
    let paid = settledPaid;
    let paymentState = settledPaid ? 'PAID' : 'PAYMENT_REQUIRED';
    if (invoiceId && !settledPaid) {
      await opts.checkpoint?.({
        providerServiceId,
        runtime: { ...checkpointRuntime, paymentState: 'PAYMENT_IN_FLIGHT' },
      });
      try {
        const credit = await this.authorizedPost('/apply_credit', {
          invoiceid: invoiceId,
          use_credit: '1',
          enough: '1',
          is_api: '1',
          ...downstream,
        });
        paid = credit['status'] === 1001;
        paymentState = paid
          ? 'PAID'
          : credit['status'] === 200
            ? 'PAYMENT_REQUIRED'
            : 'PAYMENT_UNKNOWN';
      } catch {
        paid = false;
        paymentState = 'PAYMENT_UNKNOWN';
      }
    }

    // 付款后上游可能把占位 id 换成真实主机：以主机列表复核一次（只读）。
    // 不修正的话 store 会拿着不存在的 id 同步状态，永远卡在 PROVISIONING。
    if (providerServiceId) {
      const actual = await this.findHost(providerServiceId);
      if (!actual) {
        const resolved = await this.resolveHostForAttempt({
          invoiceId,
          sinceMs: attemptStartedMs,
        });
        const corrected = resolved ? resolved.id : null;
        if (corrected && corrected !== providerServiceId) {
          providerServiceId = corrected;
          await opts.checkpoint?.({
            providerServiceId,
            runtime: { ...checkpointRuntime, paymentState: 'PROVISIONING' },
          });
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
        paymentState,
        billingCycle,
        config: opts.selections ?? {},
        raw: { settle },
      },
    };
  }

  async getService(serviceId: string): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      // 权威数据源是会员主机列表：/host/header 会把 host_id 当产品查，对真实主机
      // 一律返回「未找到该产品」（已实测）。所以 header 只做尽力而为的补充
      // （部分上游只在 header 里给凭证/IP/OS），字段以列表优先。
      const hosts = await this.listHosts();
      const listed = hosts.find((entry) => entry.id === String(serviceId))?.raw ?? {};
      const header = await this
        .authorizedGet(`/host/header?host_id=${encoded}`)
        .catch(() => null);
      const hostData = object(object(header?.['data'])['host_data']);
      if (Object.keys(listed).length === 0 && Object.keys(hostData).length === 0) {
        throw new ZJMFClientError(404, `上游主机 ${serviceId} 不存在`);
      }
      const merged = { ...hostData, ...listed };
      // domainstatus 才是运行状态；header 里的 status 常是账单状态（如 Paid）。
      const status =
        stringOrNull(merged['domainstatus']) ??
        stringOrNull(merged['status']) ??
        stringOrNull(merged['status_text']);
      const statusLabel =
        stringOrNull(merged['domainstatus_desc']) ?? stringOrNull(merged['status_text']);
      return pickServiceDetail({
        ...merged,
        ip: stringOrNull(merged['dedicatedip']) ?? stringOrNull(merged['ip']),
        // 追加 IP 是用户花钱买的：主 IP 之外必须一并透出，否则「加了 IP 看不到」。
        extraIps: Array.isArray(merged['assignedips'])
          ? merged['assignedips'].filter((value): value is string => typeof value === 'string')
          : [],
        // 套餐含的流量额度（如 `800G`）；已用流量无法取到可信单位，不做换算。
        flowLimit: stringOrNull(merged['flow_limit']),
        ...(status ? { status } : {}),
        ...(statusLabel ? { statusLabel } : {}),
      });
    }
    // V10：通用实例详情 + 家族详情（含 CPU/内存/电源状态/镜像）。
    // 证据：`10.4.6/route/home.php` `Route::get('host/:id', 'home/host/index')` 返回
    // `data.host.{status,due_time,billing_cycle,...}`；家族详情返回 `data.{ip,power_status,cpu,...}`。
    const family = await this.resolveFamily(serviceId);
    const [generic, specific] = await Promise.all([
      this.authorizedGet(`console/v1/host/${encoded}`).catch(() => null),
      this.authorizedGet(this.familyDetailPath(family, serviceId)).catch(() => null),
    ]);
    const genericPayload = object(object(generic?.['data'])['host']);
    const specificPayload = object(specific?.['data']);
    const merged = { ...genericPayload, ...specificPayload };
    return pickServiceDetail({
      ...merged,
      // power_status 是运行状态（on/off/operating/fault）；host.status 是生命周期状态。
      status: stringOrNull(merged['power_status']) ?? stringOrNull(merged['status']),
      ...(epochToIso(merged['due_time']) ? { expiresAt: epochToIso(merged['due_time']) } : {}),
      ...(stringOrNull(merged['billing_cycle']) ? { cycle: merged['billing_cycle'] } : {}),
    });
  }

  /** 按上游主机 id 定位（不存在则 null）。 */
  async findHost(serviceId: string): Promise<ZJMFHost | null> {
    const hosts = await this.listHosts();
    return hosts.find((host) => host.id === String(serviceId)) ?? null;
  }

  /**
   * 账单 → 主机（只信主机列表里的 `invoice_id`，不信账单 `items[].rel_id`）。
   * 多张匹配＝有歧义，返回 null，绝不猜。
   */
  async findHostForInvoice(invoiceId: string): Promise<ZJMFHost | null> {
    if (this.connection.protocol !== 'finance') return null;
    const hosts = await this.listHosts();
    const target = String(invoiceId);
    const matched = hosts.filter((host) => String(host.raw['invoice_id'] ?? '') === target);
    return matched.length === 1 ? matched[0]! : null;
  }

  /**
   * 本次开通尝试对应的主机：优先账单号对齐，其次「尝试时间窗内唯一新增的主机」。
   * 付款会把账单换成新号（实测 875797 → 875800），所以时间窗是必要兜底。
   */
  async resolveHostForAttempt(options: {
    invoiceId?: string | null;
    sinceMs: number;
  }): Promise<ZJMFHost | null> {
    if (this.connection.protocol !== 'finance') return null;
    if (options.invoiceId) {
      const exact = await this.findHostForInvoice(options.invoiceId);
      if (exact) return exact;
    }
    const hosts = await this.listHosts();
    const floorMs = options.sinceMs - 120_000;
    const fresh = hosts.filter((host) => {
      const regdate = Number(host.raw['regdate'] ?? host.raw['create_time']);
      return Number.isFinite(regdate) && regdate > 0 && regdate * 1000 >= floorMs;
    });
    return fresh.length === 1 ? fresh[0]! : null;
  }

  /**
   * 执行上游服务运维动作。
   *
   * - 财务协议：`/provision/default`，动作经 {@link SERVICE_ACTION_FUNC} 映射为 `func`。
   * - V10：`POST console/v1/<family>/:id/<action>`（每个动作一个端点）。
   *   证据：`10.4.6/public/plugins/server/mf_cloud/route.php:94-102`
   *   `on/off/reboot/hard_off/hard_reboot/rescue/rescue/exit/reinstall/reset_password/vnc`。
   *
   * 返回上游响应体，供调用方提取展示字段（如新密码、控制台地址）。
   */
  async runServiceAction(
    serviceId: string,
    action: string,
    params?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    const extra = params ?? {};
    if (this.connection.protocol === 'finance') {
      const func = SERVICE_ACTION_FUNC[action] ?? action;
      // 保留字段放最后：防止调用方参数（extra）覆盖 id/func/is_api 造成动作篡改。
      return this.authorizedPost('/provision/default', {
        ...extra,
        id: encoded,
        func,
        is_api: '1',
      });
    }
    const family = await this.resolveFamily(serviceId);
    const path = v10ActionPath(family, serviceId, action);
    if (!path) {
      if (action === 'terminate') {
        // V10 没有客户自助「终止实例」路由：删除/退款只能走上游后台或
        // `addon idcsmart_refund`（需后台审核）。这里必须显式失败，让本地停留在
        // 「处理中」重试，而不是把本地状态推进到已终止（审计 #3 的同类问题）。
        throw new ZJMFClientError(
          501,
          '上游不支持该能力：V10 无客户自助终止路由，请在 ZJMF 后台或退款插件处理',
        );
      }
      throw new ZJMFClientError(400, '上游不支持该运维动作');
    }
    // VNC 多要一份控制台细节（地址/临时令牌/VNC 密码）。
    const query = action === 'vnc' ? '?more=1' : '';
    return this.authorizedPost(`${path}${query}`, extra);
  }

  /**
   * 该实例所属家族是否提供快照/备份这类子资源。
   *
   * `mf_dcim`（物理机）与 `idcsmart_common`（通用产品）都没有
   * `snapshot/backup/disk` 路由，声明了也只会得到 400。这里在声明阶段就收敛，
   * 避免前端展示必然失败的按钮。探测失败按「不支持」处理（fail-closed）。
   */
  async supportsServiceResources(serviceId: string): Promise<boolean> {
    // 财务版的快照/备份只能通过 `/provision/custom/:id` 的 createSnap/createBackup
    // 触发，**列表**接口 `/provision/custom/content?key=snapshot` 返回的是上游模板
    // 渲染的 HTML 片段（无结构化数据），既列不出已有快照，也删不掉/恢复不了。
    // 只声明「能创建不能查看」的子资源只会制造「我的快照在哪」的工单，
    // 所以这里继续 fail-closed。以下为最初的探测记录：
    // 财务版没有可用的客户自助子资源端点：实测 `/host/snapshot`、`/host/backup`
    // 一类路径返回上游 500（参数/路由不匹配），`/provision/custom/content` 亦无
    // snapshot/backup 分支。宁可 fail-closed（不展示能力），也不给用户一个点开就报错的按钮。
    if (this.connection.protocol === 'finance') return false;
    try {
      const family = await this.resolveFamily(serviceId);
      return family === 'mf_cloud' || family === 'remf_cloud';
    } catch {
      return false;
    }
  }

  async getServiceMetrics(serviceId: string): Promise<ZJMFMetric[]> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      // 财务版的监控取数是 `/provision/chart/:hostId`，不是 `/host/chart`。
      // 证据：`public/plugins/reserver/mf_finance/controller/home/CloudController.php`
      // （`$RouteLogic->curl('/provision/chart/'.$upstream_host_id, ['type'=>..., 'is_api'=>true], 'GET')`）。
      // 实测 `type=cpu|memory|flow|disk` 返回 `{unit,label[],list[[{time,value}]]}`，
      // `type=network` 回 400、不传 type 回 406「类型错误」。
      const types: Array<[string, string, string]> = [
        ['cpu', 'CPU 使用率', '%'],
        ['memory', '内存', 'B'],
        ['flow', '带宽', 'bps'],
        ['disk', '磁盘 IO', 'B/s'],
      ];
      const series = await Promise.all(
        types.map(async ([type, label, unit]) => {
          try {
            const query = new URLSearchParams({ type, is_api: '1' });
            const payload = await this.authorizedGet(
              `/provision/chart/${encoded}?${query.toString()}`,
            );
            return chartToMetrics(type, label, unit, payload);
          } catch {
            // 单个类型取不到不影响其它曲线：监控面板少一条比整块报错好。
            return [];
          }
        }),
      );
      return series.flat();
    }
    // V10：`GET console/v1/<family>/:id/chart?type=cpu`，返回 data.list[].{time,value}。
    // 证据：`10.4.6/public/plugins/server/mf_cloud/controller/home/CloudController.php:876-910`。
    const family = await this.resolveFamily(serviceId);
    const base = `${this.familyBase(family)}/${encoded}`;
    const types: Array<[string, string, string]> = [
      ['cpu', 'CPU 占用率', '%'],
      ['memory', '内存占用率', '%'],
      ['bw', '带宽', 'bps'],
    ];
    const series = await Promise.all(
      types.map(async ([type, label, unit]) => {
        try {
          const payload =
            family === 'idcsmart_common'
              ? // 通用产品：`POST configoption/chart`，参数是 `chart[]` 数组，
                // 由子模块决定支持哪些类型。证据
                // `public/plugins/server/idcsmart_common/route.php:26`。
                object(
                  (
                    await this.authorizedPost(`${base}/configoption/chart`, {
                      chart: [
                        {
                          type,
                          start: String(Math.floor(Date.now() / 1000) - 3600),
                        },
                      ],
                    })
                  )['data'],
                )
              : // 云/物理机：`GET chart?type=cpu|memory|bw`。
                object((await this.authorizedGet(`${base}/chart?type=${type}`))['data']);
          // chart 响应按类型给不同字段：cpu→value，memory→used/total，bw→in_bw/out_bw。
          const points = normalizeChartPoints(payload, type);
          return points.length > 0 ? { id: type, label, unit, points } : null;
        } catch {
          return null;
        }
      }),
    );
    return series.filter((item): item is ZJMFMetric => item !== null);
  }

  /* --------------------- 生命周期：续费 / 升降级 / 转移 --------------------- */

  /**
   * 同步上游续费。老财务（finance）走 `/host/renew` + `/apply_credit`（余额支付）；
   * V10 走 `console/v1/host/:id/renew`（Unpaid 时接 credit → pay）。
   *
   * 说明：续费金额与到期时间以**本平台**为准；上游续费是尽力同步，失败不阻断。
   */
  async renewService(
    serviceId: string,
    opts: { cycle?: string } = {},
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      const renew = await this.authorizedPost('/host/renew', {
        hostid: encoded,
        ...(opts.cycle ? { billingcycles: opts.cycle } : {}),
      });
      const invoiceId = invoiceIdOf(renew);
      if (invoiceId) await this.applyCredit(invoiceId);
      return renew;
    }
    // V10：`POST console/v1/host/:id/renew`，body `billing_cycle`。若返回 code=Unpaid
    // 再走余额支付：`POST console/v1/credit{id,use:1}` → `POST console/v1/pay{id,gateway:credit}`。
    // 证据：`app/common/logic/ResModuleLogic.php:667-695`。
    const renew = await this.authorizedPost(`console/v1/host/${encoded}/renew`, {
      ...(opts.cycle ? { billing_cycle: opts.cycle } : {}),
    });
    if (renew['code'] === 'Unpaid') {
      const payload = object(renew['data']);
      const orderId = stringOrNull(payload['id']);
      if (orderId) {
        await this.authorizedPost('console/v1/credit', {
          id: orderId,
          use: '1',
        }).catch(() => null);
        return this.authorizedPost('console/v1/pay', {
          id: orderId,
          gateway: 'credit',
        });
      }
    }
    return renew;
  }

  /**
   * 升配/降配（变更配置）。
   *
   * - 财务：`upgrade/upgrade_config_post → upgrade/checkout_config_upgrade → /apply_credit`
   * - V10：`POST console/v1/<family>/:id/common_config/order`（自定义配置），
   *   返回 `data.id`（订单）；有金额则余额支付。
   *   证据：`10.4.6/public/plugins/server/mf_cloud/route.php:74-75` +
   *   `controller/home/CloudController.php:createCommonConfigOrder`。
   */
  async changePackage(
    serviceId: string,
    opts: { selections?: Record<string, string | number> } = {},
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      await this.authorizedPost('upgrade/upgrade_config_post', {
        ...configOptionBody(opts.selections),
        hid: encoded,
      });
      const checkout = await this.authorizedPost('upgrade/checkout_config_upgrade', {
        hid: encoded,
      });
      const invoiceId = invoiceIdOf(checkout);
      if (invoiceId) await this.applyCredit(invoiceId);
      return checkout;
    }
    const family = await this.resolveFamily(serviceId);
    const order = await this.authorizedPost(
      `${this.familyBase(family)}/${encoded}/common_config/order`,
      { ...configOptionBody(opts.selections) },
    );
    await this.payV10Order(order);
    return order;
  }

  /**
   * 换商品（升降级到另一个商品）。V10 下属于后台/代理侧操作，样本没有客户自助
   * 端点（换商品在上游由客服改单），故默认不支持；实验开关放行时可指向 order 流。
   */
  async changeProduct(
    serviceId: string,
    productId: string,
    opts: { cycle?: string } = {},
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      await this.authorizedPost('upgrade/upgrade_product_post', {
        hid: encoded,
        pid: productId,
        ...(opts.cycle ? { billingcycle: opts.cycle } : {}),
      });
      const checkout = await this.authorizedPost('upgrade/checkout_upgrade_product', {
        hid: encoded,
      });
      const invoiceId = invoiceIdOf(checkout);
      if (invoiceId) await this.applyCredit(invoiceId);
      return checkout;
    }
    // 未取证：V10 无「客户自助换商品」路由（只有 recommend_config 套餐升降级）。
    this.assertVerifiedV10Route('换商品');
    throw new ZJMFClientError(501, '上游不支持换商品');
  }

  /**
   * 升配/降配差价试算（上游权威）。
   *
   * - 财务：`upgrade/upgrade_config_post` → `upgrade/upgrade_config_page.price_difference`
   * - V10：`GET console/v1/<family>/:id/common_config`（`data.price_difference`）
   *   证据：`controller/home/CloudController.php:calCommonConfigPrice`。
   * 返回 null 表示上游不支持试算（store 回退本地差额估算）。
   */
  async calculateChangePrice(
    serviceId: string,
    opts: { selections?: Record<string, string | number> } = {},
  ): Promise<{
    price: number;
    breakdown: Array<{ label: string; value: string; price?: number }>;
    summary: string;
  } | null> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol !== 'finance') {
      const family = await this.resolveFamily(serviceId);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(configOptionBody(opts.selections))) {
        params.append(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      const data = await this.authorizedGet(
        `${this.familyBase(family)}/${encoded}/common_config?${params.toString()}`,
      );
      const payload = object(data['data']);
      return buildChangeQuote(payload);
    }
    // 上游成功但响应无可解析差价 → null（合法「不报价」，store 回退本地估算）；
    // 传输/鉴权/HTTP 失败则上抛（§3.1）。
    await this.authorizedPost('upgrade/upgrade_config_post', {
      ...configOptionBody(opts.selections),
      hid: encoded,
    });
    const page = await this.authorizedGet(`upgrade/upgrade_config_page?hid=${encoded}`);
    const payload = object(page['data']);
    return buildChangeQuote(payload, true);
  }

  /**
   * 同步上游转移（尽力而为）。V10 没有客户自助转移路由（主机归属只能由上游后台改），
   * 返回 null，由本平台自行完成所有权变更。
   */
  async changeOwner(
    _serviceId: string,
    _targetUserId: string,
  ): Promise<Record<string, unknown> | null> {
    // 两种协议都没有客户自助转移端点：财务返回 null，V10 无 transfer 路由。
    return null;
  }

  /* --------------------- 增值运维：服务子资源 --------------------- */

  /**
   * 列出某类子资源（磁盘/快照/备份/IP/流量包…）。
   *
   * - 财务：`provision/custom/content?key=`
   * - V10：`GET console/v1/<family>/:id/<kind>`，返回 `data.list[]`。
   *   证据：`mf_cloud/route.php:35-60`（disk/snapshot/backup/ip/flow/log）。
   * 上游成功但集合为空 → `[]`；失败则上抛（不静默转空，工单 #2 §3.1）。
   */
  async listServiceResources(
    serviceId: string,
    kind: string,
  ): Promise<Array<{ id: string; fields: Record<string, string> }>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      // 上游成功但列表为空 → []（合法「空」）；传输/鉴权/HTTP 失败则上抛（§3.1）。
      const data = await this.authorizedGet(
        `provision/custom/content?id=${encoded}&key=${encodeURIComponent(kind)}&is_api=1`,
      );
      return normalizeResourceList(data, kind);
    }
    const segment = V10_RESOURCE_SEGMENTS[kind];
    if (!segment) throw new ZJMFClientError(400, '上游不支持该资源类型');
    const family = await this.resolveFamily(serviceId);
    // `mf_dcim` 没有快照/备份/磁盘路由（只有 ip/flow/log/ip_num/common_config）；
    // 证据 `public/plugins/server/mf_dcim/route.php:31-46`。
    if (family === 'mf_dcim' && !V10_DCIM_RESOURCES.has(segment)) {
      throw new ZJMFClientError(400, '上游不支持该资源类型');
    }
    const data = await this.authorizedGet(`${this.familyBase(family)}/${encoded}/${segment}`);
    return normalizeResourceList(data, kind);
  }

  /**
   * 新建子资源。老财务走 `provision/custom/{hostId}` 且 `func` 由
   * {@link RESOURCE_CREATE_FUNC} 映射；V10 走 `console/v1/<family>/:id/<kind>`。
   */
  async createServiceResource(
    serviceId: string,
    kind: string,
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      const func = RESOURCE_CREATE_FUNC[kind];
      if (!func) throw new ZJMFClientError(400, '上游不支持该资源类型');
      // 保留字段放最后：防止调用方参数覆盖 id/func/is_api 造成动作篡改。
      return this.authorizedPost(`provision/custom/${encoded}`, {
        ...params,
        func,
        is_api: '1',
      });
    }
    const segment = V10_RESOURCE_SEGMENTS[kind];
    if (!segment) throw new ZJMFClientError(400, '上游不支持该资源类型');
    const family = await this.resolveFamily(serviceId);
    if (family === 'mf_dcim' && !V10_DCIM_RESOURCES.has(segment)) {
      throw new ZJMFClientError(400, '上游不支持该资源类型');
    }
    const base = `${this.familyBase(family)}/${encoded}/${segment}`;
    // 快照/备份创建：`POST :id/snapshot|backup`，参数 name/disk_id。
    // 证据：`mf_cloud/route.php:41,45`。
    return this.authorizedPost(base, params);
  }

  /**
   * 对某子资源执行行内动作（恢复/删除/挂载/卸载…）。
   *
   * - 财务：`provision/custom/{hostId}` + `func`（{@link RESOURCE_ACTION_FUNC}）
   * - V10：按动作映射到专用路由，证据 `mf_cloud/route.php:36-47`：
   *   `snapshot.restore → POST :id/snapshot/restore`、
   *   `snapshot.delete → DELETE :id/snapshot/:rid`、
   *   `backup.restore → POST :id/backup/restore`、
   *   `backup.delete → DELETE :id/backup/:rid`、
   *   `disk.mount → POST :id/disk/:rid/mount`、`disk.unmount → POST :id/disk/:rid/unmount`。
   */
  async runResourceAction(
    serviceId: string,
    kind: string,
    resourceId: string,
    actionId: string,
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(serviceId);
    if (this.connection.protocol === 'finance') {
      const func = RESOURCE_ACTION_FUNC[`${kind}.${actionId}`];
      if (!func) throw new ZJMFClientError(400, '上游不支持该资源动作');
      // 保留字段放最后：防止调用方参数覆盖 id/func/is_api 造成动作篡改。
      return this.authorizedPost(`provision/custom/${encoded}`, {
        ...params,
        id: resourceId,
        func,
        is_api: '1',
      });
    }
    const rule = V10_RESOURCE_ACTIONS[`${kind}.${actionId}`];
    if (!rule) throw new ZJMFClientError(400, '上游不支持该资源动作');
    const family = await this.resolveFamily(serviceId);
    const base = `${this.familyBase(family)}/${encoded}/${rule.segment}/${encodeURIComponent(resourceId)}`;
    const path = rule.suffix ? `${base}/${rule.suffix}` : base;
    if (rule.method === 'DELETE') {
      return this.authorizedRequest(path, 'DELETE', true);
    }
    return this.authorizedPost(path, params);
  }

  /** 用上游余额支付 V10 订单（`data.id` / `data.order_id`）。尽力而为，失败不阻断。 */
  private async payV10Order(order: Record<string, unknown>): Promise<void> {
    if (order['code'] === 'Paid') return;
    const payload = object(order['data']);
    const orderId =
      stringOrNull(payload['id']) ?? stringOrNull(payload['order_id']) ?? stringOrNull(order['id']);
    const amount = Number(payload['amount'] ?? payload['price'] ?? 0);
    if (!orderId || (Number.isFinite(amount) && amount <= 0)) return;
    try {
      // `credit` 只是「标记本单用余额抵扣」（`OrderTmpModel::credit`），
      // 真正扣款发生在 `pay`。余额不足时 credit 会返回 400（部分抵扣仍会写回
      // amount_unpaid），因此失败不阻断后续 pay。
      await this.authorizedPost('console/v1/credit', { id: orderId, use: '1' });
    } catch {
      // 余额不足也应继续尝试支付（部分余额 + 三方）。
    }
    try {
      // 上游已支付会回 `code=Paid`；余额不足时保持待付（由上游后台补付）。
      // 证据：`app/common/model/OrderTmpModel.php:43-130`。
      await this.authorizedPost('console/v1/pay', {
        id: orderId,
        gateway: 'credit',
      });
    } catch {
      // 支付失败不阻断开通：订单已生成，由上游后台补付。
    }
  }

  /** A failed/unknown debit must never fall back to partial credit or another debit. */
  private async applyCredit(invoiceId: string): Promise<void> {
    const payment = await this.payServiceInvoice(invoiceId);
    if (!payment.paid)
      throw new ZJMFClientError(
        409,
        `原上游账单 ${invoiceId} 付款${payment.paymentState === 'PAYMENT_UNKNOWN' ? '结果未知' : '未完成'}，禁止自动重新下单或扣款`,
      );
  }

  private async authorizedGet(path: string): Promise<Record<string, unknown>> {
    return this.authorizedRequest(path, 'GET');
  }

  private async authorizedPost(path: string, body: FormBody): Promise<Record<string, unknown>> {
    return this.authorizedRequest(path, 'POST', true, body);
  }

  private async authorizedRequest(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    retry = true,
    body?: FormBody,
  ): Promise<Record<string, unknown>> {
    const token = await this.authenticate();
    const response = await this.request(path, method, token, body);
    if (retry && method === 'GET' && (response.status === 401 || response.status === 405)) {
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
    // 证据：10.4.6/route/api.php:17 `Route::post('auth', ...)`（V10 开放 API 已取证）。
    const loginPath = this.connection.protocol === 'finance' ? '/zjmf_api_login' : '/api/v1/auth';
    const response = await this.request(loginPath, 'POST', null, {
      username: this.connection.username,
      password: this.connection.password,
    });
    if (response.status !== undefined && response.status !== 200) {
      // This is an upstream login failure, never a StackPanel session failure.
      // Preserve a stable code while keeping the HTTP status in the gateway range.
      throw new ZJMFClientError(502, '上游凭证被拒绝');
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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
    const form = body ? buildForm(body) : null;
    const startedAt = Date.now();
    const transportError = (error: unknown) => {
      const candidate = error as { name?: string; cause?: { code?: string } };
      const reason =
        candidate?.name === 'TimeoutError' || candidate?.name === 'AbortError'
          ? 'TIMEOUT'
          : [
                'ECONNRESET',
                'ECONNREFUSED',
                'ENOTFOUND',
                'EAI_AGAIN',
                'UND_ERR_CONNECT_TIMEOUT',
                'CERT_HAS_EXPIRED',
                'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
              ].includes(candidate?.cause?.code ?? '')
            ? candidate.cause!.code!
            : 'TRANSPORT_ERROR';
      // Never persist headers, credentials, query strings, response bodies or arbitrary error text.
      return new ZJMFClientError(
        502,
        `上游请求失败：${method} ${url.pathname} ${reason} (${Date.now() - startedAt}ms)`,
      );
    };
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        // '&' is an empty urlencoded form. Some finance gateways hang after applying
        // a zero-length POST; a nonzero framing body avoids losing their response.
        ...(form ? { body: form.size > 0 ? form : '&' } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw transportError(error);
    }
    // V10 的 console 路由在鉴权失败时可能直接返回 HTTP 401/404（HTML），
    // 但业务错误通常是 HTTP 200 + body.status=400。先把能解析的 body 解析出来，
    // 只有「非 2xx 且不是 JSON」才当成传输层错误。
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw transportError(error);
    }
    if (!response.ok) {
      if (method === 'GET' && [401, 405].includes(response.status))
        return { status: response.status, message: '上游鉴权失效', data: {} };
      throw new ZJMFClientError(
        response.status === 404 ? 404 : 502,
        `上游返回 HTTP ${response.status}`,
      );
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (json === null) {
      if (!response.ok) {
        throw new ZJMFClientError(
          response.status === 404 ? 404 : 502,
          `上游返回 HTTP ${response.status}`,
        );
      }
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

/**
 * Some Finance V1 deployments return `sale_total` as configuration-only amount
 * from `/cart/get_total`, while `product_sale_price` still carries the selected
 * billing-cycle base price. Treating that partial total as the whole order makes
 * a ¥72 package appear as ¥0.96. A complete quote can never be lower than its
 * non-negative package base, so recover the total from base plus option deltas.
 */
function financeCartTotal(
  products: Record<string, unknown>,
  quotedTotal: number,
  child: unknown[],
): number {
  const base =
    (safeMinor(products['product_sale_price']) ?? 0) +
    (safeMinor(products['product_sale_setup_fee']) ?? 0);
  if (base <= 0 || quotedTotal >= base) return quotedTotal;
  let optionTotal = 0;
  for (const row of child) {
    const option = object(row);
    const amount = safeMinor(option['suboption_price']) ?? 0;
    const quantity = Number(option['qty'] ?? 1);
    if (amount > 0 && Number.isSafeInteger(quantity) && quantity > 0) {
      optionTotal += amount * quantity;
    }
  }
  return base + optionTotal;
}

/**
 * 表单字段值：标量、数组或嵌套对象（数组按 `key[i]=v` 展开并支持对象元素，
 * 对象按 `key[sub]=v` 展开）。
 */
export type FormBodyValue =
  string | Array<string | Record<string, unknown>> | Record<string, unknown>;
export type FormBody = Record<string, FormBodyValue>;

/**
 * 构建 x-www-form-urlencoded 请求体。
 *
 * 上游两种风格并存：
 * - 老财务 `upgrade/...` 用扁平 `configoption[1]=x`（调用方自己拼 key）；
 * - console/v1（V10）用嵌套数组 `config_options[configoption][1]=x`，对应 PHP 的
 *   `http_build_query`。这里统一按 PHP 规则展开，避免下游多写一层编码。
 */
function buildForm(body: FormBody): URLSearchParams {
  const params = new URLSearchParams();
  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => append(`${key}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [inner, nested] of Object.entries(value)) {
        append(`${key}[${inner}]`, nested);
      }
      return;
    }
    params.append(key, String(value));
  };
  for (const [key, value] of Object.entries(body)) append(key, value);
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
  // 0 元是合法金额（降配/等价变更的差价、免费商品）。以前这里把 0 判成
  // 「超出范围」，导致每一次 0 元变配报价都抛错、静默退化成本地估算。
  if (price <= 0) return 0;
  const result = (BigInt(price) * BigInt(10_000 + markupBps) + 5_000n) / 10_000n;
  if (result > 2_000_000_000n) throw new ZJMFClientError(422, '计算后的价格超出范围');
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
    description: productDescription(raw),
    price,
    currency: stringOrNull(raw['currency_code']) ?? stringOrNull(raw['currency']),
    raw,
  };
}

/** Product detail endpoints use different description keys across ZJMF releases. */
function productDescription(raw: Record<string, unknown>): string | null {
  for (const key of ['description', 'brief', 'summary', 'intro', 'remark', 'notes']) {
    const value = stringOrNull(raw[key]);
    if (!value) continue;
    const plain = value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) return plain.slice(0, 191);
  }
  return null;
}

function serviceIdFromDetailUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /[?&]id=(\d+)/.exec(value);
  return match ? match[1]! : null;
}

function object(value: unknown): Record<string, unknown> {  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    stringOrNull(raw['product_name']) ?? stringOrNull(raw['name']) ?? stringOrNull(raw['domain']);
  const status =
    stringOrNull(raw['domainstatus']) ??
    stringOrNull(raw['status']) ??
    stringOrNull(raw['status_text']);
  const statusLabel =
    stringOrNull(raw['domainstatus_desc']) ??
    stringOrNull(raw['status_text']) ??
    stringOrNull(raw['status_label']);
  const host =
    stringOrNull(raw['ip']) ?? stringOrNull(raw['hostname']) ?? stringOrNull(raw['host']);
  const expiresAt = readExpiry(raw);
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
    productId:
      stringOrNull(raw['product_id']) ?? stringOrNull(raw['productid']) ?? stringOrNull(raw['pid']),
    name: stringOrNull(raw['domain']) ?? productName ?? `#${id}`,
    productName,
    status,
    statusLabel,
    host,
    expiresAt,
    openedAt: readOpenedAt(raw),
    amount,
    currency: stringOrNull(raw['currency_code']) ?? stringOrNull(raw['currency']),
    raw,
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

/**
 * V10 用 Unix 秒（`due_time`）表示到期时间；平台内部用 ISO 字符串。
 * 已带时区的字符串原样返回，避免破坏 finance 的旧数据。
 */
function epochToIso(value: unknown): string | null {
  if (typeof value === 'string' && /[T:-]/.test(value)) {
    const text = value.trim();
    return Number.isFinite(Date.parse(text)) ? text : null;
  }
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds < 1e12 ? seconds * 1000 : seconds;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** List and detail endpoints use different date names and seconds/milliseconds. */
function readExpiry(payload: Record<string, unknown>): string | null {
  for (const key of [
    'expiresAt',
    'due_time',
    'nextduedate',
    'expires_at',
    'expire_at',
    'due_date',
  ]) {
    const date = epochToIso(payload[key]);
    if (date) return date;
  }
  return null;
}

/** Upstream activation/registration date, never the local import date. */
function readOpenedAt(payload: Record<string, unknown>): string | null {
  for (const key of ['openedAt', 'active_time', 'activation_time', 'regdate', 'create_time']) {
    const date = epochToIso(payload[key]);
    if (date) return date;
  }
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
      const prices = normalizeChoicePrices(s['pricing']);
      const requires = normalizeChoiceRequires(s);
      choices.push({
        id: cid,
        label: name,
        ...(qtyMin !== undefined ? { qtyMin } : {}),
        ...(qtyMax !== undefined ? { qtyMax } : {}),
        ...(prices ? prices : {}),
        ...(requires ? { requires } : {}),
      });
    }
  }
  if (choices.length === 0) return null;
  const min = typeof o['qty_minimum'] === 'number' ? o['qty_minimum'] : undefined;
  const max = typeof o['qty_maximum'] === 'number' ? o['qty_maximum'] : undefined;
  const group = optionGroup(label, rawType);
  const defaultChoice =
    stringOrNull(o['default']) ??
    stringOrNull(o['default_sub']) ??
    (choices.length === 1 ? choices[0]?.id : undefined);
  const visibleWhen = normalizeOptionVisibility(o);
  return {
    id,
    label,
    type,
    ...(group ? { group } : {}),
    ...(typeof o['description'] === 'string' && o['description'] ? { help: o['description'] } : {}),
    ...(defaultChoice !== undefined ? { defaultChoice } : {}),
    ...(visibleWhen ? { visibleWhen } : {}),
    ...(typeof o['unit'] === 'string' && o['unit'] ? { unit: o['unit'] } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    choices,
  };
}

/** 从 upstream 配置项名称/类型推断逻辑分组（位置/规格/网络/镜像）。 */
function optionGroup(label: string, rawType: number): string | undefined {
  if (rawType === 12) return '位置';
  if (rawType === 5) return '镜像';
  const map: Array<[RegExp, string]> = [
    [/区域|地域|机房|数据中心|area|region|data\s*center/i, '位置'],
    [/线路|带宽|网络|带宽|ip|vpc|bw|line|network|bandwidth/i, '网络'],
    [/镜像|系统|image|os|system/i, '镜像'],
    [/cpu|核|内存|memory|ram|磁盘|硬盘|disk|容量|gpu|规格/i, '规格'],
  ];
  for (const [pattern, group] of map) {
    if (pattern.test(label)) return group;
  }
  return undefined;
}

/**
 * 把 upstream 的 `pricing` 归一化为「每周期价格 / 单一价格」。
 * 支持标量（默认周期价）或以周期为键的对象（`{ monthly: 12.3 }`）。
 */
function normalizeChoicePrices(
  pricing: unknown,
): { price?: number; prices?: Record<string, number> } | null {
  if (typeof pricing === 'number') {
    return pricing >= 0 ? { price: Math.round(pricing * 100) } : null;
  }
  if (typeof pricing === 'string') {
    const minor = safeMinor(pricing);
    return minor !== undefined && minor >= 0 ? { price: minor } : null;
  }
  if (pricing !== null && typeof pricing === 'object' && !Array.isArray(pricing)) {
    const prices: Record<string, number> = {};
    for (const [cycle, value] of Object.entries(pricing as Record<string, unknown>)) {
      const minor = typeof value === 'number' ? Math.round(value * 100) : safeMinor(value);
      if (minor !== undefined && minor >= 0) prices[cycle] = minor;
    }
    return Object.keys(prices).length > 0 ? { prices } : null;
  }
  return null;
}

/** 从子项读取层级联动（requires）：形如 `{ configoption_id: 父项id, sub_id: 父档位id }`。 */
function normalizeChoiceRequires(
  sub: Record<string, unknown>,
): Record<string, string | string[]> | undefined {
  const parentId = stringOrNull(sub['configoption_id']);
  const parentSub = stringOrNull(sub['configoption_sub_id']) ?? stringOrNull(sub['parent_sub_id']);
  if (!parentId || !parentSub) return undefined;
  return { [parentId]: parentSub };
}

/** 从配置项读取条件显隐（visibleWhen）：父项选中指定档位时本项才显示。 */
function normalizeOptionVisibility(
  option: Record<string, unknown>,
): { field: string; equals?: string; in?: string[] } | undefined {
  const parentId = stringOrNull(option['configoption_id']);
  if (!parentId) return undefined;
  const parentSub =
    stringOrNull(option['configoption_sub_id']) ?? stringOrNull(option['parent_sub_id']);
  if (!parentSub) return { field: parentId };
  return { field: parentId, equals: parentSub };
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

/**
 * V10 `chart` 响应 → 时序点。
 *
 * 证据：`10.4.6/public/plugins/server/mf_cloud/controller/home/CloudController.php`
 * `chart()` 的 `@return`：`data.list[].{time,value|total,used|read_bytes,...|in_bw,out_bw}`。
 * 每类图表的数值字段不同，这里按 type 取对应字段；取不到就返回空数组（合法「无数据」）。
 */
function normalizeChartPoints(
  payload: Record<string, unknown>,
  type: string,
): Array<{ t: number; v: number }> {
  const list = Array.isArray(payload['list'])
    ? payload['list']
    : Array.isArray(payload['data'])
      ? payload['data']
      : [];
  const fields: Record<string, string[]> = {
    cpu: ['value', 'cpu'],
    memory: ['used', 'value'],
    disk_io: ['read_bytes', 'write_bytes'],
    bw: ['in_bw', 'out_bw'],
  };
  const candidates = fields[type] ?? ['value'];
  const points: Array<{ t: number; v: number }> = [];
  for (const row of list) {
    const o = object(row);
    const t = Number(o['time'] ?? o['t'] ?? o['ts']);
    if (!Number.isFinite(t)) continue;
    let v: number | undefined;
    for (const field of candidates) {
      const raw = Number(o[field]);
      if (Number.isFinite(raw)) {
        v = raw;
        break;
      }
    }
    if (v !== undefined) points.push({ t, v });
  }
  return points;
}

/**
 * 平台运维动作 → 老财务 `/provision/default` 的 `func`。
 *
 * 证据：`10.4.6/public/plugins/reserver/mf_finance/controller/home/CloudController.php`
 * 与 `.../mf_finance_common/...` 的 `$postData`（`on`/`off`/`reboot`/`hard_off`/
 * `hard_reboot`/`vnc`/`status`/`crack_pass`/`rescue_system`/`reinstall`/`exitRescue`）。
 * 注意重置密码的 func 是 **`crack_pass`**，`reset_password` 会被上游回
 * 406「不支持的方法」——这一步之前就错在这里。
 */
const SERVICE_ACTION_FUNC: Record<string, string> = {
  power_on: 'on',
  power_off: 'off',
  reboot: 'reboot',
  hard_off: 'hard_off',
  hard_reboot: 'hard_reboot',
  terminate: 'terminate',
  reinstall: 'reinstall',
  reset_password: 'crack_pass',
  status: 'status',
  rescue: 'rescue_system',
  exit_rescue: 'exitRescue',
  vnc: 'vnc',
};

/**
 * 平台运维动作 → V10 console 路由末段（`console/v1/<family>/:id/<段>`）。
 *
 * 证据：`10.4.6/public/plugins/server/mf_cloud/route.php:94-102`、
 * `public/plugins/reserver/mf_cloud/route.php:96-107`。
 * `terminate` 在 V10 走退款/删除实例的申请流（`addon idcsmart_refund` 或后台），
 * 不属于客户自助动作，故这里显式缺失 → 客户端抛 400，由 store 侧决定降级策略。
 */
const V10_SERVICE_ACTIONS: Record<string, string> = {
  power_on: 'on',
  power_off: 'off',
  reboot: 'reboot',
  hard_off: 'hard_off',
  hard_reboot: 'hard_reboot',
  reinstall: 'reinstall',
  reset_password: 'reset_password',
  rescue: 'rescue',
  exit_rescue: 'rescue/exit',
  vnc: 'vnc',
};

/**
 * 按家族拼 V10 动作路径。各家族的动作面**不一致**，不能共用一张表：
 *
 * - `mf_cloud` / `remf_cloud`：每个动作一个末段，含 `hard_off`/`hard_reboot`/`rescue/exit`；
 *   证据 `public/plugins/server/mf_cloud/route.php:94-102`、
 *   `public/plugins/reserver/mf_cloud/route.php:93-103`。
 * - `mf_dcim`（物理机）：只有 `on/off/reboot/vnc/reset_password/rescue/reinstall`，
 *   没有 `hard_off`/`hard_reboot`/`rescue/exit`；证据 `public/plugins/server/mf_dcim/route.php:48-58`。
 * - `idcsmart_common`（通用产品）：统一走 `host/:host_id/provision/:func`，
 *   **没有 VNC**（控制台由子模块自定义）；证据
 *   `public/plugins/server/idcsmart_common/route.php:28-32`。
 *
 * 返回 null 表示该家族没有此动作（调用方抛 400，不臆造路由）。
 */
function v10ActionPath(
  family: Exclude<ZJMFV10Module, 'auto'>,
  serviceId: string,
  action: string,
): string | null {
  const encoded = encodeURIComponent(serviceId);
  if (family === 'idcsmart_common') {
    const func = V10_COMMON_PROVISION_FUNC[action];
    if (!func) return null;
    return `console/v1/idcsmart_common/host/${encoded}/provision/${func}`;
  }
  const segment = V10_SERVICE_ACTIONS[action];
  if (!segment) return null;
  if (family === 'mf_dcim' && !V10_DCIM_ACTIONS.has(segment)) return null;
  return `console/v1/${family}/${encoded}/${segment}`;
}

/** `idcsmart_common` 的 `provision/:func` 映射（`ProvisionLogic` 的方法名）。 */
const V10_COMMON_PROVISION_FUNC: Record<string, string> = {
  power_on: 'on',
  power_off: 'off',
  reboot: 'reboot',
  reinstall: 'reinstall',
  reset_password: 'crack_pass',
};

/** 物理机家族实际存在的子资源段（无 snapshot/backup/disk）。 */
const V10_DCIM_RESOURCES = new Set(['ip', 'ipv6', 'flow', 'log', 'nat_acl', 'nat_web']);

/** 物理机家族实际存在的动作末段。 */ /** 物理机家族实际存在的动作末段。 */
const V10_DCIM_ACTIONS = new Set([
  'on',
  'off',
  'reboot',
  'vnc',
  'reset_password',
  'rescue',
  'reinstall',
]);

/** 子资源类型 → 老财务 `provision/custom` 的创建 func。 */
const RESOURCE_CREATE_FUNC: Record<string, string> = {
  snapshot: 'createSnap',
  backup: 'createBackup',
};

/**
 * 子资源类型 → V10 console 路径段（`console/v1/<family>/:id/<段>`）。
 * 证据：`10.4.6/public/plugins/server/mf_cloud/route.php:35-60`。
 */
const V10_RESOURCE_SEGMENTS: Record<string, string> = {
  disk: 'disk',
  snapshot: 'snapshot',
  backup: 'backup',
  ip: 'ip',
  ipv6: 'ipv6',
  flow: 'flow',
  log: 'log',
  nat_acl: 'nat_acl',
  nat_web: 'nat_web',
  vpc_network: 'vpc_network',
};

/**
 * `子资源类型.动作` → V10 console 路由形态。
 * 证据：`10.4.6/public/plugins/server/mf_cloud/route.php:36-47`。
 */
const V10_RESOURCE_ACTIONS: Record<
  string,
  { method: 'POST' | 'DELETE'; segment: string; suffix?: string }
> = {
  'snapshot.restore': { method: 'POST', segment: 'snapshot', suffix: 'restore' },
  'snapshot.delete': { method: 'DELETE', segment: 'snapshot' },
  'backup.restore': { method: 'POST', segment: 'backup', suffix: 'restore' },
  'backup.delete': { method: 'DELETE', segment: 'backup' },
  'disk.mount': { method: 'POST', segment: 'disk', suffix: 'mount' },
  'disk.unmount': { method: 'POST', segment: 'disk', suffix: 'unmount' },
};

/**
 * `子资源类型.动作` → 老财务 `provision/custom` 的 func。
 * 与魔方 mf_cloud 站内动作一一对应（见 reserver/mf_finance CloudController）。
 */
const RESOURCE_ACTION_FUNC: Record<string, string> = {
  'snapshot.restore': 'restoreSnap',
  'snapshot.delete': 'deleteSnap',
  'backup.restore': 'restoreBackup',
  'backup.delete': 'deleteBackup',
};

/** 把结账选择映射为老财务的 `configoption[optionId]=value` 请求字段。 */
function configOptionBody(selections: Record<string, string | number> | undefined): FormBody {
  const body: FormBody = {};
  for (const [optionId, value] of Object.entries(selections ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    body[`configoption[${optionId}]`] = String(value);
  }
  return body;
}

/** 从上游响应里提取发票 ID（兼容 data.invoiceid / invoiceid / data.id）。 */
function invoiceIdOf(response: Record<string, unknown>): string | null {
  const payload = object(response['data']);
  const direct =
    stringOrNull(payload['invoiceid']) ??
    stringOrNull(response['invoiceid']) ??
    stringOrNull(payload['id']);
  return direct && direct !== '0' ? direct : null;
}

/** 从升降级试算响应里构建差价结果（老财务 `price_difference` / V10 兼容字段）。 */
/** 分 → 「¥10.19」；上游金额是元字符串，展示层统一成分。 */
function yuanText(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function buildChangeQuote(
  payload: Record<string, unknown>,
  finance = false,
): {
  price: number;
  breakdown: Array<{ label: string; value: string; price?: number }>;
  summary: string;
} | null {
  // 财务版 `upgrade/upgrade_config_page` 的权威差价在 `total`（已含上游折扣）
  // / `subtotal`（折扣前），**没有** `price_difference` 字段——按后者解析会一直
  // 拿到 null，报价静默退化成我们自己的本地估算（实测多收 ¥0.35，且丢掉上游折扣）。
  // V10 的 `common_config` 是另一套字段，靠 `finance` 开关隔离，避免把商品总价
  // 误当差价。
  const financeDiff = finance
    ? (stringOrNull(payload['total']) ?? stringOrNull(payload['subtotal']))
    : null;
  const diffText =
    financeDiff ??
    stringOrNull(payload['price_difference']) ??
    stringOrNull(payload['price']) ??
    stringOrNull(payload['amount']);
  if (diffText === null) return null;
  let price: number;
  try {
    price = decimalToMinor(diffText);
  } catch {
    // 降配差价是负数：我方不退款，按 0 元变更处理——这是合法报价，不是解析失败。
    const numeric = Number.parseFloat(diffText);
    if (!Number.isFinite(numeric) || numeric > 0) return null;
    price = 0;
  }
  const breakdown: Array<{ label: string; value: string; price?: number }> = [];
  if (finance) {
    // 财务版把「小计 / 应付」直接给了，顺手展示，用户才知道折扣从哪来。
    const subtotal = safeMinor(payload['subtotal']);
    const total = safeMinor(payload['total']);
    if (subtotal !== undefined) {
      breakdown.push({ label: '小计', value: yuanText(subtotal), price: subtotal });
    }
    if (total !== undefined && subtotal !== undefined && total !== subtotal) {
      // 展示正数优惠额，price 保留负号供对账。
      breakdown.push({ label: '上游优惠', value: yuanText(subtotal - total), price: total - subtotal });
    }
    if (total !== undefined) {
      breakdown.push({ label: '应付', value: yuanText(total), price: total });
    }
  }
  const preview = Array.isArray(payload['preview']) ? payload['preview'] : [];
  for (const row of preview) {
    const o = object(row);
    const label = stringOrNull(o['name']);
    const value = stringOrNull(o['value']);
    if (!label || !value) continue;
    const entry: { label: string; value: string; price?: number } = {
      label,
      value,
    };
    const minor = safeMinor(o['price']);
    if (minor !== undefined) entry.price = minor;
    breakdown.push(entry);
  }
  return {
    price,
    breakdown,
    summary: breakdown.map((item) => `${item.label}:${item.value}`).join(' · '),
  };
}

/** 把上游资源列表响应归一化为 `{ id, fields }`（兼容 list/data/数组多种形态）。 */
function normalizeResourceList(
  payload: Record<string, unknown>,
  _kind: string,
): Array<{ id: string; fields: Record<string, string> }> {
  const container = object(payload['data']);
  const raw = Array.isArray(payload['list'])
    ? payload['list']
    : Array.isArray(container['list'])
      ? container['list']
      : Array.isArray(payload['data'])
        ? (payload['data'] as unknown[])
        : [];
  const result: Array<{ id: string; fields: Record<string, string> }> = [];
  for (const row of raw) {
    const o = object(row);
    const id =
      stringOrNull(o['id']) ?? stringOrNull(o['snapshot_id']) ?? stringOrNull(o['backup_id']);
    if (!id) continue;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(o)) {
      if (key === 'id') continue;
      if (value === undefined || value === null || typeof value === 'object') continue;
      fields[key] = String(value);
    }
    result.push({ id, fields });
  }
  return result;
}

/** 一条监控时序（CPU/内存等），unit 为 '%' 等。 */
export interface ZJMFMetric {
  id: string;
  label: string;
  unit: string;
  points: Array<{ t: number; v: number }>;
}

/**
 * 把 `/provision/chart/:id` 的响应转成平台指标。
 *
 * 上游形状：`{ status, data: { unit, label: string[], list: Array<Array<{time,value}>> } }`，
 * `label[i]` 与 `list[i]` 一一对应（例如内存给「总量/已用」两条）。
 */
function chartToMetrics(
  id: string,
  fallbackLabel: string,
  fallbackUnit: string,
  payload: Record<string, unknown>,
): ZJMFMetric[] {
  const data = object(payload['data'] ?? payload);
  const labels = Array.isArray(data['label']) ? data['label'].map((item) => String(item)) : [];
  const rows = Array.isArray(data['list']) ? data['list'] : [];
  const unit = stringOrNull(data['unit']) ?? fallbackUnit;
  const metrics: ZJMFMetric[] = [];
  rows.forEach((row, index) => {
    if (!Array.isArray(row)) return;
    const points = row
      .map((point) => {
        const item = object(point);
        const t = parseChartTime(item['time'] ?? item['timestamp'] ?? item['date']);
        const value = Number(item['value'] ?? item['v']);
        return t !== null && Number.isFinite(value) ? { t, v: value } : null;
      })
      .filter((point): point is { t: number; v: number } => point !== null);
    if (points.length === 0) return;
    const label = labels[index] ?? (rows.length > 1 ? `${fallbackLabel} ${index + 1}` : fallbackLabel);
    metrics.push({
      id: `${id}-${labels.length > 1 ? index : 0}`,
      label,
      unit,
      points,
    });
  });
  return metrics;
}

/**
 * 解析图表时间轴。上游给的是本地时间字符串（如 `2026-10-29 13:40:00`），
 * 站点在国内，按 +08:00 解释；也兼容秒/毫秒时间戳。
 */
function parseChartTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (match) {
    const parsed = Date.parse(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
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
    ...(Array.isArray(payload['extraIps']) && payload['extraIps'].length > 0
      ? { extraIps: payload['extraIps'] }
      : {}),
    ...(stringOrNull(payload['flowLimit']) ? { flowLimit: stringOrNull(payload['flowLimit']) } : {}),
    username:
      stringOrNull(payload['username']) ??
      stringOrNull(payload['root']) ??
      stringOrNull(payload['account']),
    password: stringOrNull(payload['password']) ?? stringOrNull(payload['root_password']),
    status,
    statusLabel: stringOrNull(payload['status_text']) ?? stringOrNull(payload['statusLabel']),
    ...(readExpiry(payload) ? { expiresAt: readExpiry(payload) } : {}),
    ...(readOpenedAt(payload) ? { openedAt: readOpenedAt(payload) } : {}),
    ...((stringOrNull(payload['billing_cycle']) ??
    stringOrNull(payload['billingcycle']) ??
    stringOrNull(payload['cycle']))
      ? {
          cycle:
            stringOrNull(payload['billing_cycle']) ??
            stringOrNull(payload['billingcycle']) ??
            stringOrNull(payload['cycle']),
        }
      : {}),
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
    ['system_disk_size', 'disk'],
    ['bandwidth', 'bandwidth'],
    ['bw', 'bandwidth'],
    ['os', 'os'],
    ['os_name', 'os'],
    ['region', 'region'],
    ['datacenter', 'region'],
    ['area', 'region'],
  ];
  for (const [from, to] of map) {
    const value = payload[from];
    if (value !== undefined && value !== null) specs[to] = value;
  }
  // 财务在售主机的 `area` 形如 "DE^德国 法兰克福"：只保留可读部分。
  const area = specs['region'];
  if (typeof area === 'string' && area.includes('^'))
    specs['region'] = area.split('^').slice(1).join('^').trim();
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
