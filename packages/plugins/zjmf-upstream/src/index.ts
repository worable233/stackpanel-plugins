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
} from '@stackpanel/sdk';
import { ExtensionVersionConflict } from '@stackpanel/sdk';
import { readCheckoutConfig } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  applyMarkup,
  assertPublicUpstreamUrl,
  decimalToMinor,
  normalizeBaseUrl,
  ZJMFClient,
  ZJMFClientError,
  type ZJMFConnection,
  type ZJMFProduct,
  type ZJMFProductConfig,
} from './zjmf-client.js';
import { ZJMFProvider } from './provider.js';
import { bindContext, resetContext } from './context.js';
import {
  zjmfProductMappingModel,
  zjmfSyncRunModel,
  zjmfUpstreamModel,
  type ZjmfProductMappingData,
  type ZjmfUpstreamData,
} from './data.js';
import {
  countMappings,
  createSyncRun,
  deleteMappingsByProductId,
  findMappingByProductId,
  findMappingByUpstreamProduct,
  finishSyncRun,
  getUpstream,
  listEnabledUpstreams,
  listMappings,
  listStoreProductsByIds,
  listSyncRuns,
  listUpstreams,
  storeProductMutation,
  toMapping,
  toUpstream,
  updateMapping,
  upsertMapping,
  type UpstreamRecord,
} from './repository.js';
import { extensions, runTransaction } from './context.js';

const MAX_PRODUCTS_PER_SYNC = 5000;
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
/** A sync lock held longer than this is considered abandoned (crashed process). */
const STALE_SYNC_LOCK_MS = 30 * 60 * 1000;

/** Stable codes for upstream errors (ADR-0012). */
const UPSTREAM_ERROR_CODES: Record<string, string> = {
  '密钥存储未配置': 'zjmf.secrets_unavailable',
  '上游配置参数无效': 'zjmf.params_invalid',
  '上游 ID 无效': 'zjmf.upstream_id_invalid',
  '请求参数无效': 'validation.invalid',
  '上游不存在': 'zjmf.upstream_not_found',
  '上游正在同步，无法删除': 'zjmf.sync_in_progress',
  '上游同步正在进行中': 'zjmf.sync_in_progress',
  '上游已停用': 'zjmf.upstream_disabled',
  '上游协议无效': 'zjmf.protocol_invalid',
  '上游凭证未配置': 'zjmf.credentials_missing',
  '存储的上游凭证无效': 'zjmf.credentials_invalid',
  '商品映射不存在': 'zjmf.product_mapping_not_found',
  '目标上游商品已关联其他商品': 'zjmf.product_already_linked',
  '上游商品缺少实例标识': 'zjmf.item_missing_id',
  '上游商品缺少价格': 'zjmf.item_missing_price',
  '上游同步失败': 'zjmf.sync_failed',
  '魔方上游插件未就绪': 'zjmf.not_ready',
};

class UpstreamError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.code = UPSTREAM_ERROR_CODES[message] ?? 'zjmf.error';
  }
}

const protocolSchema = z.enum(['finance', 'v10']);
const createUpstreamSchema = z.object({
  name: z.string().trim().min(1).max(191),
  baseUrl: z.string().trim().min(1).max(191),
  protocol: protocolSchema,
  username: z.string().trim().min(1).max(191),
  password: z.string().min(1).max(191),
  currency: z.string().trim().min(1).max(8).default('CNY'),
  markupBps: z.number().int().min(0).max(100_000).default(0),
  defaultStock: z.number().int().min(1).max(1_000_000).default(1_000_000),
  syncIntervalMinutes: z.number().int().min(15).max(1_440).default(360),
});

