import { definePlugin, EXTENSION_POINTS, PluginError } from '@stackpanel/sdk';
import type {
  CheckoutConfigSchema,
  HttpReply,
  HttpRequest,
  PluginContext,
  UpstreamProductItem,
  UpstreamProductSource,
  UpstreamServiceItem,
  UpstreamServiceSource,
  CommerceOperations,
} from '@stackpanel/sdk';
import { ExtensionVersionConflict } from '@stackpanel/sdk';
import { readCheckoutConfig } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  assertPublicUpstreamUrl,
  decimalToMinor,
  normalizeBaseUrl,
  ZJMFClient,
  ZJMFClientError,
  type ZJMFConnection,
  type ZJMFProduct,
  type ZJMFV10Module,
  type ZJMFProductConfig,
} from './zjmf-client.js';
import { ZJMFProvider, normalizeStatus } from './provider.js';
import { bindContext, resetContext } from './context.js';
import {
  zjmfSyncRunModel,
  zjmfUpstreamModel,
  provisioningJournalModel,
  provisioningCartLockModel,
  type ZjmfUpstreamData,
} from './data.js';
import {
  countBoundProducts,
  createSyncRun,
  finishSyncRun,
  getUpstream,
  listBoundProducts,
  listEnabledUpstreams,
  listSyncRuns,
  listUpstreams,
  storeProductMutation,
  toUpstream,
  type UpstreamRecord,
} from './repository.js';
import { extensions, runTransaction } from './context.js';

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
/** A sync lock held longer than this is considered abandoned (crashed process). */
const STALE_SYNC_LOCK_MS = 30 * 60 * 1000;

/** Stable codes for upstream errors (ADR-0012). */
const UPSTREAM_ERROR_CODES: Record<string, string> = {
  '尚未配置可用上游，请先在上游管理中添加并启用连接': 'zjmf.no_enabled_upstream',
  '上游凭据不可用，请检查上游连接的凭据配置': 'zjmf.credentials_unavailable',
  '上游服务获取失败，请检查连接与凭据后重试': 'zjmf.services_unavailable',
  密钥存储未配置: 'zjmf.secrets_unavailable',
  上游配置参数无效: 'zjmf.params_invalid',
  '上游 ID 无效': 'zjmf.upstream_id_invalid',
  请求参数无效: 'validation.invalid',
  上游不存在: 'zjmf.upstream_not_found',
  '上游正在同步，无法删除': 'zjmf.sync_in_progress',
  上游同步正在进行中: 'zjmf.sync_in_progress',
  上游已停用: 'zjmf.upstream_disabled',
  上游协议无效: 'zjmf.protocol_invalid',
  上游凭证未配置: 'zjmf.credentials_missing',
  存储的上游凭证无效: 'zjmf.credentials_invalid',
  商品映射不存在: 'zjmf.product_mapping_not_found',
  目标上游商品已关联其他商品: 'zjmf.product_already_linked',
  上游商品缺少实例标识: 'zjmf.item_missing_id',
  上游商品缺少价格: 'zjmf.item_missing_price',
  上游同步失败: 'zjmf.sync_failed',
  魔方上游插件未就绪: 'zjmf.not_ready',
};

class UpstreamError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    code?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code ?? UPSTREAM_ERROR_CODES[message] ?? 'zjmf.error';
  }
}

const protocolSchema = z.enum(['finance', 'v10']);
/**
 * Form/JSON 双入口：HTML checkbox 提交的是字符串 `"true"`/缺省，JSON 提交布尔值。
 * `z.boolean()` 会拒掉 `"true"`，所以这里统一归一化。
 */
const coerceBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === '') return false;
  }
  return value;
}, z.boolean());

const createUpstreamSchema = z.object({
  name: z.string().trim().min(1).max(191),
  baseUrl: z.string().trim().min(1).max(191),
  downstreamUrl: z
    .string()
    .trim()
    .max(191)
    .refine(
      (value) => !value || /^https:\/\/[^/?#]+\/?$/.test(value),
      '下游站点必须为 HTTPS 站点根地址',
    )
    .optional(),
  protocol: protocolSchema,
  username: z.string().trim().min(1).max(191),
  password: z.string().min(1).max(191),
  currency: z.string().trim().min(1).max(8).default('CNY'),
  markupBps: z.number().int().min(0).max(100_000).default(0),
  defaultStock: z.number().int().min(1).max(1_000_000).default(1_000_000),
  syncIntervalMinutes: z.number().int().min(15).max(1_440).default(360),
  /** 实验开关：允许未取证 V10 路由（默认 false）。见工单 #2 §3.3。 */
  allowUnverifiedV10Routes: coerceBoolean.default(false),
  /**
   * V10 console 路由家族。auto = 首次调用实例接口时自动探测（mf_cloud →
   * remf_cloud → mf_dcim → idcsmart_common）并缓存。
   */
  v10Module: z
    .enum(['auto', 'mf_cloud', 'remf_cloud', 'mf_dcim', 'idcsmart_common'])
    .default('auto'),
});

const updateUpstreamSchema = createUpstreamSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要一个更新字段',
  })
  .refine(
    (value) =>
      (value.username === undefined && value.password === undefined) ||
      (value.username !== undefined && value.password !== undefined),
    { message: '用户名与密码必须同时更新' },
  );

const sourceIdSchema = z.object({ id: z.string().min(1).max(191) });

interface Credentials {
  username: string;
  password: string;
}

interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
}

/** Backend service that owns all source credentials and supplier synchronization. */
export class ZJMFUpstreamService {
  constructor(private readonly ctx: PluginContext) {}

  /** 执行一轮到期同步。由内核任务 `scheduled-sync` 周期调用（集群唯一执行）。 */
  async runScheduledSync(): Promise<void> {
    await this.syncDue();
  }

