import type {
  CheckoutPriceContext,
  CheckoutPriceResult,
  CheckoutSelection,
  FulfillmentProvider,
  PluginContext,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceAction,
  ServiceActionParam,
  ServiceActionResult,
  ServiceChangeInput,
  ServiceChangeOption,
  ServiceDetail,
  ServiceRenewalInput,
  ServiceResource,
  ServiceResourceKind,
  MetricSeries,
} from '@stackpanel/sdk';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { ExtensionInstance } from '@stackpanel/sdk';
import {
  provisioningJournalModel,
  provisioningCartLockModel,
  type ProvisioningJournalData,
} from './data.js';
import {
  applyMarkup,
  assertPublicUpstreamUrl,
  ZJMFClient,
  ZJMFClientError,
  type ZJMFConnection,
  type ZJMFMetric,
} from './zjmf-client.js';
import { getUpstream, readUpstreamBinding } from './repository.js';

const CREDENTIALS_PREFIX = 'credentials.';
/**
 * 购物车锁的最长持有时间。锁的存在只为串行化「清车 → 加购 → 结算」这段窗口；
 * 进程崩溃或远程失败回不来时，租约到期就应该能被下一个订单回收。
 */
const CART_LOCK_TTL_MS = 15 * 60_000;
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
  // ZJMF provisions the real cloud server behind both the legacy generic
  // upstream-service classification and the explicit cloud-server product type.
  readonly fulfillmentTypes = ['upstream_service', 'cloud_server'];

  constructor(private readonly ctx: PluginContext) {}

  /** 从已交付服务解析连接（provision 时把 upstreamId 写入 runtime）。 */
  private async resolveForService(
    service: ProviderServiceContext['service'],
  ): Promise<{ client: ZJMFClient }> {
    const runtime = (service.runtime ?? {}) as { upstreamId?: unknown };
    const upstreamId = typeof runtime.upstreamId === 'string' ? runtime.upstreamId : null;
    if (!upstreamId) throw new ZJMFProviderError(409, '服务未关联上游');
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
      // 实验开关透传（默认 false）：未取证 V10 路由默认不支持（工单 #2 §3.3）。
      allowUnverifiedV10Routes: upstream.allowUnverifiedV10Routes ?? false,
      v10Module: upstream.v10Module ?? 'auto',
    };
    return new ZJMFClient(connection);
  }

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    if (ctx.product.providerId !== this.id) {
      throw new ZJMFProviderError(409, '商品不属于智简魔方提供方');
    }
    const providerProductId = ctx.product.providerProductId;
    if (!providerProductId) throw new ZJMFProviderError(409, '商品缺少上游商品 ID');
    const {
      client,
      upstreamId,
      sourceFingerprint,
      downstreamUrl: configuredDownstreamUrl,
    } = await this.resolveForProduct(ctx.product.metadata);
    const config = ctx.config;
    const baseId = `delivery-${ctx.orderId}-${ctx.productId}`;
    const suffix = ctx.fulfillmentId?.slice(baseId.length);
    if (
      ctx.fulfillmentId &&
      (!ctx.fulfillmentId.startsWith(baseId) || (suffix && !/^-unit-([2-9]\d*|1\d+)$/.test(suffix)))
    )
      throw new ZJMFProviderError(409, '履约标识与订单商品不匹配');
    const unit = suffix?.slice('-unit-'.length);
    const generation = ctx.recoveryGeneration ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new ZJMFProviderError(409, '无效的重开代次');
    const reference = `order:${ctx.orderId}:product:${ctx.productId}${unit ? `:unit:${unit}` : ''}${generation ? `:recovery:${generation}` : ''}`;
    // Preserve the original fence for the first unit and all legacy orders.
    const journalId = createHash('sha256')
      .update(
        JSON.stringify([
          upstreamId,
          ctx.orderId,
          ctx.productId,
          ...(unit ? [unit] : []),
          ...(generation ? [`recovery:${generation}`] : []),
        ]),
      )
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          ctx.userId,
          providerProductId,
          ctx.quantity,
          config?.cycle ?? 'monthly',
          Object.entries(config?.selections ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest('hex');
    let previous = await this.ctx.extensions.get<ProvisioningJournalData>(
      provisioningJournalModel,
      journalId,
    );
    if (previous && !previous.spec.providerServiceId) {
      // 没有实例 id 不等于上游什么都没做。每次重试前先做一次**只读**反查：
      // 若账单能定位到实例，就把实例 id 补回记录，让重试走「恢复已存在实例」
      // 而不是重新下单（重新下单会真的多买一台）。
      const outcome = await this.repairFromInvoice(client, previous, journalId);
      if (outcome === 'no-trace') {
        // 上游证明那次尝试没留下任何账单：删掉死钉子，本次按全新下单处理。
        await this.ctx.extensions.delete(provisioningJournalModel, journalId);
        previous = null;
      } else if (outcome === 'repaired') {
        previous = await this.ctx.extensions.get<ProvisioningJournalData>(
          provisioningJournalModel,
          journalId,
        );
      }
    }
    if (previous) {
      if (previous.spec.sourceFingerprint && previous.spec.sourceFingerprint !== sourceFingerprint)
        throw new ZJMFProviderError(409, '上游账号或地址已变更，禁止处理原账单');
      if (previous.spec.fingerprint !== fingerprint)
        throw new ZJMFProviderError(409, '同一订单的上游配置已变更，禁止重新下单');
      if (!previous.spec.providerServiceId)
        throw new ZJMFProviderError(409, '该订单已发送上游请求，结果未确认，禁止重复下单');
      // 记录的实例 id 可能已被上游换掉（下单时是占位 id）：找不到就按账单/时间窗重定位，
      // 否则 store 会拿着不存在的 id 同步状态，永远卡在 PROVISIONING。
      if (!(await client.findHost(previous.spec.providerServiceId))) {
        const resolved = await client.resolveHostForAttempt({
          invoiceId: previous.spec.invoiceId,
          sinceMs:
            previous.createdAt instanceof Date
              ? previous.createdAt.getTime()
              : Date.now() - 900_000,
        });
        const corrected = resolved ? resolved.id : null;
        if (!corrected)
          throw new ZJMFProviderError(
            409,
            '记录的实例在上游不存在，且无法按账单重新定位；请人工核对',
          );
        previous = await this.ctx.extensions.update(
          provisioningJournalModel,
          journalId,
          { ...previous.spec, providerServiceId: corrected, invoiceId: previous.spec.invoiceId },
          { expectedVersion: previous.version },
        );
      }
      if (
        !ctx.resumePayment &&
        previous.spec.invoiceId &&
        ['ORDER_CREATED', 'PAYMENT_REQUIRED'].includes(previous.spec.state)
      ) {
        // 账单已定位但未付：自动续付，而不是让人去点「继续付款」。
        // 先只读确认账单仍未付——单张账单只扣一次，重复进入不会多付。
        const trace = await client.inspectInvoice(previous.spec.invoiceId);
        if (trace === null)
          throw new ZJMFProviderError(409, '无法确认原账单状态，稍后自动重试');
        if (trace.cancelled)
          throw new ZJMFProviderError(
            409,
            `上游账单 ${previous.spec.invoiceId} 已取消，禁止付款`,
          );
        if (!trace.paid) return this.provision({ ...ctx, resumePayment: true });
      }
      if (ctx.resumePayment) {
        if (
          !previous.spec.invoiceId ||
          !['ORDER_CREATED', 'PAYMENT_REQUIRED'].includes(previous.spec.state)
        )
          throw new ZJMFProviderError(409, '付款结果未确认或不可重试，请先核对原账单');
        // CAS is committed BEFORE debit. A crash/timeout remains fenced, never auto-replayed.
        await this.ctx.extensions.update(
          provisioningJournalModel,
          journalId,
          {
            ...previous.spec,
            state: 'PAYMENT_IN_FLIGHT',
            runtime: { ...previous.spec.runtime, paymentState: 'PAYMENT_IN_FLIGHT' },
          },
          { expectedVersion: previous.version },
        );
        await ctx.checkpoint?.({
          status: 'PENDING',
          providerServiceId: previous.spec.providerServiceId,
          runtime: {
            ...previous.spec.runtime,
            upstreamId,
            paid: false,
            paymentState: 'PAYMENT_IN_FLIGHT',
          },
        });
        const payment = await client.payServiceInvoice(previous.spec.invoiceId);
        const runtime = {
          ...previous.spec.runtime,
          ...payment,
          upstreamId,
          status: payment.paid ? 'PROVISIONING' : 'PENDING_INVOICE',
        };
        const current = await this.ctx.extensions.get<ProvisioningJournalData>(
          provisioningJournalModel,
          journalId,
        );
        if (!current) throw new ZJMFProviderError(409, '上游订单记录丢失');
        await this.ctx.extensions.update(
          provisioningJournalModel,
          journalId,
          { ...current.spec, state: payment.paymentState, runtime },
          { expectedVersion: current.version },
        );
        await ctx.checkpoint?.({
          status: 'PENDING',
          providerServiceId: previous.spec.providerServiceId,
          runtime,
        });
        return { status: 'PENDING', providerServiceId: previous.spec.providerServiceId, runtime };
      }
      // Replaying provision only restores the recorded identity, never creates/pays again.
      const runtime = { ...previous.spec.runtime, upstreamId };
      await ctx.checkpoint?.({
        status: 'PENDING',
        providerServiceId: previous.spec.providerServiceId,
        runtime,
      });
      return { status: 'PENDING', providerServiceId: previous.spec.providerServiceId, runtime };
    }
    if (ctx.resumePayment)
      throw new ZJMFProviderError(409, '缺少原上游订单记录，禁止以付款恢复创建新订单');
    const recoveryEvidence = generation ? await this.verifyCancelledProvision(ctx) : null;
    const downstreamUrl = configuredDownstreamUrl
      ? await assertPublicUpstreamUrl(configuredDownstreamUrl)
      : null;
    const downstreamSecret = `ds.${journalId.slice(0, 60)}`;
    if (ctx.quantity !== 1)
      throw new ZJMFProviderError(
        409,
        '上游实例必须逐台交付；旧批量任务需要核对，禁止直接重新下单',
      );
    const acquire = async () => {
      await this.ctx.tx(async (tx) => {
        if (recoveryEvidence) {
          const lock = await tx.extensions.get<{ reference: string }>(
            provisioningCartLockModel,
            upstreamId,
          );
          if (
            lock &&
            recoveryEvidence.requests.some((request) => request.reference === lock.spec.reference)
          ) {
            await tx.extensions.update(provisioningCartLockModel, upstreamId, lock.spec, {
              expectedVersion: lock.version,
            });
            await tx.extensions.delete(provisioningCartLockModel, upstreamId);
          }
        }
        // Persistent account-wide lock: cart operations cannot interleave across processes.
        await tx.extensions.create(
          provisioningCartLockModel,
          { reference, acquiredAtMs: Date.now() },
          { name: upstreamId },
        );
        await tx.extensions.create<ProvisioningJournalData>(
          provisioningJournalModel,
          {
            upstreamId,
            reference,
            fingerprint,
            state: 'SUBMITTING',
            providerServiceId: null,
            invoiceId: null,
            runtime: {},
            ...(sourceFingerprint ? { sourceFingerprint } : {}),
          },
          { name: journalId },
        );
        if (downstreamUrl)
          await this.ctx.secrets.set(downstreamSecret, randomBytes(16).toString('hex'));
      });
    };
    const cartBusy = () => {
      const error = new ZJMFProviderError(409, '上游购物车正在处理其他订单，请稍后重试');
      Object.assign(error, { retryableBeforeSubmit: true });
      return error;
    };
    try {
      await acquire();
    } catch {
      // No remote request has been issued by this invocation. Do not hide an existing request.
      if (await this.ctx.extensions.get(provisioningJournalModel, journalId)) {
        throw new ZJMFProviderError(409, '该订单已有开通请求，禁止重复执行');
      }
      // 账户级锁必须可回收：失败的尝试不会再回来放锁，没有租约就是一次失败枪决整个上游。
      if (!(await this.reclaimStaleCartLock(upstreamId))) throw cartBusy();
      try {
        await acquire();
      } catch {
        throw cartBusy();
      }
    }
    const checkpoint = async (service: {
      providerServiceId: string;
      runtime: Record<string, unknown>;
    }) => {
      const row = await this.ctx.extensions.get<ProvisioningJournalData>(
        provisioningJournalModel,
        journalId,
      );
      if (!row) throw new ZJMFProviderError(409, '上游订单记录丢失，禁止继续付款');
      const runtime: Record<string, unknown> = { ...service.runtime, upstreamId };
      await this.ctx.extensions.update(
        provisioningJournalModel,
        journalId,
        {
          ...row.spec,
          state: String(runtime.paymentState ?? 'ORDER_CREATED'),
          providerServiceId: service.providerServiceId,
          invoiceId: typeof runtime.invoiceId === 'string' ? runtime.invoiceId : null,
          runtime,
        },
        { expectedVersion: row.version },
      );
      // Settlement finished and identity is durable. Payment does not use the cart.
      // Release only our own lock, even when another order has since acquired it.
      await this.ctx.tx(async (tx) => {
        const lock = await tx.extensions.get<{ reference: string }>(
          provisioningCartLockModel,
          upstreamId,
        );
        if (lock?.spec.reference !== reference) return;
        await tx.extensions.update(provisioningCartLockModel, upstreamId, lock.spec, {
          expectedVersion: lock.version,
        });
        await tx.extensions.delete(provisioningCartLockModel, upstreamId);
      });
      await ctx.checkpoint?.({
        status: 'PENDING',
        providerServiceId: service.providerServiceId,
        runtime,
      });
    };
    const created = await (async () => {
      try {
        return await client.createService(providerProductId, {
      quantity: ctx.quantity,
      reference,
      checkpoint,
      ...(downstreamUrl
        ? {
            downstream: {
              url: downstreamUrl,
              id: String(Number.parseInt(journalId.slice(0, 12), 16)),
              token: (await this.ctx.secrets.get(downstreamSecret))!,
            },
          }
        : {}),
      ...(config?.cycle ? { cycle: config.cycle } : {}),
      ...(config?.selections ? { selections: config.selections } : {}),
        });
      } catch (error) {
        // 账单已定位但实例未建立：把账单号落进记录，下一次重试就能只读反查并续做，
        // 而不是永久卡在「结果未确认」。
        const evidence = (error as { evidence?: { invoiceId?: unknown } }).evidence;
        const invoiceId = evidence?.invoiceId;
        if (typeof invoiceId === 'string' && invoiceId) {
          const row = await this.ctx.extensions.get<ProvisioningJournalData>(
            provisioningJournalModel,
            journalId,
          );
          if (row) {
            await this.ctx.extensions.update(
              provisioningJournalModel,
              journalId,
              {
                ...row.spec,
                state: 'REQUIRES_RECONCILIATION',
                invoiceId,
                runtime: { ...row.spec.runtime, invoiceId },
              },
              { expectedVersion: row.version },
            );
          }
        }
        // 我们持有锁：任何失败都必须在离开前放锁，否则整个上游账户会被永久锁死。
        await this.releaseCartLock(upstreamId, reference);
        throw error;
      }
    })();
    await checkpoint(created);    let credentialsRef: string | null = null;
    if (Object.keys(created.credentials).length > 0) {
      // 写入调用方（store）传入的密钥存储，确保后续 getDetail 能从同一命名空间读取。
      credentialsRef = `${SERVICE_CREDENTIALS_PREFIX}${randomUUID()}`;
      await ctx.secrets.set(credentialsRef, JSON.stringify(created.credentials));
    }
    return {
      status: 'PENDING',
      providerServiceId: created.providerServiceId,
      credentialsRef,
      runtime: {
        ...created.runtime,
        upstreamId,
        status: created.runtime.status === 'PENDING_INVOICE' ? 'PENDING_INVOICE' : 'PROVISIONING',
      },
    };
  }

  /**
   * 回收租约过期的购物车锁。
   *
   * 老版本的锁没有 `acquiredAtMs`，一律视为过期：否则升级后仍会被历史死锁卡住。
   */
  private async reclaimStaleCartLock(upstreamId: string): Promise<boolean> {
    type LockSpec = { reference: string; acquiredAtMs?: number };
    const lock = await this.ctx.extensions.get<LockSpec>(provisioningCartLockModel, upstreamId);
    if (!lock) return false;
    const acquiredAtMs =
      typeof lock.spec.acquiredAtMs === 'number' ? lock.spec.acquiredAtMs : 0;
    if (acquiredAtMs > 0 && Date.now() - acquiredAtMs < CART_LOCK_TTL_MS) return false;
    await this.ctx.tx(async (tx) => {
      const current = await tx.extensions.get<LockSpec>(provisioningCartLockModel, upstreamId);
      if (!current || current.version !== lock.version) return;
      await tx.extensions.update(provisioningCartLockModel, upstreamId, current.spec, {
        expectedVersion: current.version,
      });
      await tx.extensions.delete(provisioningCartLockModel, upstreamId);
    });
    return true;
  }

  /** 只放自己的锁；放锁失败不影响交付结论（租约到期后仍会被回收）。 */
  private async releaseCartLock(upstreamId: string, reference: string): Promise<void> {
    try {
      await this.ctx.tx(async (tx) => {
        const lock = await tx.extensions.get<{ reference: string }>(
          provisioningCartLockModel,
          upstreamId,
        );
        if (!lock || lock.spec.reference !== reference) return;
        await tx.extensions.update(provisioningCartLockModel, upstreamId, lock.spec, {
          expectedVersion: lock.version,
        });
        await tx.extensions.delete(provisioningCartLockModel, upstreamId);
      });
    } catch {
      // 忽略：锁的租约保证不会永久占用。
    }
  }

  /**
   * 只读修复：从已落库的账单反查实例 id。不付款、不建资源、不下单。
   * 返回 true 表示记录已补齐，重试可以走「恢复已存在实例」而不是重新下单。
   */
  private async repairFromInvoice(
    client: ZJMFClient,
    row: ExtensionInstance<ProvisioningJournalData>,
    journalId: string,
  ): Promise<'repaired' | 'no-trace' | 'unknown'> {
    let invoiceId = row.spec.invoiceId;
    if (!invoiceId) {
      // 记录里没有账单号：按本次尝试的时间窗去上游找。找不到＝上游确实没留下任何东西，
      // 这种「确认没有」是唯一允许重新下单的前提。
      const sinceMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.now() - 900_000;
      const recent = await client.listRecentInvoices({ sinceMs, limit: 20 });
      if (recent === null) return 'unknown';
      const inWindow = recent.filter(
        (invoice) => invoice.createdMs === null || invoice.createdMs >= sinceMs - 120_000,
      );
      if (inWindow.length === 0) return 'no-trace';
      if (inWindow.length > 1) return 'unknown';
      invoiceId = inWindow[0]!.id;
    }
    const trace = await client.inspectInvoice(invoiceId);
    // 主机以会员主机列表为准：账单 rel_id 是占位 id，付款后上游会换成真实主机。
    const sinceMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.now() - 900_000;
    const host = await client.resolveHostForAttempt({ invoiceId, sinceMs });
    const providerServiceId = host ? host.id : null;
    if (!providerServiceId || !trace) return 'unknown';
    await this.ctx.extensions.update(
      provisioningJournalModel,
      journalId,
      {
        ...row.spec,
        state: trace.paid ? 'PAID' : 'ORDER_CREATED',
        providerServiceId,
        invoiceId,
        runtime: {
          ...row.spec.runtime,
          invoiceId,
          paid: trace.paid,
          paymentState: trace.paid ? 'PAID' : 'PAYMENT_REQUIRED',
        },
      },
      { expectedVersion: row.version },
    );
    return 'repaired';
  }

  async verifyCancelledProvision(ctx: ProvisionContext) {    const { client, upstreamId, sourceFingerprint } = await this.resolveForProduct(
      ctx.product.metadata,
    );
    const generation = ctx.recoveryGeneration ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 100)
      throw new ZJMFProviderError(409, '无效的重开代次');
    const baseId = `delivery-${ctx.orderId}-${ctx.productId}`;
    const suffix = ctx.fulfillmentId?.slice(baseId.length);
    if (
      ctx.fulfillmentId &&
      (!ctx.fulfillmentId.startsWith(baseId) || (suffix && !/^-unit-([2-9]\d*|1\d+)$/.test(suffix)))
    )
      throw new ZJMFProviderError(409, '履约标识不匹配');
    const unit = suffix?.slice('-unit-'.length);
    const requests: Array<{ reference: string; invoiceId: string; serviceIds: string[] }> = [];
    for (let i = 0; i < generation; i++) {
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            upstreamId,
            ctx.orderId,
            ctx.productId,
            ...(unit ? [unit] : []),
            ...(i ? [`recovery:${i}`] : []),
          ]),
        )
        .digest('hex');
      const row = await this.ctx.extensions.get<ProvisioningJournalData>(
        provisioningJournalModel,
        key,
      );
      if (!row?.spec.invoiceId || !row.spec.providerServiceId || row.spec.upstreamId !== upstreamId)
        throw new ZJMFProviderError(409, '缺少原请求的持久化账单证据，禁止通过人工声明重开');
      if (!sourceFingerprint || row.spec.sourceFingerprint !== sourceFingerprint)
        throw new ZJMFProviderError(
          409,
          '原上游账号身份缺少凭据或已变更，禁止核验其他账号的同号账单',
        );
      if (row.spec.runtime.paid === true || row.spec.state === 'PAID')
        throw new ZJMFProviderError(409, '原请求曾确认付款，禁止按未付款订单重新开通');
      const ids = Array.isArray(row.spec.runtime.providerServiceIds)
        ? row.spec.runtime.providerServiceIds.map(String)
        : [row.spec.providerServiceId];
      await client.verifyCancelledInvoice(row.spec.invoiceId, ids);
      requests.push({
        reference: row.spec.reference,
        invoiceId: row.spec.invoiceId,
        serviceIds: ids,
      });
    }
    return { sourceId: upstreamId, checkedAt: new Date().toISOString(), requests };
  }

  /** 按顾客配置试算结算价格：上游 get_total（含上游客户等级折扣）+ 我方 markup。 */
  async calculateCheckoutPrice(ctx: CheckoutPriceContext): Promise<CheckoutPriceResult> {
    const { client, markupBps } = await this.resolveForProduct(ctx.product.metadata);
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
    const price = applyMarkup(quote.price, markupBps);
    return {
      price,
      renewPrice: price,
      breakdown: quote.breakdown,
      summary: quote.summary,
    };
  }

  /**
   * 从商品 metadata 解析上游连接。绑定（含实例标识）由 store 写入
   * `metadata.upstream`，zjmf 不再持有本地映射表。
   */
  private async resolveForProduct(metadata: unknown): Promise<{
    client: ZJMFClient;
    upstreamId: string;
    markupBps: number;
    downstreamUrl?: string;
    sourceFingerprint?: string;
  }> {
    const binding = readUpstreamBinding(metadata);
    if (!binding || !binding.sourceRef) throw new ZJMFProviderError(409, '商品未关联智简魔方上游');
    const upstream = await getUpstream(binding.sourceRef);
    if (!upstream || !upstream.enabled) throw new ZJMFProviderError(409, '上游不可用');
    return {
      client: await this.connect(binding.sourceRef),
      upstreamId: upstream.id,
      markupBps: upstream.markupBps,
      sourceFingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            upstream.baseUrl,
            upstream.protocol,
            await this.ctx.secrets.get(`${CREDENTIALS_PREFIX}${upstream.id}`),
          ]),
        )
        .digest('hex'),
      ...(upstream.downstreamUrl ? { downstreamUrl: upstream.downstreamUrl } : {}),
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
        actions: defaultActions(undefined),
      };
    }
    const { client } = await this.resolveForService(ctx.service);
    const detail = await client.getService(providerServiceId);
    const fields: ServiceDetail['fields'] = [];
    const ip = stringOr(detail['ip']);
    if (ip) fields.push({ label: 'IPv4 地址', value: ip, copyable: true });
    // 追加 IP（升配买的独立 IP）在列表页/详情页都要能看到。
    const extraIps = Array.isArray(detail['extraIps'])
      ? detail['extraIps'].filter((value): value is string => typeof value === 'string')
      : [];
    const flowLimit = stringOr(detail['flowLimit']);
    if (flowLimit) fields.push({ label: '流量额度', value: flowLimit, copyable: false });
    extraIps.forEach((value, index) => {
      fields.push({
        label: extraIps.length > 1 ? `附加 IP ${index + 1}` : '附加 IP',
        value,
        copyable: true,
      });
    });
    const host = stringOr(detail['host']);
    if (host && host !== ip) fields.push({ label: '主机名', value: host, copyable: true });
    const username = stringOr(detail['username']);
    if (username) fields.push({ label: 'ROOT 账户', value: username, copyable: true });
    const password = await this.readCachedPassword(ctx);
    if (password)
      fields.push({
        label: 'ROOT 密码',
        value: password,
        secret: true,
        copyable: true,
      });
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
    const powerState = normalizePowerState(status ?? '');
    if (powerState !== 'UNKNOWN') {
      fields.push({ label: '电源状态', value: powerState === 'ON' ? '已开机' : '已关机' });
    }
    // 只在**已进入救援**时提示：救援系统里 IP 与系统都会变，用户不知道就会以为
    // 机器坏了。多一次约 200ms 的上游调用，失败静默忽略（不拖垮详情）。
    const remoteInfo = await client.getRemoteInfo(providerServiceId).catch(() => null);
    if (remoteInfo?.rescue) {
      fields.push({ label: '救援模式', value: '已进入（点「退出救援」回到正常系统）' });
    }
    return {
      title: ctx.service.productName ?? stringOr(detail['host']) ?? '服务',
      provisionedAt: stringOr(detail['openedAt']) ?? null,
      expiresAt: stringOr(detail['expiresAt']) ?? null,
      status: normalizeStatus(status ?? ctx.service.status),
      ...(statusLabel ? { statusLabel } : {}),
      fields,
      actions: defaultActions(client.protocol, await this.loadOsChoices(client, detail)),
    };
  }

  /**
   * 重装可选的操作系统列表。
   *
   * 上游主机详情不带「可选系统」清单（`options.os` 只有当前值），但带 `pid`
   * （上游商品 id），而 `/cart/set_config?pid=` 的配置项里就有「操作系统」这一项
   * 及其全部档位。档位 id 正是 `reinstall` 需要的 `os`。
   * 拿不到就退化成文本输入，不给假的下拉。
   */
  private async loadOsChoices(
    client: ZJMFClient,
    detail: Record<string, unknown>,
  ): Promise<Array<{ label: string; value: string }> | undefined> {
    const raw = (detail['raw'] ?? {}) as Record<string, unknown>;
    // 上游的 `pid` 是数字（JSON number），`stringOr` 只认字符串——直接用它取会
    // 静默落空，重装就只能退化成让用户手填系统 ID。
    const rawPid = raw['pid'] ?? detail['productId'];
    const pid = typeof rawPid === 'number' ? String(rawPid) : stringOr(rawPid);
    if (!pid) return undefined;
    try {
      const config = await client.getConfig(pid);
      const option = config?.options.find(
        (item) => /操作系统|镜像|image|^os$/i.test(item.label) || item.group === '镜像',
      );
      const choices = (option?.choices ?? []).filter(
        (choice) => choice.id && choice.label && /[A-Za-z\u4e00-\u9fa5]/.test(choice.label),
      );
      if (choices.length === 0) return undefined;
      return choices.map((choice) => ({ label: choice.label, value: choice.id }));
    } catch {
      return undefined;
    }
  }

  private async readCachedPassword(ctx: ProviderServiceContext): Promise<string | null> {
    // 用户自己重置过的密码落在 `runtime.rootPassword`：多数服务实例没有
    // `credentialsRef`（开通时上游不回密码），只走 secrets 会让用户重设完密码
    // 之后**永远看不到它**。
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    const fromRuntime = stringOr(runtime['rootPassword']);
    if (fromRuntime) return fromRuntime;
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

  async listChangeOptions(
    ctx: ProviderServiceContext,
  ): Promise<ServiceChangeOption[] | undefined> {
    if (!ctx.service.providerServiceId) return undefined;
    const { client } = await this.resolveForService(ctx.service);
    return client.listChangeOptions(ctx.service.providerServiceId);
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

  async executeAction(
    actionId: string,
    ctx: ProviderServiceContext,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    if (!SUPPORTED_ACTIONS.has(actionId)) {
      throw new ZJMFProviderError(400, '不支持的运维动作');
    }
    assertSafeParams(params);
    // 参数校验放在调用上游之前：重装缺 os 上游只会回一句「操作系统错误」，
    // 改密缺密码则会白跑一趟异步任务。
    if (actionId === 'reinstall' && !params?.['os']) {
      throw new ZJMFProviderError(400, '请选择要重装的操作系统');
    }
    if (actionId === 'reset_password') {
      const password = params?.['password'] ?? '';
      if (password.length < 8) throw new ZJMFProviderError(400, '新密码至少 8 位');
    }
    const { client } = await this.resolveForService(ctx.service);
    const data = await client.runServiceAction(ctx.service.providerServiceId, actionId, params);
    let passwordRuntime: Record<string, unknown> | null = null;
    // 改密成功后上游不会回传密码（异步任务），把用户设定的新密码存进凭据，
    // 详情页的「ROOT 密码」才是真的。存不进去不影响动作本身。
    if (actionId === 'reset_password' && params?.['password']) {
      if (ctx.service.credentialsRef) {
        try {
          await ctx.secrets.set(
            ctx.service.credentialsRef,
            JSON.stringify({ password: params['password'] }),
          );
        } catch {
          /* 忽略：凭据存储不可用时仍应返回动作结果 */
        }
      }
      const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
      passwordRuntime = { ...runtime, rootPassword: params['password'] };
    }

    // 上游可能在响应里回带展示数据（新密码、控制台地址）；尽力提取，缺失则忽略。
    const fields: ServiceActionResult['fields'] = [];
    // 重置密码是异步任务，上游只回「发起成功」不回密码；用户设的密码就是新密码，
    // 直接回显，否则用户点完按钮根本不知道密码是多少。
    if (actionId === 'reset_password' && params?.['password']) {
      fields.push({ label: '新密码', value: params['password'], secret: true, copyable: true });
    }
    const password = firstString(data, ['password', 'new_password', 'pass', 'vnc_pass']);
    if (password)
      fields.push({
        label: actionId === 'vnc' ? 'VNC 密码' : '新密码',
        value: password,
        secret: true,
        copyable: true,
      });
    const url = firstString(data, ['url', 'vnc_url', 'console_url', 'console']);
    const result: ServiceActionResult = {};
    if (fields.length > 0) result.fields = fields;
    const message =
      actionId === 'reset_password'
        ? '已发起重置密码，通常 1 分钟内生效'
        : actionId === 'reinstall'
          ? '已发起重装：机器会重启并清空系统盘，请稍后重新连接'
          : actionId === 'rescue'
            ? '已发起进入救援模式，机器会重启到救援系统'
            : actionId === 'exit_rescue'
              ? '已退出救援模式，机器会重启回正常系统'
              : null;
    if (message) result.message = message;
    if (url) {
      result.url = url;
      // 平台前端 action 无回传通道，落库到 runtime 以便刷新后仍展示控制台地址。
      const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
      result.runtime = { ...runtime, consoleUrl: url };
    }
    if (passwordRuntime) result.runtime = { ...(result.runtime ?? passwordRuntime), ...passwordRuntime };
    return result;
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
    if (client.protocol === 'finance') {
      // 财务版没有客户侧「立即销毁」：只有 `host/cancel` 的**申请停用**（上游后台
      // 处理，不退款）。继续返回 501 会让到期终止永远停在 terminating、每轮 sweep
      // 重试并轰炸管理员，而机器在上游照旧运行 —— 那才是真正的不受控。
      await client.requestServiceCancel(ctx.service.providerServiceId, '到期未续费');
      return;
    }
    await client.runServiceAction(ctx.service.providerServiceId, 'terminate');
  }

  /**
   * 续费回调（尽力而为）：store 已推进本平台到期时间，这里把续费同步到上游。
   * 上游未取证/不支持时 client 抛 `zjmf.client.unsupported`（不再静默），
   * 由 store 记录 `runtime.renewalNotifyError` 且不阻断续费（工单 #3 决策 B）。
   */
  async renew(
    ctx: ProviderServiceContext,
    info: ServiceRenewalInput,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) return {};
    const { client } = await this.resolveForService(ctx.service);
    const cycle = info.selection?.cycle;
    await client.renewService(ctx.service.providerServiceId, cycle ? { cycle } : {});
    return { message: `已同步续费至 ${info.newExpiresAt}` };
  }

  /** 升配/降配：把新的配置选择提交给上游升降级接口。 */
  async changePackage(
    ctx: ProviderServiceContext,
    change: ServiceChangeInput,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    const { client } = await this.resolveForService(ctx.service);
    // 只提交**变化项**：上游 `upgrade/upgrade_config_post` 对「未变化的配置项」
    // 会整单拒绝（实测传全量返回 400「参数异常,添加失败」，传 diff 才 200）。
    const current = (((ctx.service.runtime ?? {}) as Record<string, unknown>)[
      'config'
    ] as CheckoutSelection | undefined)?.selections as
      | Record<string, string | number>
      | undefined;
    const next = change.config?.selections ?? {};
    const diff: Record<string, string | number> = {};
    for (const [optionId, value] of Object.entries(next)) {
      if (value === undefined || value === null || value === '') continue;
      if (current && String(current[optionId] ?? '') === String(value)) continue;
      diff[optionId] = value;
    }
    if (Object.keys(diff).length === 0) {
      // 没有任何真实变化：不向上游发起一次「空升级」，但仍把目标配置落库。
      const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
      return {
        message: '配置无变化',
        runtime: change.config ? { ...runtime, config: change.config } : runtime,
      };
    }
    await client.changePackage(ctx.service.providerServiceId, { selections: diff });
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    return {
      message: '配置变更已提交上游',
      runtime: change.config ? { ...runtime, config: change.config } : runtime,
    };
  }

  /** 换商品：把目标上游商品提交给上游升降级商品接口。 */
  async changeProduct(
    ctx: ProviderServiceContext,
    change: ServiceChangeInput,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    const target = change.targetProviderProductId;
    if (!target) throw new ZJMFProviderError(409, '缺少目标上游商品');
    const { client } = await this.resolveForService(ctx.service);
    const cycle = change.config?.cycle;
    await client.changeProduct(ctx.service.providerServiceId, target, {
      ...(cycle ? { cycle } : {}),
    });
    const runtime = (ctx.service.runtime ?? {}) as Record<string, unknown>;
    return {
      message: '商品变更已提交上游',
      runtime: change.config ? { ...runtime, config: change.config } : runtime,
    };
  }

  /** 升配/降配差价试算：上游权威（魔方 upgrade_config_page 的 price_difference）。 */
  async calculateChangePrice(
    ctx: CheckoutPriceContext & {
      from?: CheckoutSelection;
      service?: ProviderServiceContext['service'];
    },
  ): Promise<CheckoutPriceResult> {
    const { client, markupBps } = await this.resolveForProduct(ctx.product.metadata);
    const providerServiceId = ctx.service?.providerServiceId ?? null;
    if (!providerServiceId) {
      throw new ZJMFProviderError(400, '缺少上游服务标识');
    }
    const selections =
      ctx.config.selections &&
      Object.fromEntries(
        Object.entries(ctx.config.selections).filter(
          ([, value]) => value !== undefined && value !== null && value !== '',
        ),
      );
    const quote = await client.calculateChangePrice(providerServiceId, {
      ...(selections ? { selections } : {}),
    });
    if (!quote) throw new ZJMFProviderError(400, '上游不支持该商品变配计价');
    const price = Math.max(0, applyMarkup(quote.price, markupBps));
    return {
      price,
      ...(quote.breakdown ? { breakdown: quote.breakdown } : {}),
      ...(quote.summary ? { summary: quote.summary } : {}),
    };
  }

  /** 转移所有权（尽力而为）：上游若不支持则仅由 store 落库换主。 */
  async changeOwner(
    ctx: ProviderServiceContext,
    targetUserId: string,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) return {};
    const { client } = await this.resolveForService(ctx.service);
    await client.changeOwner(ctx.service.providerServiceId, targetUserId);
    return { message: `所有权已转移至 ${targetUserId}` };
  }

  /**
   * 声明上游可用的服务子资源种类。
   *
   * V10 的 `snapshot/backup/disk/ip` 路由已有源码证据
   * （`public/plugins/server/mf_cloud/route.php:35-60`），不再需要实验开关。
   * finance 走 `provision/custom/content`，同样不受影响。
   */
  async listResourceKinds(ctx: ProviderServiceContext): Promise<ServiceResourceKind[]> {
    if (!ctx.service.providerServiceId) return [];
    // 只有云家族（mf_cloud/remf_cloud）有快照/备份路由；物理机与通用产品
    // 声明了也只会在调用时 400，故在声明阶段收敛。这里只做「能力声明」，
    // 解析不到上游（无绑定/凭证缺失）就按不支持处理，避免详情页整体报错。
    const supported = await this.resolveForService(ctx.service)
      .then(({ client }) => client.supportsServiceResources(ctx.service.providerServiceId!))
      .catch(() => false);
    if (!supported) return [];
    const kinds: ServiceResourceKind[] = [
      {
        id: 'snapshot',
        label: '快照',
        creatable: true,
        createParams: [
          {
            name: 'disk_id',
            label: '磁盘 ID',
            type: 'text',
            required: true,
            maxLength: 64,
          },
          {
            name: 'name',
            label: '快照名称',
            type: 'text',
            required: true,
            maxLength: 64,
          },
        ],
        columns: [
          { key: 'name', label: '名称' },
          { key: 'create_time', label: '创建时间' },
          { key: 'status', label: '状态' },
        ],
        rowActions: [
          { id: 'restore', label: '恢复', danger: true, confirm: true },
          { id: 'delete', label: '删除', danger: true, confirm: true },
        ],
      },
      {
        id: 'backup',
        label: '备份',
        creatable: true,
        createParams: [
          {
            name: 'disk_id',
            label: '磁盘 ID',
            type: 'text',
            required: true,
            maxLength: 64,
          },
          {
            name: 'name',
            label: '备份名称',
            type: 'text',
            required: true,
            maxLength: 64,
          },
        ],
        columns: [
          { key: 'name', label: '名称' },
          { key: 'create_time', label: '创建时间' },
          { key: 'status', label: '状态' },
        ],
        rowActions: [
          { id: 'restore', label: '恢复', danger: true, confirm: true },
          { id: 'delete', label: '删除', danger: true, confirm: true },
        ],
      },
    ];
    return kinds;
  }

  /**
   * 列出某类子资源。
   *
   * 上游失败（传输/鉴权/HTTP/结构非法）**上抛**，不再静默降级为空列表——
   * 「拉取失败」与「没有资源」必须可区分（工单 #2 §3.2）。
   */
  async listResources(ctx: ProviderServiceContext, kind: string): Promise<ServiceResource[]> {
    if (!ctx.service.providerServiceId) return [];
    if (!RESOURCE_KINDS.has(kind)) return [];
    const { client } = await this.resolveForService(ctx.service);
    const rows = await client.listServiceResources(ctx.service.providerServiceId, kind);
    return rows.map((row) => ({
      id: row.id,
      fields: pickResourceColumns(kind, row.fields),
    }));
  }

  /** 新建子资源。 */
  async createResource(
    ctx: ProviderServiceContext,
    kind: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    if (!RESOURCE_KINDS.has(kind)) {
      throw new ZJMFProviderError(400, '不支持该资源类型');
    }
    assertSafeParams(params);
    const { client } = await this.resolveForService(ctx.service);
    await client.createServiceResource(ctx.service.providerServiceId, kind, params);
    return { message: '已提交创建' };
  }

  /** 对子资源执行行内动作（扩容/挂载/删除/恢复…）。 */
  async runResourceAction(
    ctx: ProviderServiceContext,
    kind: string,
    resourceId: string,
    actionId: string,
    params?: Record<string, string>,
  ): Promise<ServiceActionResult> {
    if (!ctx.service.providerServiceId) {
      throw new ZJMFProviderError(409, '服务尚未开通');
    }
    if (!RESOURCE_KINDS.has(kind)) {
      throw new ZJMFProviderError(400, '不支持该资源类型');
    }
    assertSafeParams(params);
    const { client } = await this.resolveForService(ctx.service);
    await client.runResourceAction(
      ctx.service.providerServiceId,
      kind,
      resourceId,
      actionId,
      params,
    );
    return { message: '操作已提交' };
  }
}

