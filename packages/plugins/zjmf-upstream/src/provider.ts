import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  FulfillmentProvider,
  PluginContext,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceAction,
  ServiceDetail,
  MetricSeries,
} from '@stackpanel/sdk';
import { randomUUID } from 'node:crypto';
import {
  applyMarkup,
  assertPublicUpstreamUrl,
  ZJMFClient,
  ZJMFClientError,
  type ZJMFConnection,
  type ZJMFMetric,
} from './zjmf-client.js';
import { findMappingByProductId, getUpstream } from './repository.js';

const CREDENTIALS_PREFIX = 'credentials.';
const SERVICE_CREDENTIALS_PREFIX = 'svc.';

class ZJMFProviderError extends Error {
  /** Alias so Fastify's error handler maps the error to an HTTP status. */
  readonly statusCode: number;
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ZJMFProviderError';
    this.statusCode = status;
  }
}

interface Credentials {
  username: string;
  password: string;
}

/** 云服务器履约提供方：对接智简魔方上游开通/详情/监控/运维动作。 */
export class ZJMFProvider implements FulfillmentProvider {
  readonly id = 'zjmf';
  readonly name = '智简魔方';
  readonly fulfillmentTypes = ['upstream_service'];

  constructor(private readonly ctx: PluginContext) {}

  /** 从已交付服务解析连接（provision 时把 upstreamId 写入 runtime）。 */
  private async resolveForService(
    service: ProviderServiceContext['service'],
  ): Promise<{ client: ZJMFClient }> {
    const runtime = (service.runtime ?? {}) as { upstreamId?: unknown };
    const upstreamId = typeof runtime.upstreamId === 'string' ? runtime.upstreamId : null;
    if (!upstreamId) {
      const mapping = await findMappingByProductId(service.productId);
      if (!mapping) throw new ZJMFProviderError(409, '服务未关联上游');
      return { client: await this.connect(mapping.upstreamId) };
    }
    return { client: await this.connect(upstreamId) };
  }