  async listUpstreams(): Promise<unknown> {
    const sources = await listUpstreams();
    const rows = await Promise.all(
      sources.map(async (source) => ({
        ...publicSource(source),
        productCount: await countBoundProducts(source.id),
        credentialsConfigured: await this.ctx.secrets.get(credentialsKey(source.id)).then(Boolean),
      })),
    );
    return { upstreams: rows, secretsEnabled: this.ctx.secrets.isAvailable() };
  }

  async createUpstream(input: unknown): Promise<unknown> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new UpstreamError(503, '密钥存储未配置');
    }
    const parsed = createUpstreamSchema.safeParse(input);
    if (!parsed.success) throw new UpstreamError(400, '上游配置参数无效');
    const data = parsed.data;
    const instance = await extensions().create<ZjmfUpstreamData>(zjmfUpstreamModel, {
      name: data.name,
      baseUrl: normalizeBaseUrl(data.baseUrl),
      ...(data.downstreamUrl ? { downstreamUrl: normalizeBaseUrl(data.downstreamUrl) } : {}),
      protocol: data.protocol,
      currency: data.currency.toUpperCase(),
      markupBps: data.markupBps,
      defaultStock: data.defaultStock,
      syncIntervalMinutes: data.syncIntervalMinutes,
      enabled: true,
      syncState: 'IDLE',
      allowUnverifiedV10Routes: data.allowUnverifiedV10Routes,
      v10Module: data.v10Module,
    });
    try {
      await this.setCredentials(instance.name, {
        username: data.username,
        password: data.password,
      });
    } catch (error) {
      await extensions().delete(zjmfUpstreamModel, instance.name);
      throw error;
    }
    this.warnIfUnverifiedRoutesEnabled(instance.name, data.protocol, data.allowUnverifiedV10Routes);
    return {
      upstream: publicSource(toUpstream(instance)),
      credentialsConfigured: true,
    };
  }

  async updateUpstream(id: string, input: unknown): Promise<unknown> {
    const parsed = updateUpstreamSchema.safeParse(input);
    if (!parsed.success)
      throw new UpstreamError(400, parsed.error.issues[0]?.message ?? '请求参数无效');
    const current = await getUpstream(id);
    if (!current) throw new UpstreamError(404, '上游不存在');
    const data = parsed.data;
    const next: ZjmfUpstreamData = { ...stripMeta(current) };
    if (data.name !== undefined) next.name = data.name;
    if (data.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(data.baseUrl);
    if (data.protocol !== undefined) next.protocol = data.protocol;
    if (data.downstreamUrl !== undefined)
      next.downstreamUrl = data.downstreamUrl ? normalizeBaseUrl(data.downstreamUrl) : '';
    if (data.currency !== undefined) next.currency = data.currency.toUpperCase();
    if (data.markupBps !== undefined) next.markupBps = data.markupBps;
    if (data.defaultStock !== undefined) next.defaultStock = data.defaultStock;
    if (data.syncIntervalMinutes !== undefined) next.syncIntervalMinutes = data.syncIntervalMinutes;
    if (data.allowUnverifiedV10Routes !== undefined)
      next.allowUnverifiedV10Routes = data.allowUnverifiedV10Routes;
    if (data.v10Module !== undefined) next.v10Module = data.v10Module;
    const updated = await extensions().update<ZjmfUpstreamData>(zjmfUpstreamModel, id, next);
    if (data.username !== undefined && data.password !== undefined) {
      await this.setCredentials(id, {
        username: data.username,
        password: data.password,
      });
    }
    this.warnIfUnverifiedRoutesEnabled(
      updated.name,
      updated.spec.protocol,
      updated.spec.allowUnverifiedV10Routes,
    );
    return { upstream: publicSource(toUpstream(updated)) };
  }

  async setEnabled(id: string, enabled: boolean): Promise<unknown> {
    const current = await getUpstream(id);
    if (!current) throw new UpstreamError(404, '上游不存在');
    const updated = await extensions().update<ZjmfUpstreamData>(zjmfUpstreamModel, id, {
      ...stripMeta(current),
      enabled,
    });
    return { upstream: publicSource(toUpstream(updated)) };
  }

  async deleteUpstream(id: string): Promise<{ deleted: boolean }> {
    const upstream = await getUpstream(id);
    if (!upstream) throw new UpstreamError(404, '上游不存在');
    if (upstream.syncState === 'SYNCING') {
      throw new UpstreamError(409, '上游正在同步，无法删除');
    }
    // 商品不随上游删除：绑定信息在商品自身，删除上游只移除账号与凭据。
    // 仍绑定该账号的商品会因上游不可用而拒绝履约，由管理员重新绑定。
    await runTransaction(async (tx) => {
      await tx.extensions.delete(zjmfUpstreamModel, id);
    });
    await this.ctx.secrets.remove(credentialsKey(id)).catch(() => undefined);
    return { deleted: true };
  }

  /**
   * 触发同步并返回结果。并发控制以引擎条件更新为唯一依据：另一个实例持有未过期的锁
   * 时返回 409；陈旧锁（超过 STALE_SYNC_LOCK_MS）会被接管，失败后释放锁并把错误
   * 透传给调用方。
   */
  async sync(id: string): Promise<unknown> {
    const source = await getUpstream(id);
    if (!source) throw new UpstreamError(404, '上游不存在');
    if (!source.enabled) throw new UpstreamError(409, '上游已停用');
    const summary = await this.syncSource(source.id);
    return { upstreamId: source.id, ...summary };
  }

  async listMappings(id: string): Promise<unknown> {
    const source = await getUpstream(id);
    if (!source) throw new UpstreamError(404, '上游不存在');
    const bound = (await listBoundProducts()).filter((entry) => entry.binding.sourceRef === id);
    return {
      mappings: bound.map(({ product, binding }) => ({
        upstreamId: id,
        upstreamProductId: binding.productId,
        productId: product.id,
        sourcePrice: readSourcePrice(product.metadata),
        lastSyncedAt: readLastSyncedAt(product.metadata),
        product,
      })),
    };
  }

  async listRuns(id: string): Promise<unknown> {
    const source = await getUpstream(id);
    if (!source) throw new UpstreamError(404, '上游不存在');
    const runs = await listSyncRuns(id);
    return { runs };
  }

  /**
   * 上游删除/替换商品后，把商店商品重新指向替换品（re-map），
   * 并将商品状态恢复为在售，随后立即触发一次同步刷新成本。
   */
  async remapProduct(input: unknown): Promise<unknown> {
    const parsed = z
      .object({
        upstreamId: z.string().min(1).max(191),
        productId: z.string().min(1).max(191),
        upstreamProductId: z.string().min(1).max(191),
      })
      .safeParse(input);
    if (!parsed.success) throw new UpstreamError(400, '请求参数无效');
    const { upstreamId, productId, upstreamProductId } = parsed.data;
    const source = await getUpstream(upstreamId);
    if (!source) throw new UpstreamError(404, '上游不存在');
    const items = await listBoundProducts();
    const bound = items.find((entry) => entry.product.id === productId);
    if (!bound) throw new UpstreamError(404, '商品未绑定上游');
    const metadata = mergeBinding(bound.product.metadata, {
      sourceRef: upstreamId,
      productId: upstreamProductId,
    });
    await storeProductMutation().update(productId, {
      status: 'ACTIVE',
      providerId: 'zjmf',
      providerProductId: upstreamProductId,
      metadata,
    });
    const summary = await this.syncSource(upstreamId);
    return { remapped: true, ...summary };
  }

  private async syncDue(): Promise<void> {
    const sources = await listEnabledUpstreams();
    const now = Date.now();
    for (const source of sources) {
      const dueAt = source.lastAttemptAtMs ?? parseDate(source.lastSyncedAt)?.getTime() ?? 0;
      if (now - dueAt < source.syncIntervalMinutes * 60_000) continue;
      try {
        await this.syncSource(source.id);
      } catch (error) {
        this.ctx.logger.warn(`zjmf-upstream: ${source.id} sync failed: ${messageOf(error)}`);
      }
    }
  }

  private async syncSource(id: string): Promise<SyncSummary> {
    const acquired = await this.acquireSyncLock(id);
    if (!acquired) throw new UpstreamError(409, '上游同步正在进行中');
    try {
      return await this.syncSourceOnce(id);
    } finally {
      await this.releaseSyncLock(id);
      this.ctx.logger.info(`zjmf-upstream: released sync lock for ${id}`);
    }
  }

  /** Atomically claim the per-upstream sync lock guarded by the engine. */
  private async acquireSyncLock(id: string): Promise<boolean> {
    const now = Date.now();
    const claimed = await extensions().updateWhere(
      zjmfUpstreamModel,
      { name: { eq: id }, enabled: { eq: true }, syncState: { eq: 'IDLE' } },
      { syncState: { set: 'SYNCING' }, lastAttemptAtMs: { set: now } },
    );
    if (claimed.updated === 1) return true;
    const staleBefore = now - STALE_SYNC_LOCK_MS;
    const takenOver = await extensions()
      .updateWhere(
        zjmfUpstreamModel,
        {
          name: { eq: id },
          enabled: { eq: true },
          syncState: { eq: 'SYNCING' },
          lastAttemptAtMs: { lt: staleBefore },
        },
        { syncState: { set: 'SYNCING' }, lastAttemptAtMs: { set: now } },
      )
      .catch((error) => {
        if (error instanceof ExtensionVersionConflict) return { updated: 0 };
        throw error;
      });
    return takenOver.updated === 1;
  }

  private async releaseSyncLock(id: string): Promise<void> {
    await extensions().updateWhere(
      zjmfUpstreamModel,
      { name: { eq: id }, syncState: { eq: 'SYNCING' } },
      { syncState: { set: 'IDLE' } },
    );
  }

  private async syncSourceOnce(id: string): Promise<SyncSummary> {
    const source = await getUpstream(id);
    if (!source) throw new UpstreamError(404, '上游不存在');
    if (!source.enabled) throw new UpstreamError(409, '上游已停用');
    const runId = await createSyncRun(id);
    try {
      const client = new ZJMFClient(await this.connectionFor(source));
      const listed = await client.listProducts();
      const listedById = new Map(listed.products.map((product) => [product.id, product]));
      // 只更新已绑定商品；绝不创建商店商品（商品由管理员显式创建后绑定）。
      const bound = (await listBoundProducts()).filter(
        (entry) => entry.binding.sourceRef === source.id,
      );
      const aggregate: SyncSummary = {
        created: 0,
        updated: 0,
        skipped: 0,
      };
      await mapWithConcurrency(bound, 6, async (entry) => {
        const upstreamProductId = entry.binding.productId;
        const summary = listedById.get(upstreamProductId);
        if (!summary) {
          // 上游不再提供该商品：标记下架（保留商品与绑定，便于重新上架）。
          await storeProductMutation()
            .update(entry.product.id, { status: 'DISCONTINUED' })
            .catch(() => undefined);
          aggregate.skipped += 1;
          return;
        }
        try {
          const detail = await client.getProduct(upstreamProductId).catch(() => summary);
          await this.refreshBoundProduct(client, source, entry.product, detail, listed.currency);
          aggregate.updated += 1;
        } catch (error) {
          this.ctx.logger.warn(
            `zjmf-upstream: skipped ${source.id}/${upstreamProductId}: ${messageOf(error)}`,
          );
          aggregate.skipped += 1;
        }
      });
      await runTransaction(async (tx) => {
        await tx.extensions.update<ZjmfUpstreamData>(zjmfUpstreamModel, id, {
          ...stripMeta(source),
          lastSyncedAt: new Date().toISOString(),
        });
      });
      await finishSyncRun(runId, { status: 'SUCCEEDED', ...aggregate });
      return aggregate;
    } catch (error) {
      const displayError =
        error instanceof ZJMFClientError && error.code === 'zjmf.client.credentials_rejected'
          ? new UpstreamError(
              502,
              `同步上游“${source.name}”失败：上游拒绝登录。请检查该 ${source.protocol === 'finance' ? 'V1' : 'V10'} 上游的账号、密码和接口地址。`,
              error.code,
            )
          : error;
      await finishSyncRun(runId, {
        status: 'FAILED',
        error: messageOf(displayError).slice(0, 191),
      });
      if (displayError instanceof UpstreamError || displayError instanceof ZJMFClientError)
        throw displayError;
      throw new UpstreamError(502, '上游同步失败');
    }
  }

  /**
   * 用上游最新数据刷新一个已绑定商品：源价（成本）、库存、规格与结账配置均以
   * 上游为准；售卖价、类型、分类与介绍仍由商家维护。
   */
  private async refreshBoundProduct(
    client: ZJMFClient,
    source: UpstreamRecord,
    local: {
      id: string;
      metadata: unknown;
      providerProductId: string | null;
      stock: number;
      status: string;
    },
    product: ZJMFProduct,
    listedCurrency: string | null,
  ): Promise<void> {
    const sourcePrice = decimalToMinor(product.price);
    const currency = (product.currency ?? listedCurrency ?? source.currency).toUpperCase();
    const stock = upstreamStock(product, source.defaultStock);
    const snapshot = compactSnapshot(product);
    const specs = (snapshot as { specs?: Record<string, unknown> }).specs;

    const metadata = mergeBinding(local.metadata, {
      sourceRef: source.id,
      productId: product.id,
      sourcePrice,
      sourceCurrency: currency,
      lastSyncedAt: new Date().toISOString(),
      ...(specs && Object.keys(specs).length ? { specs } : {}),
    });

    // 可配置商品：首次（或缺失）时拉取结账配置存入 metadata，控制同步成本。
    if (!readCheckoutConfig(metadata)) {
      const checkoutConfig = await client
        .getConfig(product.id)
        .then((config) => (config ? normalizeCheckoutConfig(config) : null))
        .catch((error: unknown) => {
          this.ctx.logger.warn(
            `zjmf-upstream: config fetch failed for ${source.id}/${product.id}: ${messageOf(error)}`,
          );
          return null;
        });
      if (checkoutConfig) metadata['checkoutConfig'] = checkoutConfig;
    }

    await storeProductMutation().update(local.id, {
      metadata,
      cost: sourcePrice,
      stock,
      // 上游重新上架时恢复在售。
      ...(local.status === 'DISCONTINUED' ? { status: 'ACTIVE' } : {}),
    });
  }

  private readonly warnedUnverified = new Set<string>();

  /**
   * 实验开关开启时在日志明示「未取证路由，仅供实验」（工单 #2 §3.3）。
   * 关闭（默认）时不记录，避免噪音。同一上游只告警一次（重启后首次连接会重新告警）。
   */
  private warnIfUnverifiedRoutesEnabled(
    name: string,
    protocol: string,
    allowUnverifiedV10Routes: boolean,
  ): void {
    if (protocol !== 'v10' || !allowUnverifiedV10Routes) return;
    if (this.warnedUnverified.has(name)) return;
    this.warnedUnverified.add(name);
    this.ctx.logger.warn(
      `zjmf-upstream: upstream ${name} 已开启 allowUnverifiedV10Routes——` +
        '仍未取证的「换商品」路由仅供实验，行为以真实上游为准。',
    );
  }

  private async connectionFor(source: {
    id: string;
    baseUrl: string;
    protocol: string;
    allowUnverifiedV10Routes?: boolean;
    v10Module?: ZJMFV10Module;
  }): Promise<ZJMFConnection> {
    const stored = await this.ctx.secrets.get(credentialsKey(source.id));
    if (!stored) throw new UpstreamError(409, '上游凭证未配置');
    let credentials: Credentials;
    try {
      credentials = credentialsSchema.parse(JSON.parse(stored));
    } catch {
      throw new UpstreamError(409, '存储的上游凭证无效');
    }
    const protocol = protocolSchema.safeParse(source.protocol);
    if (!protocol.success) throw new UpstreamError(409, '上游协议无效');
    // 审计 #2 · F-1：开关可能在重启前就已落库，create/update 的告警不会重放。
    // 每次真正建立连接时补一次告警（按 upstream 去重，避免日志刷屏）。
    this.warnIfUnverifiedRoutesEnabled(
      source.id,
      protocol.data,
      source.allowUnverifiedV10Routes ?? false,
    );
    return {
      id: source.id,
      baseUrl: await assertPublicUpstreamUrl(source.baseUrl),
      protocol: protocol.data,
      ...credentials,
      allowUnverifiedV10Routes: source.allowUnverifiedV10Routes ?? false,
      v10Module: source.v10Module ?? 'auto',
    };
  }

  private async setCredentials(id: string, credentials: Credentials): Promise<void> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new UpstreamError(503, '密钥存储未配置');
    }
    await this.ctx.secrets.set(credentialsKey(id), JSON.stringify(credentials));
  }

  /* ---------- 上游商品关联（upstream.product.source）---------- */

  private async clients(
    strict = false,
  ): Promise<
    Array<{ upstreamId: string; client: ZJMFClient; currency: string; defaultStock: number }>
  > {
    const sources = await listEnabledUpstreams();
    if (strict && sources.length === 0) {
      throw new UpstreamError(409, '尚未配置可用上游，请先在上游管理中添加并启用连接');
    }
    const clients: Array<{
      upstreamId: string;
      client: ZJMFClient;
      currency: string;
      defaultStock: number;
    }> = [];
    for (const source of sources) {
      try {
        const client = new ZJMFClient(await this.connectionFor(source));
        clients.push({
          upstreamId: source.id,
          client,
          currency: source.currency,
          defaultStock: source.defaultStock,
        });
      } catch (error) {
        if (strict) throw new UpstreamError(503, '上游凭据不可用，请检查上游连接的凭据配置');
        this.ctx.logger.warn(
          `zjmf-upstream: skip upstream ${source.id} for product search: ${messageOf(error)}`,
        );
      }
    }
    return clients;
  }

  private toUpstreamItem(
    product: ZJMFProduct,
    upstreamId: string,
    listedCurrency: string | null,
    sourceCurrency: string,
    defaultStock: number,
  ): UpstreamProductItem {
    const snapshot = compactSnapshot(product);
    const specs = snapshot['specs'];
    return {
      id: product.id,
      name: product.name,
      price: decimalToMinor(product.price),
      currency: (product.currency ?? listedCurrency ?? sourceCurrency).toUpperCase(),
      description: product.description,
      stock: upstreamStock(product, defaultStock),
      ...(specs &&
      typeof specs === 'object' &&
      !Array.isArray(specs) &&
      Object.keys(specs).length > 0
        ? { specs: specs as Record<string, unknown> }
        : {}),
      sourceRef: upstreamId,
      status: 'ACTIVE',
    };
  }

  /** 搜索所有已启用上游的商品（商品表单「关联上游商品」选择器）。 */
  async searchUpstreamProducts(query: string, limit = 50): Promise<UpstreamProductItem[]> {
    const normalized = query.trim().toLowerCase();
    const results: UpstreamProductItem[] = [];
    for (const { upstreamId, client, currency, defaultStock } of await this.clients()) {
      try {
        const listed = await client.listProducts();
        const matched = listed.products.filter(
          (product) => !normalized || product.name.toLowerCase().includes(normalized),
        );
        // 魔方的列表接口通常只返回名称和价格。商品选择器需要让管理员能
        // 比较规格，因此对本次结果补齐详情；限制并发以避免压垮上游。
        const detailed = await mapWithConcurrency(
          matched.slice(0, Math.max(0, limit - results.length)),
          4,
          async (product) => client.getProduct(product.id).catch(() => product),
        );
        for (const product of detailed) {
          if (results.length >= limit) break;
          results.push(
            this.toUpstreamItem(product, upstreamId, listed.currency, currency, defaultStock),
          );
        }
      } catch (error) {
        this.ctx.logger.warn(
          `zjmf-upstream: search failed for upstream ${upstreamId}: ${messageOf(error)}`,
        );
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  /** 取单个上游商品（编辑商品时回显关联）。 */
  async getUpstreamProduct(
    id: string,
    options?: { sourceRef?: string },
  ): Promise<UpstreamProductItem | null> {
    if (options?.sourceRef) {
      const source = await getUpstream(options.sourceRef);
      if (!source || !source.enabled) return null;
      const product = await new ZJMFClient(await this.connectionFor(source)).getProduct(id);
      return this.toUpstreamItem(product, source.id, null, source.currency, source.defaultStock);
    }
    for (const { upstreamId, client, currency, defaultStock } of await this.clients()) {
      try {
        const product = await client.getProduct(id);
        return this.toUpstreamItem(product, upstreamId, null, currency, defaultStock);
      } catch {
        // 该实例没有此商品，继续下一个实例。
      }
    }
    return null;
  }

  /**
   * 取某上游商品的结账配置（周期 + 配置项），供商品表单一键填充。
   * 跨实例定位该商品；找不到或不可配置时返回 null。
   */
  async getUpstreamProductConfig(
    id: string,
    options?: { sourceRef?: string },
  ): Promise<CheckoutConfigSchema | null> {
    if (options?.sourceRef) {
      const source = await getUpstream(options.sourceRef);
      if (!source || !source.enabled) return null;
      const config = await new ZJMFClient(await this.connectionFor(source)).getConfig(id);
      return config ? normalizeCheckoutConfig(config) : null;
    }
    for (const { client } of await this.clients()) {
      try {
        const config = await client.getConfig(id);
        if (config) return normalizeCheckoutConfig(config);
        return null;
      } catch {
        // 该实例没有此商品或该协议不支持，继续下一个实例。
      }
    }
    return null;
  }

  /**
   * 商品关联上游时的副作用钩子。
   *
   * 绑定信息（实例标识/上游商品 id/源价）由 store 写入商品 metadata，zjmf 不再持有
   * 本地映射表，因此这里只需校验上游商品带实例标识；无其它持久化动作。
   */
  async associateUpstreamProduct(input: { item: UpstreamProductItem }): Promise<void> {
    if (!input.item.sourceRef) throw new UpstreamError(400, '上游商品缺少实例标识');
    if (input.item.price == null) throw new UpstreamError(400, '上游商品缺少价格');
  }

  /** 解除本地商品的上游关联（绑定在商品 metadata，无需服务端清理）。 */
  async dissociateUpstreamProduct(_productId: string): Promise<void> {
    // 绑定存在商品 metadata.upstream，由 store 负责清除；此处无副作用。
  }

  async inventory() {
    const accounts = await listUpstreams();
    const hosts: Array<UpstreamServiceItem & { openedAt: string | null }> = [];
    const errors: Array<{ sourceName: string; code: string; detail: string | null }> = [];
    for (const account of accounts) {
      try {
        const client = new ZJMFClient(await this.connectionFor(account));
        const instances = await client.listHosts();
        await mapWithConcurrency(
          instances.filter((host) => !host.expiresAt || !host.openedAt),
          4,
          async (host) => {
            try {
              const detail = await client.getService(host.id);
              if (typeof detail['expiresAt'] === 'string') host.expiresAt = detail['expiresAt'];
              if (typeof detail['openedAt'] === 'string') host.openedAt = detail['openedAt'];
            } catch {
              // ADR-0012: the server answers with a code, the UI owns the copy.
              errors.push({
                sourceName: account.name,
                code: 'zjmf.instance_detail_unavailable',
                detail: String(host.id),
              });
            }
          },
        );
        for (const host of instances)
          hosts.push({
            id: host.id,
            name: host.name,
            productId: host.productId,
            productName: host.productName,
            status: normalizeStatus(host.status ?? ''),
            statusLabel: host.statusLabel,
            host: host.host,
            expiresAt: host.expiresAt,
            openedAt: host.openedAt ?? null,
            sourceRef: account.id,
          });
      } catch {
        errors.push({
          sourceName: account.name,
          code: 'zjmf.instances_unavailable',
          detail: null,
        });
      }
    }
    const products = await listBoundProducts();
    const commerce = this.ctx.getExtensions<CommerceOperations>(EXTENSION_POINTS.commerce)[0];
    const bound = commerce ? await commerce.listBoundServices('zjmf') : null;
    return {
      errors,
      instances: hosts.map((host) => {
        const mapped = products.filter(({ binding }) => {
          return binding?.sourceRef === host.sourceRef && binding?.productId === host.productId;
        });
        const service = bound?.find(
          (item) =>
            item.providerServiceId === host.id &&
            (item.runtime as { upstreamId?: string } | null)?.upstreamId === host.sourceRef,
        );
        return {
          ...host,
          sourceName:
            accounts.find((account) => account.id === host.sourceRef)?.name ?? host.sourceRef ?? '',
          products: mapped.map(({ product }) => ({ id: product.id, name: product.name })),
          boundUserId: service?.userId ?? null,
          boundServiceId: service?.id ?? null,
          bindingKnown: bound !== null,
        };
      }),
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        enabled: account.enabled,
      })),
    };
  }

  /** 列出所有启用上游账号下的已购服务（主机），供管理端绑定到平台账号。 */
  async listUpstreamServices(limit?: number): Promise<UpstreamServiceItem[]> {
    const results: UpstreamServiceItem[] = [];
    for (const { upstreamId, client } of await this.clients(true)) {
      try {
        const hosts = await client.listHosts(limit);
        for (const host of hosts) {
          results.push({
            id: host.id,
            productId: host.productId,
            name: host.name,
            productName: host.productName,
            status: normalizeStatus(host.status ?? ''),
            statusLabel: host.statusLabel,
            host: host.host,
            expiresAt: host.expiresAt,
            amount: host.amount,
            currency: host.currency,
            sourceRef: upstreamId,
          });
        }
      } catch (error) {
        this.ctx.logger.warn(
          `zjmf-upstream: list hosts failed for upstream ${upstreamId}: ${messageOf(error)}`,
        );
        throw new UpstreamError(502, '上游服务获取失败，请检查连接与凭据后重试');
      }
    }
    return results;
  }
}