/** 上游增值运维支持的资源类型。 */
const RESOURCE_KINDS = new Set(['snapshot', 'backup']);

/** 从上游行数据里挑出声明过的列（保持前端列顺序）。 */
function pickResourceColumns(kind: string, fields: Record<string, string>): Record<string, string> {
  const keys =
    kind === 'snapshot' || kind === 'backup'
      ? ['name', 'create_time', 'status', 'notes']
      : Object.keys(fields);
  const picked: Record<string, string> = {};
  for (const key of keys) {
    if (fields[key] !== undefined) picked[key] = fields[key];
  }
  return picked;
}

const SPEC_LABELS: Record<string, string> = {
  cpu: 'CPU',
  memory: '内存',
  disk: '磁盘',
  bandwidth: '带宽',
  os: '操作系统',
  region: '地域',
};

const SUPPORTED_ACTIONS = new Set([
  'power_on',
  'power_off',
  'reboot',
  'hard_off',
  'hard_reboot',
  'terminate',
  'reinstall',
  'reset_password',
  'rescue',
  'exit_rescue',
  'vnc',
]);

/** 上游保留字段：调用方参数不得覆盖（否则可篡改动作/鉴权）。 */
const RESERVED_ACTION_PARAMS = new Set(['id', 'func', 'is_api', 'action']);