const updateUpstreamSchema = createUpstreamSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个更新字段' })
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
class ZJMFUpstreamService {
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
        productCount: await countMappings(source.id),
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
      protocol: data.protocol,
      currency: data.currency.toUpperCase(),
      markupBps: data.markupBps,
      defaultStock: data.defaultStock,
      syncIntervalMinutes: data.syncIntervalMinutes,
      enabled: true,
      syncState: 'IDLE',
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
    return { upstream: publicSource(toUpstream(instance)), credentialsConfigured: true };
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
    if (data.currency !== undefined) next.currency = data.currency.toUpperCase();
    if (data.markupBps !== undefined) next.markupBps = data.markupBps;
    if (data.defaultStock !== undefined) next.defaultStock = data.defaultStock;
    if (data.syncIntervalMinutes !== undefined)
      next.syncIntervalMinutes = data.syncIntervalMinutes;
    const updated = await extensions().update<ZjmfUpstreamData>(zjmfUpstreamModel, id, next);
    if (data.username !== undefined && data.password !== undefined) {
      await this.setCredentials(id, { username: data.username, password: data.password });
    }
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
    const mappings = await listMappings(id);
    const productIds = mappings.map((mapping) => mapping.productId);
    if (productIds.length > 0) {
      const otherMappings = await extensions().listAll<ZjmfProductMappingData>(
        zjmfProductMappingModel,
      );
      const sharedIds = new Set(
        otherMappings
          .filter((row) => row.spec.upstreamId !== id && productIds.includes(row.spec.productId))
          .map((row) => row.spec.productId),
      );
      const orphans = productIds.filter((productId) => !sharedIds.has(productId));
      for (const productId of orphans) {
        await storeProductMutation().remove(productId).catch(() => undefined);
      }
    }
    await runTransaction(async (tx) => {
      for (const mapping of mappings) {
        await tx.extensions.delete(zjmfProductMappingModel, mapping.id);
      }
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
    const mappings = await listMappings(id);
    const products = await listStoreProductsByIds(mappings.map((mapping) => mapping.productId));
    const byId = new Map(products.map((product) => [product.id, product]));
    return {
      mappings: mappings.map((mapping) => ({
        ...mapping,
        product: byId.get(mapping.productId) ?? null,
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
   * 上游删除/替换商品后，把本地商品重新关联到替换品（re-map），
   * 并将商品状态恢复为在售，随后立即触发一次同步。
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
    const existing = await findMappingByProductId(productId);
    if (!existing) throw new UpstreamError(404, '商品映射不存在');
    const conflict = await findMappingByUpstreamProduct(upstreamId, upstreamProductId);
    if (conflict && conflict.id !== existing.id) {
      throw new UpstreamError(409, '目标上游商品已关联其他商品');
    }
    await runTransaction(async (tx) => {
      await tx.extensions.update<ZjmfProductMappingData>(zjmfProductMappingModel, existing.id, {
        ...stripMapping(existing),
        upstreamId,
        upstreamProductId,
      });
    });
    await storeProductMutation().update(productId, {
      status: 'ACTIVE',
      providerProductId: upstreamProductId,
    });
    const summary = await this.syncSource(upstreamId);
    return { remapped: true, ...summary };
  }

  private async syncDue(): Promise<void> {
    const sources = await listEnabledUpstreams();
    const now = Date.now();
    for (const source of sources) {
      const dueAt =
        source.lastAttemptAtMs ?? parseDate(source.lastSyncedAt)?.getTime() ?? 0;
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
      const summaries = listed.products.slice(0, MAX_PRODUCTS_PER_SYNC);
      const aggregate: SyncSummary = {
        created: 0,
        updated: 0,
        skipped: listed.products.length - summaries.length,
      };
      const outcomes = await mapWithConcurrency(summaries, 6, async (summary) => {
        try {
          const detail = await client.getProduct(summary.id).catch((error) => {
            this.ctx.logger.warn(
              `zjmf-upstream: detail fetch failed for ${source.id}/${summary.id}, ` +
                `falling back to list snapshot: ${messageOf(error)}`,
            );
            return summary;
          });
          return await this.upsertProduct(client, source, detail, listed.currency);
        } catch (error) {
          this.ctx.logger.warn(
            `zjmf-upstream: skipped ${source.id}/${summary.id}: ${messageOf(error)}`,
          );
          return 'skipped' as const;
        }
      });
      for (const result of outcomes) {
        aggregate[result] += 1;
      }
      if (listed.products.length <= MAX_PRODUCTS_PER_SYNC) {
        await this.markStaleProductsSoldOut(id, listed.products);
      }
      await runTransaction(async (tx) => {
        await tx.extensions.update<ZjmfUpstreamData>(zjmfUpstreamModel, id, {
          ...stripMeta(source),
          lastSyncedAt: new Date().toISOString(),
        });
      });
      await finishSyncRun(runId, { status: 'SUCCEEDED', ...aggregate });
      return aggregate;
    } catch (error) {
      await finishSyncRun(runId, {
        status: 'FAILED',
        error: messageOf(error).slice(0, 191),
      });
      if (error instanceof UpstreamError || error instanceof ZJMFClientError) throw error;
      throw new UpstreamError(502, '上游同步失败');
    }
  }

  private async upsertProduct(
    client: ZJMFClient,
    source: UpstreamRecord,
    product: ZJMFProduct,
    listedCurrency: string | null,
  ): Promise<keyof SyncSummary> {
    const sourcePrice = decimalToMinor(product.price);
    const price = applyMarkup(sourcePrice, source.markupBps);
    const currency = (product.currency ?? listedCurrency ?? source.currency).toUpperCase();
    const stock = upstreamStock(product, source.defaultStock);
    const snapshot = compactSnapshot(product);
    const mapping = await findMappingByUpstreamProduct(source.id, product.id);
    const specs = (snapshot as { specs?: Record<string, unknown> }).specs;
    const metadata: Record<string, unknown> = {
      provider: 'zjmf',
      protocol: source.protocol,
      upstreamProductId: product.id,
      sourcePrice,
      sourceCurrency: currency,
      lastSyncedAt: new Date().toISOString(),
      ...(specs && Object.keys(specs).length ? { specs } : {}),
    };

    // 可配置商品：拉取结账配置 schema 存到 metadata（首次或缺失时才拉，控制同步成本）。
    let checkoutConfig: CheckoutConfigSchema | null | undefined;
    const existingProduct = mapping ? await getStoreProductOrNull(mapping.productId) : null;
    if (!readCheckoutConfig(existingProduct?.metadata)) {
      checkoutConfig = await client
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

    if (mapping && existingProduct) {
      await storeProductMutation().update(existingProduct.id, {
        name: product.name,
        description: product.description,
        price,
        currency,
        stock,
        metadata,
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerProductId: product.id,
        // 上游重新上架时恢复在售。
        ...(existingProduct.status === 'DISCONTINUED' ? { status: 'ACTIVE' } : {}),
      });
      await updateMapping(mapping.id, {
        ...stripMapping(mapping),
        sourcePrice,
        sourceCurrency: currency,
        sourceSnapshot: snapshot,
        lastSyncedAt: new Date().toISOString(),
      });
      return 'updated';
    }

    const local = await storeProductMutation().create({
      name: product.name,
      description: product.description,
      price,
      currency,
      stock,
      status: 'ACTIVE',
      metadata,
      fulfillmentType: 'upstream_service',
      providerId: 'zjmf',
      providerProductId: product.id,
    });
    await upsertMapping({
      upstreamId: source.id,
      upstreamProductId: product.id,
      productId: local.id,
      sourcePrice,
      sourceCurrency: currency,
      sourceSnapshot: snapshot,
      lastSyncedAt: new Date().toISOString(),
    });
    return 'created';
  }

  /** Zero out local stock for products no longer listed by the upstream. */
  private async markStaleProductsSoldOut(id: string, listed: ZJMFProduct[]): Promise<void> {
    const listedIds = new Set(listed.map((product) => product.id));
    const mappings = await listMappings(id);
    const staleProductIds = mappings
      .filter((mapping) => !listedIds.has(mapping.upstreamProductId))
      .map((mapping) => mapping.productId);
    if (staleProductIds.length === 0) return;
    for (const productId of staleProductIds) {
      await storeProductMutation()
        .update(productId, { stock: 0, status: 'DISCONTINUED' })
        .catch(() => undefined);
    }
    this.ctx.logger.info(
      `zjmf-upstream: marked ${staleProductIds.length} stale product(s) as discontinued for ${id}`,
    );
  }

  private async connectionFor(source: {
    id: string;
    baseUrl: string;
    protocol: string;
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
    return {
      id: source.id,
      baseUrl: await assertPublicUpstreamUrl(source.baseUrl),
      protocol: protocol.data,
      ...credentials,
    };
  }

  private async setCredentials(id: string, credentials: Credentials): Promise<void> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new UpstreamError(503, '密钥存储未配置');
    }
    await this.ctx.secrets.set(credentialsKey(id), JSON.stringify(credentials));
  }

  /* ---------- 上游商品关联（upstream.product.source）---------- */

  private async clients(): Promise<
    Array<{ upstreamId: string; client: ZJMFClient; currency: string }>
  > {
    const sources = await listEnabledUpstreams();
    const clients: Array<{ upstreamId: string; client: ZJMFClient; currency: string }> = [];
    for (const source of sources) {
      try {
        const client = new ZJMFClient(await this.connectionFor(source));
        clients.push({ upstreamId: source.id, client, currency: source.currency });
      } catch (error) {
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
  ): UpstreamProductItem {
    return {
      id: product.id,
      name: product.name,
      price: decimalToMinor(product.price),
      currency: (product.currency ?? listedCurrency ?? sourceCurrency).toUpperCase(),
      description: product.description,
      sourceRef: upstreamId,
      status: 'ACTIVE',
    };
  }

  /** 搜索所有已启用上游的商品（商品表单「关联上游商品」选择器）。 */
  async searchUpstreamProducts(query: string, limit = 50): Promise<UpstreamProductItem[]> {
    const normalized = query.trim().toLowerCase();
    const results: UpstreamProductItem[] = [];
    for (const { upstreamId, client, currency } of await this.clients()) {
      try {
        const listed = await client.listProducts();
        for (const product of listed.products) {
          if (results.length >= limit) break;
          if (normalized && !product.name.toLowerCase().includes(normalized)) continue;
          results.push(this.toUpstreamItem(product, upstreamId, listed.currency, currency));
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
  async getUpstreamProduct(id: string): Promise<UpstreamProductItem | null> {
    for (const { upstreamId, client, currency } of await this.clients()) {
      try {
        const product = await client.getProduct(id);
        return this.toUpstreamItem(product, upstreamId, null, currency);
      } catch {
        // 该实例没有此商品，继续下一个实例。
      }
    }
    return null;
  }

  /** 建立本地商品 ↔ 上游商品映射（履约时据此定位上游实例）。 */
  async associateUpstreamProduct(input: {
    productId: string;
    item: UpstreamProductItem;
  }): Promise<void> {
    const upstreamId = input.item.sourceRef;
    if (!upstreamId) throw new UpstreamError(400, '上游商品缺少实例标识');
    if (input.item.price == null) throw new UpstreamError(400, '上游商品缺少价格');
    const price = input.item.price;
    const snapshot: Record<string, unknown> = {
      name: input.item.name,
      price,
      ...(input.item.description ? { description: input.item.description } : {}),
    };
    await upsertMapping({
      upstreamId,
      upstreamProductId: input.item.id,
      productId: input.productId,
      sourcePrice: price,
      sourceCurrency: input.item.currency ?? 'CNY',
      sourceSnapshot: snapshot,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  /** 解除本地商品的上游关联。 */
  async dissociateUpstreamProduct(productId: string): Promise<void> {
    await deleteMappingsByProductId(productId);
  }

  /** 列出所有启用上游账号下的已购服务（主机），供管理端绑定到平台账号。 */
  async listUpstreamServices(limit = 100): Promise<UpstreamServiceItem[]> {
    const results: UpstreamServiceItem[] = [];
    for (const { upstreamId, client } of await this.clients()) {
      try {
        const hosts = await client.listHosts(limit);
        for (const host of hosts) {
          results.push({
            id: host.id,
            name: host.name,
            productName: host.productName,
            status: host.status,
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

function stripMapping(mapping: ReturnType<typeof toMapping>): ZjmfProductMappingData {
  const { id: _id, ...rest } = mapping;
  return rest;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getStoreProductOrNull(id: string) {
  return listStoreProductsByIds([id]).then((rows) => rows[0] ?? null);
}

function publicSource(source: UpstreamRecord) {
  const { createdAt: _c, updatedAt: _u, ...rest } = source;
  return {
    ...rest,
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

/** 上游库存：stock_control=1 时用上游 qty（限量），否则用配置的默认库存。 */
function upstreamStock(product: ZJMFProduct, defaultStock: number): number {
  const raw = product.raw ?? {};
  if (raw['stock_control'] === 1 || raw['stock_control'] === '1') {
    const qty = Number(raw['qty']);
    if (Number.isInteger(qty) && qty >= 0) return Math.min(qty, 1_000_000);
  }
  return defaultStock;
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
      ...(option.unit ? { unit: option.unit } : {}),
      ...(option.min !== undefined ? { min: option.min } : {}),
      ...(option.max !== undefined ? { max: option.max } : {}),
      ...(option.step !== undefined ? { step: option.step } : {}),
      ...(option.required ? { required: true } : {}),
      choices: option.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.price !== undefined ? { price: choice.price } : {}),
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
    version: '0.3.0',
    description: '将魔方财务（ZJMF）V1 与 V10 上游商品同步到商店插件。',
    requires: [{ id: 'store', range: '^0.3.0' }],
    consumes: [
      { pluginId: 'store', extensionPoint: 'store.product.read', optional: false },
      { pluginId: 'store', extensionPoint: 'store.product.update', optional: false },
    ],
    permissions: ['zjmf-upstream.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['zjmf-upstream.admin'] }],
  },
  customModels: [zjmfUpstreamModel, zjmfProductMappingModel, zjmfSyncRunModel],
  routes: [
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
      get: (id) => currentService().getUpstreamProduct(id),
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