  private async connect(upstreamId: string): Promise<ZJMFClient> {
    const upstream = await getUpstream(upstreamId);
    if (!upstream || !upstream.enabled) throw new ZJMFProviderError(409, '上游不可用');
    const stored = await this.ctx.secrets.get(`${CREDENTIALS_PREFIX}${upstream.id}`);
    if (!stored) throw new ZJMFProviderError(409, '上游凭证未配置');
    let credentials: Credentials;
    try {
      credentials = JSON.parse(stored) as Credentials;
    } catch {
      throw new ZJMFProviderError(409, '上游凭证无效');
    }
    if (upstream.protocol !== 'finance' && upstream.protocol !== 'v10') {
      throw new ZJMFProviderError(409, '上游协议无效');
    }
    const baseUrl = await assertPublicUpstreamUrl(upstream.baseUrl).catch((error) => {
      if (error instanceof ZJMFClientError) throw error;
      throw new ZJMFProviderError(400, '上游地址无效');
    });
    const connection: ZJMFConnection = {
      id: upstream.id,
      baseUrl,
      protocol: upstream.protocol as 'finance' | 'v10',
      ...credentials,
    };
    return new ZJMFClient(connection);
  }

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    if (ctx.product.providerId !== this.id) {
      throw new ZJMFProviderError(409, '商品不属于智简魔方提供方');
    }
    const providerProductId = ctx.product.providerProductId;
    if (!providerProductId) throw new ZJMFProviderError(409, '商品缺少上游商品 ID');
    const { client, source } = await this.resolveForProduct(ctx.productId);
    const config = ctx.config;
    const created = await client.createService(providerProductId, {
      quantity: ctx.quantity,
      reference: `order:${ctx.orderId}`,
      ...(config?.cycle ? { cycle: config.cycle } : {}),
      ...(config?.selections ? { selections: config.selections } : {}),
    });
    let credentialsRef: string | null = null;
    if (Object.keys(created.credentials).length > 0) {
      // 写入调用方（store）传入的密钥存储，确保后续 getDetail 能从同一命名空间读取。
      credentialsRef = `${SERVICE_CREDENTIALS_PREFIX}${randomUUID()}`;
      await ctx.secrets.set(credentialsRef, JSON.stringify(created.credentials));
    }
    const upstreamId = source?.id ?? null;
    return {
      status: 'PENDING',
      providerServiceId: created.providerServiceId,
      credentialsRef,
      runtime: {
        ...created.runtime,
        upstreamId,
        status: created.runtime.status === 'PENDING_INVOICE' ? 'PENDING' : 'PROVISIONING',
      },
    };
  }

  /** 按顾客配置试算结算价格：上游 get_total（含上游客户等级折扣）+ 我方 markup。 */
  async calculateCheckoutPrice(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult> {
    const { client, source } = await this.resolveForProduct(ctx.product.id);
    if (!source) throw new ZJMFProviderError(409, '商品未关联魔方上游');
    const config = ctx.config;
    const opts: {
      cycle?: string;
      selections?: Record<string, string | number>;
      quantity?: number;
    } = { quantity: ctx.quantity };
    if (config.cycle) opts.cycle = config.cycle;
    if (config.selections && Object.keys(config.selections).length > 0) {
      opts.selections = config.selections;
    }
    const quote = await client.calculatePrice(ctx.product.providerProductId ?? '', opts);
    if (!quote) throw new ZJMFProviderError(400, '上游不支持该商品配置计价');
    const price = applyMarkup(quote.price, source.markupBps);
    return {
      price,
      renewPrice: price,
      breakdown: quote.breakdown,
      summary: quote.summary,
    };
  }

  private async resolveForProduct(
    productId: string,
  ): Promise<{ client: ZJMFClient; source: { id: string; markupBps: number } | null }> {
    const mapping = await findMappingByProductId(productId);
    if (!mapping) throw new ZJMFProviderError(409, '商品未关联智简魔方上游');
    const upstream = await getUpstream(mapping.upstreamId);
    if (!upstream || !upstream.enabled) throw new ZJMFProviderError(409, '上游不可用');
    return {
      client: await this.connect(mapping.upstreamId),
      source: { id: upstream.id, markupBps: upstream.markupBps },
    };
  }

  async getDetail(ctx: ProviderServiceContext): Promise<ServiceDetail> {
    const providerServiceId = ctx.service.providerServiceId;
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    if (!providerServiceId) {
      return {
        title: ctx.service.productName ?? (runtime['host'] as string) ?? '服务',
        status: normalizeStatus(ctx.service.status),
        fields: [],
        actions: defaultActions(),
      };
    }
    const { client } = await this.resolveForService(ctx.service);
    const detail = await client.getService(providerServiceId);
    const fields: ServiceDetail['fields'] = [];
    const ip = stringOr(detail['ip']);
    if (ip) fields.push({ label: 'IPv4 地址', value: ip, copyable: true });
    const host = stringOr(detail['host']);
    if (host && host !== ip) fields.push({ label: '主机名', value: host, copyable: true });
    const username = stringOr(detail['username']);
    if (username) fields.push({ label: 'ROOT 账户', value: username, copyable: true });
    const password = await this.readCachedPassword(ctx);
    if (password)
      fields.push({ label: 'ROOT 密码', value: password, secret: true, copyable: true });
    const specs = (detail['specs'] ?? runtime['specs']) as
      Record<string, unknown> | null | undefined;
    if (specs && typeof specs === 'object') {
      for (const [key, label] of Object.entries(SPEC_LABELS)) {
        const value = specs[key];
        if (value !== undefined && value !== null) {
          fields.push({ label, value: String(value), copyable: false });
        }
      }
    }
    const status = (detail['status'] as string) ?? (runtime['status'] as string | undefined);
    const statusLabel = stringOr(detail['statusLabel']);
    return {
      title: ctx.service.productName ?? stringOr(detail['host']) ?? '服务',
      status: normalizeStatus(status ?? ctx.service.status),
      ...(statusLabel ? { statusLabel } : {}),
      fields,
      actions: defaultActions(),
    };
  }

  private async readCachedPassword(ctx: ProviderServiceContext): Promise<string | null> {
    if (!ctx.service.credentialsRef) return null;
    const stored = await ctx.secrets.get(ctx.service.credentialsRef);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      const value = parsed['password'] ?? parsed['pass'] ?? parsed['root_password'];
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  async getMetrics(ctx: ProviderServiceContext): Promise<MetricSeries[]> {
    if (!ctx.service.providerServiceId) return [];
    const { client } = await this.resolveForService(ctx.service);
    const metrics: ZJMFMetric[] = await client.getServiceMetrics(ctx.service.providerServiceId);
    return metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      color: metric.id.includes('cpu') ? 'var(--primary)' : '#8b5cf6',
      points: metric.points,
    }));
  }

  async executeAction(actionId: string, ctx: ProviderServiceContext): Promise<void> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    if (!SUPPORTED_ACTIONS.has(actionId)) {
      throw new ZJMFProviderError(400, '不支持的运维动作');
    }
    const { client } = await this.resolveForService(ctx.service);
    await client.runServiceAction(ctx.service.providerServiceId, actionId);
  }

  async suspend(ctx: ProviderServiceContext): Promise<void> {
    await this.executeAction('power_off', ctx);
  }

  async resume(ctx: ProviderServiceContext): Promise<void> {
    await this.executeAction('power_on', ctx);
  }

  async terminate(ctx: ProviderServiceContext): Promise<void> {
    if (!ctx.service.providerServiceId) return;
    const { client } = await this.resolveForService(ctx.service);
    await client.runServiceAction(ctx.service.providerServiceId, 'terminate');
  }
}

const SPEC_LABELS: Record<string, string> = {
  cpu: 'CPU',
  memory: '内存',
  disk: '磁盘',
  bandwidth: '带宽',
  os: '操作系统',
  region: '地域',
};

const SUPPORTED_ACTIONS = new Set(['power_on', 'power_off', 'reboot', 'terminate']);

function defaultActions(): ServiceAction[] {
  return [
    { id: 'power_on', label: '开机' },
    { id: 'power_off', label: '关机' },
    { id: 'reboot', label: '重启' },
  ];
}

export function normalizeStatus(status: string): NonNullable<ServiceDetail['status']> {
  const normalized = (status ?? '').toUpperCase();
  if (normalized.includes('PROVISION')) return 'PROVISIONING';
  if (normalized.includes('TERMINAT') || normalized.includes('DELET')) return 'TERMINATED';
  if (normalized.includes('SUSPEND') || normalized.includes('OFF') || normalized.includes('SHUT'))
    return 'SUSPENDED';
  if (normalized.includes('FAIL')) return 'FAILED';
  if (normalized.includes('ACTIVE') || normalized.includes('RUNNING') || normalized.includes('ON'))
    return 'ACTIVE';
  return 'PENDING_PROVISION';
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