/** 参数名必须为合法标识符，且不占用上游保留字段。 */
function assertSafeParams(params: Record<string, string> | undefined): void {
  for (const key of Object.keys(params ?? {})) {
    if (RESERVED_ACTION_PARAMS.has(key) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw new ZJMFProviderError(400, '运维动作参数无效');
    }
  }
}

/**
 * 服务运维动作。
 *
 * 只声明**上游真的实现**的动作：魔方财务版（`finance`）的
 * `/provision/default` 实测只有 `on` / `off` / `hard_off` / `reboot` /
 * `hard_reboot` / `reinstall` / `vnc`，`reset_password` 等一律 406
 * 「不支持的方法」。声明一个必然失败的按钮，比不声明更伤用户信任。
 */
function defaultActions(
  protocol?: 'finance' | 'v10',
  osChoices?: Array<{ label: string; value: string }>,
): ServiceAction[] {
  const actions: ServiceAction[] = [
    { id: 'power_on', label: '开机' },
    { id: 'power_off', label: '关机' },
    { id: 'reboot', label: '重启', confirm: true },
  ];
  // 强制关机/强制重启只在财务协议声明：`/provision/default` 的 func 就是
  // `hard_off` / `hard_reboot`（`public/plugins/reserver/mf_finance` 的路由表）；
  // V10 只有 `mf_cloud` 家族有这两个末段，`mf_dcim` 没有，无法在协议层统一声明。
  if (protocol === 'finance') {
    actions.push(
      { id: 'hard_off', label: '强制关机', danger: true, confirm: true },
      { id: 'hard_reboot', label: '强制重启', confirm: true },
    );
  }
  const osParam: ServiceActionParam =
    osChoices && osChoices.length > 0
      ? { name: 'os', label: '操作系统', type: 'select', required: true, options: osChoices }
      : {
          name: 'os',
          label: '操作系统 ID',
          type: 'text',
          required: true,
          maxLength: 64,
          placeholder: '与下单时的系统选项 ID 相同，如 15711313',
        };
  actions.push(
    {
      id: 'reinstall',
      label: '重装系统',
      danger: true,
      confirm: true,
      // 只声明前端能直接渲染的参数：`port` 不在平台 action 的静态字段里，
      // 声明它只会变成「请自己写 JSON」的输入框。重装默认沿用上游 22 端口。
      params: [osParam, { name: 'password', label: '新 ROOT 密码', type: 'password', maxLength: 64 }],
    },
    {
      id: 'reset_password',
      label: '重置密码',
      confirm: true,
      params: [{ name: 'password', label: '新密码', type: 'password', required: true, maxLength: 64 }],
    },
    { id: 'vnc', label: '打开控制台（VNC）' },
  );
  // 救援模式同样只有财务协议有明确的 func 契约（`rescue_system` / `exitRescue`）。
  if (protocol === 'finance') {
    actions.push(
      {
        id: 'rescue',
        label: '进入救援模式',
        danger: true,
        confirm: true,
        params: [
          {
            name: 'type',
            label: '救援系统',
            type: 'select',
            required: true,
            options: [
              { label: 'Linux', value: '2' },
              { label: 'Windows', value: '1' },
            ],
          },
        ],
      },
      { id: 'exit_rescue', label: '退出救援模式', confirm: true },
    );
  }
  return actions;
}