const credentialsSchema = z.object({
  username: z.string().min(1).max(191),
  password: z.string().min(1).max(191),
});

let service: ZJMFUpstreamService | null = null;

function currentService(): ZJMFUpstreamService {
  if (!service) throw new UpstreamError(503, '魔方上游插件未就绪');
  return service;
}

function credentialsKey(id: string): string {
  return `credentials.${id}`;
}

/** 去掉引擎注入的 id/时间字段，得到可写回的纯载荷。 */
function stripMeta(source: UpstreamRecord): ZjmfUpstreamData {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = source;
  return rest;
}

/**
 * 合并商品 metadata 里的 `upstream` 绑定标记（保留其余键与已有绑定字段）。
 */
function mergeBinding(
  metadata: unknown,
  patch: {
    sourceRef: string;
    productId: string;
    sourcePrice?: number;
    sourceCurrency?: string;
    lastSyncedAt?: string;
    specs?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const base =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const existing =
    base.upstream !== null && typeof base.upstream === 'object' && !Array.isArray(base.upstream)
      ? (base.upstream as Record<string, unknown>)
      : {};
  base.upstream = {
    providerId: 'zjmf',
    ...existing,
    sourceRef: patch.sourceRef,
    productId: patch.productId,
    ...(patch.sourcePrice !== undefined ? { sourcePrice: patch.sourcePrice } : {}),
    ...(patch.sourceCurrency !== undefined ? { sourceCurrency: patch.sourceCurrency } : {}),
    ...(patch.lastSyncedAt !== undefined ? { lastSyncedAt: patch.lastSyncedAt } : {}),
    ...(patch.specs && Object.keys(patch.specs).length ? { specs: patch.specs } : {}),
  };
  return base;
}

function readSourcePrice(metadata: unknown): number | null {
  const upstream = upstreamOf(metadata);
  const value = upstream?.['sourcePrice'];
  return typeof value === 'number' ? value : null;
}

function readLastSyncedAt(metadata: unknown): string | null {
  const upstream = upstreamOf(metadata);
  const value = upstream?.['lastSyncedAt'];
  return typeof value === 'string' ? value : null;
}

function upstreamOf(metadata: unknown): Record<string, unknown> | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const upstream = (metadata as Record<string, unknown>)['upstream'];
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) return null;
  return upstream as Record<string, unknown>;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicSource(source: UpstreamRecord) {
  const { createdAt: _c, updatedAt: _u, ...rest } = source;
  return {
    ...rest,
    // Records created before this field was added do not carry it in `spec`.
    // Keep the Finder contract stable while those records remain valid.
    lastSyncedAt: source.lastSyncedAt ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

/**
 * 快照：完整保留上游原始数据（含 CPU/内存/带宽等规格字段），不再丢弃。
 * `raw` 存完整原始记录，`specs` 提取常见规格，方便商品详情页类型化渲染。
 */
function compactSnapshot(product: ZJMFProduct): Record<string, unknown> {
  const raw = product.raw ?? {};
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
    const value = raw[from];
    if (value !== undefined && value !== null) specs[to] = value;
  }
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    currency: product.currency,
    specs,
    raw,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/** 上游库存：优先使用上游返回的实际库存，未启用库存控制时使用连接默认值。 */
function upstreamStock(product: ZJMFProduct, defaultStock: number): number {
  const raw = product.raw ?? {};
  const controlled = ['1', 'true', 'on'].includes(String(raw['stock_control']).toLowerCase());
  const quantity = raw['stock'] ?? raw['stock_num'] ?? raw['stock_qty'] ?? raw['qty'];
  if (controlled || quantity !== undefined) {
    const qty = Number(quantity);
    if (Number.isInteger(qty) && qty >= 0) return Math.min(qty, 1_000_000);
  }
  // Legacy records created before the minimum was enforced may carry 0. That
  // must not turn an inventory-unmanaged upstream product into a false sold-out.
  return Number.isInteger(defaultStock) && defaultStock > 0
    ? Math.min(defaultStock, 1_000_000)
    : 1_000_000;
}

/** 把上游配置（ZJMFProductConfig）归一化为平台 CheckoutConfigSchema。 */
function normalizeCheckoutConfig(config: ZJMFProductConfig): CheckoutConfigSchema {
  return {
    cycles: config.cycles.map((cycle) => ({
      id: cycle.id,
      label: cycle.label,
      price: cycle.price,
      ...(cycle.renewPrice !== undefined ? { renewPrice: cycle.renewPrice } : {}),
    })),
    options: config.options.map((option) => ({
      id: option.id,
      label: option.label,
      type: option.type,
      ...(option.group ? { group: option.group } : {}),
      ...(option.help ? { help: option.help } : {}),
      ...(option.defaultChoice ? { defaultChoice: option.defaultChoice } : {}),
      ...(option.visibleWhen ? { visibleWhen: option.visibleWhen } : {}),
      ...(option.unit ? { unit: option.unit } : {}),
      ...(option.min !== undefined ? { min: option.min } : {}),
      ...(option.max !== undefined ? { max: option.max } : {}),
      ...(option.step !== undefined ? { step: option.step } : {}),
      ...(option.required ? { required: true } : {}),
      choices: option.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.price !== undefined ? { price: choice.price } : {}),
        ...(choice.prices ? { prices: choice.prices } : {}),
        ...(choice.requires ? { requires: choice.requires } : {}),
        ...(choice.qtyMin !== undefined ? { qtyMin: choice.qtyMin } : {}),
        ...(choice.qtyMax !== undefined ? { qtyMax: choice.qtyMax } : {}),
      })),
    })),
  };
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const result: Output[] = new Array(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      result[index] = await mapper(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function handle(handler: (request: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (request: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof UpstreamError || error instanceof ZJMFClientError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export const zjmfUpstreamPlugin = definePlugin({
  manifest: {
    id: 'zjmf-upstream',
    name: '魔方上游',
    version: '0.3.9',
    description:
      '将魔方财务（ZJMF）V1 与 V10 商品作为货源接入商店：提供货源清单、配置读取与履约，不自动创建商店商品。',
    requires: [{ id: 'store', range: '^0.3.0' }],
    consumes: [
      { pluginId: 'store', extensionPoint: EXTENSION_POINTS.commerce, optional: false },
      {
        pluginId: 'store',
        extensionPoint: 'store.product.read',
        optional: false,
      },
      {
        pluginId: 'store',
        extensionPoint: 'store.product.update',
        optional: false,
      },
    ],
    permissions: ['zjmf-upstream.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['zjmf-upstream.admin'] }],
    capabilities: [
      {
        id: 'zjmf.upstreams.list',
        method: 'GET',
        route: '/zjmf-upstream/admin/upstreams',
        path: '/api/v1/zjmf/upstreams',
        summary: 'List configured ZJMF upstream accounts',
      },
      {
        id: 'zjmf.upstreams.create',
        method: 'POST',
        route: '/zjmf-upstream/admin/upstreams',
        path: '/api/v1/zjmf/upstreams',
        summary: 'Create a ZJMF upstream account',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.update',
        method: 'PATCH',
        route: '/zjmf-upstream/admin/upstreams/:id',
        path: '/api/v1/zjmf/upstreams/:id',
        summary: 'Update a ZJMF upstream account',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.enabled',
        method: 'PATCH',
        route: '/zjmf-upstream/admin/upstreams/:id/enabled',
        path: '/api/v1/zjmf/upstreams/:id/enabled',
        summary: 'Enable or disable a ZJMF upstream account',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.delete',
        method: 'DELETE',
        route: '/zjmf-upstream/admin/upstreams/:id',
        path: '/api/v1/zjmf/upstreams/:id',
        summary: 'Delete a ZJMF upstream account',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.sync',
        method: 'POST',
        route: '/zjmf-upstream/admin/upstreams/:id/sync',
        path: '/api/v1/zjmf/upstreams/:id/sync',
        summary: 'Refresh cost/stock for products bound to an upstream',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.syncByBody',
        method: 'POST',
        route: '/zjmf-upstream/admin/upstreams/sync',
        path: '/api/v1/zjmf/upstreams/sync',
        summary: 'Refresh cost/stock for products bound to an upstream (body id)',
        mutating: true,
      },
      {
        id: 'zjmf.upstreams.products',
        method: 'GET',
        route: '/zjmf-upstream/admin/upstreams/:id/products',
        path: '/api/v1/zjmf/upstreams/:id/products',
        summary: 'List store products bound to an upstream',
      },
      {
        id: 'zjmf.upstreams.syncRuns',
        method: 'GET',
        route: '/zjmf-upstream/admin/upstreams/:id/sync-runs',
        path: '/api/v1/zjmf/upstreams/:id/sync-runs',
        summary: 'List recent sync runs for an upstream',
      },
      {
        id: 'zjmf.mappings.remap',
        method: 'POST',
        route: '/zjmf-upstream/admin/mappings/remap',
        path: '/api/v1/zjmf/mappings/remap',
        summary: 'Re-point a store product to a different upstream product',
        mutating: true,
      },
    ],
  },
  customModels: [
    zjmfUpstreamModel,
    zjmfSyncRunModel,
    provisioningJournalModel,
    provisioningCartLockModel,
  ],
  routes: [
    {
      method: 'GET',
      path: '/zjmf-upstream/admin/instances',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle(() => currentService().inventory()),
    },
    {
      method: 'GET',
      path: '/zjmf-upstream/admin/upstreams',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle(() => currentService().listUpstreams()),
    },
    {
      method: 'POST',
      path: '/zjmf-upstream/admin/upstreams',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().createUpstream(request.body)),
    },
    {
      method: 'POST',
      path: '/zjmf-upstream/admin/upstreams/sync',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().sync(sourceIdFromBody(request.body))),
    },
    {
      method: 'PATCH',
      path: '/zjmf-upstream/admin/upstreams/:id',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) =>
        currentService().updateUpstream(requireSourceId(request), request.body),
      ),
    },
    {
      method: 'PATCH',
      path: '/zjmf-upstream/admin/upstreams/:id/enabled',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) =>
        currentService().setEnabled(requireSourceId(request), enabledFromBody(request.body)),
      ),
    },
    {
      method: 'POST',
      path: '/zjmf-upstream/admin/upstreams/:id/sync',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().sync(requireSourceId(request))),
    },
    {
      method: 'DELETE',
      path: '/zjmf-upstream/admin/upstreams/:id',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().deleteUpstream(requireSourceId(request))),
    },
    {
      method: 'GET',
      path: '/zjmf-upstream/admin/upstreams/:id/products',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().listMappings(requireSourceId(request))),
    },
    {
      method: 'GET',
      path: '/zjmf-upstream/admin/upstreams/:id/sync-runs',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().listRuns(requireSourceId(request))),
    },
    {
      method: 'POST',
      path: '/zjmf-upstream/admin/mappings/remap',
      auth: 'admin',
      permission: 'zjmf-upstream.admin',
      handler: handle((request) => currentService().remapProduct(request.body)),
    },
  ],
  onActivate: (ctx) => {
    bindContext(ctx);
    const instance = new ZJMFUpstreamService(ctx);
    service = instance;
    // 同步调度改为内核任务（ctx.jobs）：停用/卸载时内核按 owner 清理周期任务，
    // 不再由插件自己起 setInterval（集群下会每副本各跑一次）。
    ctx.jobs.handle('scheduled-sync', () => instance.runScheduledSync());
    ctx.jobs.schedule('scheduled-sync', { everyMs: SCHEDULER_INTERVAL_MS });
    // 激活后立即检查一轮到期同步，避免等待整个周期。
    void instance.runScheduledSync().catch((error: unknown) => {
      ctx.logger.warn(`zjmf-upstream: initial sync check failed: ${messageOf(error)}`);
    });
    ctx.registerExtension('fulfillment.provider', new ZJMFProvider(ctx));
    ctx.registerExtension<UpstreamProductSource>(EXTENSION_POINTS.upstreamProductSource, {
      id: 'zjmf',
      name: '智简魔方',
      search: (query, options) => currentService().searchUpstreamProducts(query, options?.limit),
      get: (id, options) => currentService().getUpstreamProduct(id, options),
      getConfig: (id, options) => currentService().getUpstreamProductConfig(id, options),
      associate: (input) => currentService().associateUpstreamProduct(input),
      dissociate: (productId) => currentService().dissociateUpstreamProduct(productId),
    });
    ctx.registerExtension<UpstreamServiceSource>(EXTENSION_POINTS.upstreamServiceSource, {
      id: 'zjmf',
      name: '智简魔方',
      list: (options) => currentService().listUpstreamServices(options?.limit),
    });
    ctx.logger.info('zjmf-upstream: activated');
  },
  onDeactivate: (ctx) => {
    service = null;
    resetContext();
    ctx.logger.info('zjmf-upstream: deactivated');
  },
});

function requireSourceId(request: HttpRequest): string {
  const parsed = sourceIdSchema.safeParse(request.params);
  if (!parsed.success) throw new UpstreamError(400, '上游 ID 无效');
  return parsed.data.id;
}

function enabledFromBody(value: unknown): boolean {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(value);
  if (!parsed.success) throw new UpstreamError(400, '请求参数无效');
  return parsed.data.enabled;
}

function sourceIdFromBody(value: unknown): string {
  const parsed = z.object({ sourceId: z.string().min(1).max(191) }).safeParse(value);
  if (!parsed.success) throw new UpstreamError(400, '请求参数无效');
  return parsed.data.sourceId;
}

export default zjmfUpstreamPlugin;