/** 从上游响应中按候选键取首个非空字符串。 */
function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  const data = source['data'];
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    for (const key of keys) {
      const value = nested[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return null;
}

export function normalizeStatus(status: string): NonNullable<ServiceDetail['status']> {
  const normalized = (status ?? '').toUpperCase();
  if (normalized.includes('PROVISION')) return 'PROVISIONING';
  if (
    normalized.includes('TERMINAT') ||
    normalized.includes('DELET') ||
    ['CANCELLED', 'CANCELED'].includes(normalized)
  )
    return 'TERMINATED';
  if (normalized.includes('SUSPEND')) return 'SUSPENDED';
  if (normalized.includes('FAIL')) return 'FAILED';
  if (['OFF', 'SHUTOFF', 'SHUTDOWN', 'STOPPED', 'POWERED_OFF'].includes(normalized))
    return 'ACTIVE';
  if (['ACTIVE', 'RUNNING', 'ON', 'POWERED_ON'].includes(normalized)) return 'ACTIVE';
  return 'PENDING_PROVISION';
}

/** Power is not a billing suspension or a provisioning lifecycle state. */
export function normalizePowerState(status: string): 'ON' | 'OFF' | 'UNKNOWN' {
  const value = status.trim().toUpperCase();
  if (['ON', 'RUNNING', 'POWERED_ON'].includes(value)) return 'ON';
  if (['OFF', 'SHUTOFF', 'SHUTDOWN', 'STOPPED', 'POWERED_OFF'].includes(value)) return 'OFF';
  return 'UNKNOWN';
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
