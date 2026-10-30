/**
 * 计费模块（目标五）：预留 → 结算 → 补偿的完整生命周期。
 *
 * ## 为什么必须预留（而不是「用完再扣」）
 *
 * 后付费的失败模式是坏账：并发请求共享同一份余额快照，各自都读到「够用」，
 * 于是都放行，最后扣费时余额不够，一部分请求白跑。预留把金额**从 balance 划走**
 * （内核 `wallet.hold` 把 hold 计入 frozen，`getAccount().balance` 已是扣掉冻结的
 * 可用余额），后到的请求看到的是已扣减的余额，会在**消耗上游之前**被拒。
 *
 * ## 十一步生命周期（本模块负责 3/4/7/8/9/10/11）
 *
 * 1. 鉴权               → 路由层
 * 2. 解析模型和接口      → 路由层
 * 3. 估算最大可能用量    → `estimateReserve`
 * 4. 原子预留           → `reserve`
 * 5. 选 provider 和账号  → 路由层
 * 6. 执行上游           → relay
 * 7. 获取真实 usage     → adaptor / 估算
 * 8. 按真实 usage 结算差额 → `settle`
 * 9. 幂等 usage log     → `settle`（referenceId = 台账 referenceId）
 * 10. 结算失败进可重试补偿队列 → `settle` 失败分支 + `runCompensation`
 * 11. 补偿超限触发欠费/冻结 → `runCompensation` 的 FAILED 分支
 *
 * ## 幂等纪律
 *
 * 一次请求全程只有一个稳定 `referenceId`（= usage-log 的主键 id，在建流水时
 * 生成）。台账以它做唯一索引，钱包以它为幂等键。**补偿重试必须复用同一个
 * `referenceId`**，否则重试会变成第二次扣款。
 *
 * ## 价格版本快照
 *
 * 台账里存 `priceSnapshot`（settle 时定稿写回），补偿只按快照重算，绝不回头读
 * model-price 现值。管理员改价不得影响在途请求与历史账单。
 */

import { randomUUID } from 'node:crypto';
import type { PluginLogger, WalletHold, WalletService } from '@stackpanel/sdk';
import type { ModelPrice, ServedPrice, TokenUsage } from './pricing.js';
import { computeAmount, computeCostAmount, estimateTokens } from './pricing.js';
import { consumeEntitlement, getEntitlement, patchUsageLog } from './repository.js';
import { remainingOf, splitSettlement } from './entitlements.js';
import {
  createBillingEntry,
  createUsageLog,
  getBillingByReference,
  getBillingEntry,
  listPendingCompensations,
  updateBillingEntry,
  type BillingEntryRow,
  type UsageLogRow,
} from './repository.js';
import type { GatewayUsageLogData } from './data.js';

/* ------------------------------ 预留估算 ------------------------------ */

/** 预留兜底 max_tokens：客户端没给上限时，按它估最坏情况。 */
export const DEFAULT_RESERVE_MAX_TOKENS = 4_096;

export interface ReserveEstimateInput {
  price: ModelPrice;
  /** 请求体原文（用于估 prompt）。 */
  bodyText: string;
  /** 客户端给的 max_tokens / max_completion_tokens / maxOutputTokens。 */
  maxTokens?: number | undefined;
  /** 图片张数（图片计费参与预留）。 */
  imageCount?: number | undefined;
  /** 音频秒数（语音计费参与预留）。 */
  audioSeconds?: number | undefined;
}

/**
 * 估算「最大可能用量」对应的金额（minor）。
 *
 * 预留是**上限**而非预测：宁可多冻一点（结算时按真实用量退还差额），
 * 也不要少冻导致并发穿透。所以输出侧一律按 max_tokens 顶格算。
 *
 * 注意 prompt 侧用字符粗估（`estimateTokens`）。Estimate 偏小会把余额不足的
 * 请求放过头，所以对超长 body 额外留 1.5 倍余量。
 */
export function estimateReserve(input: ReserveEstimateInput): number {
  const promptRough = estimateTokens(input.bodyText);
  const promptBound = Math.ceil(promptRough * 1.5);
  const completion =
    input.maxTokens && input.maxTokens > 0
      ? Math.floor(input.maxTokens)
      : DEFAULT_RESERVE_MAX_TOKENS;
  // 图片/音频是非 token 计价单位，必须显式进预留，否则 images/audio 请求会少冻。
  const imageCount = input.imageCount && input.imageCount > 0 ? Math.floor(input.imageCount) : 0;
  const audioSeconds =
    input.audioSeconds && input.audioSeconds > 0 ? Math.ceil(input.audioSeconds) : 0;
  return computeAmount(input.price, {
    promptTokens: promptBound,
    completionTokens: completion,
    totalTokens: promptBound + completion,
    ...(imageCount > 0 ? { imageCount } : {}),
    ...(audioSeconds > 0 ? { audioSeconds } : {}),
  });
}

/* ------------------------------ 计费上下文 ------------------------------ */

/** 一次计费的完整上下文，从 reserve 一直传到 settle / compensate。 */
export interface BillingContext {
  /** 稳定幂等键：一次请求一个，补偿重试复用它。 */
  referenceId: string;
  userId: string;
  apiKeyId: string;
  accountId: string | null;
  model: string;
  currency: string;
  /** 预留时定稿的价格参数（版本快照）。 */
  price: ServedPrice;
  /** 价格快照的序列化形态（写进台账）。 */
  priceSnapshot: Record<string, unknown>;
  /** 本次实收应用的权限组折扣（%，0 = 未折扣）。 */
  discountPercent: number;
  /** 实际调用的上游 key（账号多 Key 时用于对账）。 */
  upstreamKeyId: string;
  /**
   * 本次抵扣的套餐权益（B1）；`null` = 走钱包。
   *
   * 有权益时预留阶段**不冻钱包**（套餐用户不该因为钱包为 0 被 402），
   * 结算时先扣权益、差额再扣钱包。
   */
  /** 实际转发给上游的模型名（B4 映射结果）；空 = 与对外模型同名。 */
  upstreamModel?: string | undefined;
  /** 本次请求被改写的痕迹（C4）：写进用量流水，便于事后回溯。 */
  rewrites?: string | undefined;
  entitlementId: string | null;
  /** 结算时实际由权益抵扣的金额（minor）；settle 里回填。 */
  entitlementAmount: number;
  /** 预留产生的 hold；金额为 0 时为 null。 */
  hold: WalletHold | null;
  /** 台账行 id（reserve 成功后填充）。 */
  entryId: string | null;
}

export interface ReserveInput {
  wallet: WalletService;
  logger: PluginLogger;
  userId: string;
  apiKeyId: string;
  accountId: string | null;
  model: string;
  currency: string;
  price: ServedPrice;
  /** 预留金额（minor）；<= 0 表示不冻资金，但仍建台账。 */
  amount: number;
  /** 人类可读备注（进钱包流水）。 */
  note?: string | undefined;
  /** 预留 hold 的 TTL（毫秒）；省略时由内核默认（15 分钟）决定。 */
  ttlMs?: number | undefined;
  /** 权限组折扣（% off）；参与结算，不参与预留（预留按未折扣上限更安全）。 */
  discountPercent?: number | undefined;
  /** 实际调用的上游 key id（选号后回填）。 */
  upstreamKeyId?: string | undefined;
  /** 本次可用套餐权益（B1）。 */
  entitlementId?: string | null | undefined;
  /**
   * 预估金额中由套餐覆盖的部分（minor）。钱包只冻结 `amount - coveredAmount`；
   * 不传时按「有权益即全额覆盖」处理（全部走套餐、不冻钱包）。
   */
  coveredAmount?: number | undefined;
}

/** 把 ServedPrice 序列化成可持久化的快照（不含方法，纯数据）。 */
export function priceSnapshotOf(price: ServedPrice, discountPercent = 0): Record<string, unknown> {
  return {
    publicModel: price.publicModel,
    upstreamModel: price.upstreamModel,
    inputPrice: price.inputPrice,
    outputPrice: price.outputPrice,
    cacheReadPrice: price.cacheReadPrice ?? price.inputPrice,
    cacheWritePrice: price.cacheWritePrice ?? price.inputPrice,
    /* 成本与阶梯也进快照：补偿/对账要能在事后复算毛利，而不是读现值。 */
    ...(price.reasoningPrice !== undefined ? { reasoningPrice: price.reasoningPrice } : {}),
    ...(price.imagePrice !== undefined ? { imagePrice: price.imagePrice } : {}),
    ...(price.audioPrice !== undefined ? { audioPrice: price.audioPrice } : {}),
    ...(price.costInputPrice !== undefined ? { costInputPrice: price.costInputPrice } : {}),
    ...(price.costOutputPrice !== undefined ? { costOutputPrice: price.costOutputPrice } : {}),
    ...(price.costCacheReadPrice !== undefined
      ? { costCacheReadPrice: price.costCacheReadPrice }
      : {}),
    ...(price.costCacheWritePrice !== undefined
      ? { costCacheWritePrice: price.costCacheWritePrice }
      : {}),
    ...(price.costReasoningPrice !== undefined
      ? { costReasoningPrice: price.costReasoningPrice }
      : {}),
    ...(price.costImagePrice !== undefined ? { costImagePrice: price.costImagePrice } : {}),
    ...(price.costAudioPrice !== undefined ? { costAudioPrice: price.costAudioPrice } : {}),
    ...(price.tiers !== undefined ? { tiers: price.tiers } : {}),
    ...(price.maxOutputTokens !== undefined ? { maxOutputTokens: price.maxOutputTokens } : {}),
    ...(price.groupDiscount !== undefined ? { groupDiscount: price.groupDiscount } : {}),
    multiplier: price.multiplier,
    /** 本次实收应用的权限组折扣，重算账单时复用它而不是读当时的组配置。 */
    discountPercent,
    /** 快照时间：运维对账时可判断「当时用的是哪一版价」。 */
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 第三步 + 第四步：估算上限并原子预留。
 *
 * 顺序纪律：**先预留再选上游账号**。选账号会占用账号并发位，如果预留在后，
 * 余额不足的请求已经白白占掉一个上游位子（并在多账号池里造成假性满载）。
 *
 * 幂等：`referenceId` 传同一个值时，重复调用会命中内核 hold 的
 * `(referenceType, referenceId)` 唯一约束，拿到既有 hold 而不是二次冻结。
 *
 * @throws GatewayError 余额不足（402）或预留失败（502）
 */
export async function reserve(input: ReserveInput): Promise<BillingContext> {
  const referenceId = randomUUID();
  const discountPercent = input.discountPercent ?? 0;
  const snapshot = priceSnapshotOf(input.price, discountPercent);

  // 套餐优先（B1）：被套餐覆盖的部分不冻钱包。冻结的意义是防止并发穿透余额，
  // 而套餐额度的防穿透由结算时的条件更新（`usedAmount <= quota - amount`）负责。
  const entitlementId = input.entitlementId ?? null;
  const covered = Math.min(
    Math.max(0, Math.trunc(input.coveredAmount ?? (entitlementId ? input.amount : 0))),
    input.amount,
  );
  const holdAmount = Math.max(0, input.amount - covered);

  let hold: WalletHold | null = null;
  if (holdAmount > 0) {
    // 余额不足由钱包抛 WalletError(409)。这里**不再靠 message.includes 判**：
    // 结构化判定交给调用方（见 isInsufficientBalance），本函数只负责把 wallet
    // 的错误原样抛出，让路由层统一转成 OpenAI 兼容错误体。
    hold = await input.wallet.hold(
      input.userId,
      holdAmount,
      input.currency,
      {
        type: 'llm_gateway_usage',
        referenceType: 'gateway_hold',
        referenceId,
      },
      {
        ...(input.note ? { note: input.note } : {}),
        ...(input.ttlMs && input.ttlMs > 0 ? { ttlMs: input.ttlMs } : {}),
      },
    );
  }

  // 台账先于上游调用落库：即使进程随后崩溃，也有记录可被补偿任务发现。
  let entry: BillingEntryRow;
  try {
    entry = await createBillingEntry({
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      accountId: input.accountId,
      model: input.model,
      referenceId,
      holdId: hold?.id ?? null,
      status: 'RESERVED',
      reservedAmount: input.amount,
      settledAmount: 0,
      currency: input.currency,
      priceSnapshot: snapshot,
      entitlementId,
      entitlementAmount: 0,
      attempt: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
  } catch (error) {
    // 台账写不进去就不能继续消耗上游——否则一旦上游产生费用，我们没有任何
    // 记录可扣。先把刚冻结的钱还回去，再抛。
    if (hold) await input.wallet.releaseHold(hold.id).catch(() => null);
    throw error;
  }

  return {
    referenceId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    accountId: input.accountId,
    model: input.model,
    currency: input.currency,
    price: input.price,
    priceSnapshot: snapshot,
    discountPercent,
    upstreamKeyId: input.upstreamKeyId ?? '',
    entitlementId,
    entitlementAmount: 0,
    hold,
    entryId: entry.id,
  };
}

/* ------------------------------ 结算 ------------------------------ */

/** 一次结算要用的真实用量与结果。 */
export interface SettleInput {
  wallet: WalletService;
  logger: PluginLogger;
  context: BillingContext;
  /** 真实（或估算）用量。 */
  usage: TokenUsage;
  /** 上游未返回 usage、按估算计时为 true（进账单标记）。 */
  estimated: boolean;
  /** 入口协议与 endpoint id（对账维度）。 */
  protocol: string;
  endpoint: string;
  status: 'SUCCESS' | 'ERROR' | 'CANCELLED' | 'TIMEOUT';
  httpStatus?: number | null;
  latencyMs?: number | null;
  firstTokenMs?: number | null;
  clientIp?: string | null;
  error?: string | null;
  /** 首 token 之前的输出文本，用于 usage 缺失时估算（可省略）。 */
  outputText?: string | undefined;
  /** 客户端中断后又继续了计费（A8）；账单据此复核。 */
  aborted?: boolean | undefined;
}

export interface SettleResult {
  amount: number;
  log: UsageLogRow;
  /** 结算是否成功落到钱包（false 表示已进补偿队列）。 */
  settled: boolean;
}

/**
 * 第七步 + 第八步 + 第九步：按真实 usage 结算差额，并写幂等 usage log。
 *
 * 关键顺序：**先建 usage log（拿到稳定 id），再做钱包结算**。usage log 的 id 是
 * 全链路幂等键的来源；如果先扣钱后写日志，写日志失败就变成「扣了钱没账单」。
 * 反过来的失败模式（有账单没扣钱）可以被补偿队列修复。
 *
 * 结算金额恒按 `context.price`（版本快照）算，绝不回头读现值。
 *
 * 失败策略（目标四 6/7）：结算失败**绝不静默吞掉**。usage log 记录错误，
 * 台账转 COMPENSATING 并设下一次重试时间，由补偿任务继续尝试；只有在补偿
 * 超过上限后才按欠费处理。
 */
export async function settle(input: SettleInput): Promise<SettleResult> {
  const { context } = input;
  const amount = computeAmount(context.price, input.usage, {
    discountPercent: context.discountPercent,
  });

  /**
   * 套餐抵扣（B1）：先读出「这一笔能抵多少」，写进流水，再原子扣减。
   *
   * 顺序：读权益（无副作用）→ 建流水（拿到幂等键）→ 扣权益 → 扣钱包。
   * 若扣减因并发被拒（额度刚好被别人用掉），把套餐部分归零、整笔改走钱包，
   * 并回写流水——流水不是权威，台账（entry）才是；台账在 closeEntry 里写终值。
   */
  let entitlementAmount = 0;
  let walletAmount = amount;
  if (amount > 0 && context.entitlementId) {
    const entitlement = await getEntitlement(context.entitlementId).catch(() => null);
    const split = splitSettlement(amount, entitlement ? remainingOf(entitlement) : 0);
    entitlementAmount = split.entitlement;
    walletAmount = split.wallet;
  }

  const log = await createUsageLog({
    apiKeyId: context.apiKeyId,
    userId: context.userId,
    accountId: context.accountId,
    model: context.model,
    protocol: input.protocol,
    endpoint: input.endpoint,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    cacheReadTokens: input.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
    upstreamModel:
      context.upstreamModel && context.upstreamModel !== context.model ? context.upstreamModel : '',
    reasoningTokens: input.usage.reasoningTokens ?? 0,
    imageCount: input.usage.imageCount ?? 0,
    audioSeconds: input.usage.audioSeconds ?? 0,
    totalTokens: input.usage.totalTokens ?? input.usage.promptTokens + input.usage.completionTokens,
    amount,
    /** 成本与售价分开记账（A3）：毛利 = amount - costAmount。 */
    costAmount: computeCostAmount(context.price, input.usage),
    discountPercent: context.discountPercent,
    upstreamKeyId: context.upstreamKeyId,
    rewrites: context.rewrites ?? '',
    aborted: input.aborted ?? false,
    entitlementId: context.entitlementId ?? '',
    entitlementAmount,
    currency: context.currency,
    status: input.status,
    estimated: input.estimated,
    priceRef: context.referenceId,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    firstTokenMs: input.firstTokenMs ?? null,
    clientIp: input.clientIp ?? null,
    error: input.error ?? null,
  });

  // 套餐抵扣执行（在流水落库之后，失败只影响分摊，不影响总额）。
  if (entitlementAmount > 0 && context.entitlementId) {
    const consumed = await consumeEntitlement(context.entitlementId, entitlementAmount).catch(
      () => false,
    );
    if (!consumed) {
      entitlementAmount = 0;
      walletAmount = amount;
      await patchUsageLog(log.id, { entitlementAmount: 0 });
      input.logger.warn(
        `llm-gateway: entitlement ${context.entitlementId} exhausted during settle, charging wallet`,
      );
    }
  }
  context.entitlementAmount = entitlementAmount;

  // 用量为 0（请求失败且未消耗）时全额释放预留，并关账。
  if (amount <= 0) {
    if (context.hold) {
      await input.wallet
        .settleHold(context.hold.id, 0, {
          type: 'llm_gateway_usage',
          referenceType: 'gateway_usage_log',
          referenceId: log.id,
        })
        .catch((error: unknown) => {
          input.logger.warn(
            `llm-gateway: release hold ${context.hold?.id ?? ''} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    await closeEntry(context, {
      status: 'RELEASED',
      settledAmount: 0,
      amount,
      entitlementAmount: 0,
    });
    return { amount: 0, log, settled: true };
  }

  // 钱包只承担「总额 − 套餐抵扣」的部分。
  if (walletAmount <= 0) {
    await closeEntry(context, {
      status: 'SETTLED',
      settledAmount: 0,
      amount,
      entitlementAmount,
    });
    return { amount, log, settled: true };
  }

  try {
    if (context.hold) {
      // 按真实用量结算并退还差额。引用用 usage-log id：即使本函数重入，
      // 内核按 (referenceType, referenceId) 判定，不会二次结算。
      await input.wallet.settleHold(context.hold.id, walletAmount, {
        type: 'llm_gateway_usage',
        referenceType: 'gateway_usage_log',
        referenceId: log.id,
      });
    } else {
      // 没有预留（套餐覆盖后仍有差额、罕见的 0 估算路径，或 hold 建失败后的
      // 人工放行）才直接扣。
      await input.wallet.debit(context.userId, walletAmount, context.currency, {
        type: 'llm_gateway_usage',
        referenceType: 'gateway_usage_log',
        referenceId: log.id,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger.error(`llm-gateway: settle failed for ${log.id}: ${message}`);
    // 必须把「真实应付金额」落进台账：`runCompensation` 优先读 `settledAmount`，
    // 只有它为 0 时才回退到整笔 `reservedAmount`。如果这里写 0，一次瞬时钱包
    // 抖动就会让补偿按**预留上限**（而非真实用量）重扣——实际用量远小于预留时
    // 就是超额扣费。金额本身不会因此重复扣：钱包结算按 holdId 幂等。
    await closeEntry(context, {
      status: 'COMPENSATING',
      settledAmount: walletAmount,
      amount,
      entitlementAmount,
      lastError: message.slice(0, 300),
      attempt: 1,
      nextAttemptAt: Date.now() + compensationDelay(1),
    });
    return { amount, log, settled: false };
  }

  await closeEntry(context, {
    status: 'SETTLED',
    settledAmount: walletAmount,
    amount,
    entitlementAmount,
  });
  return { amount, log, settled: true };
}

async function closeEntry(
  context: BillingContext,
  patch: {
    status: string;
    settledAmount: number;
    amount: number;
    entitlementAmount?: number;
    lastError?: string;
    attempt?: number;
    nextAttemptAt?: number;
  },
): Promise<void> {
  let id = context.entryId;
  if (!id) {
    // 极端情形：reserve 成功但 entryId 未回填（例如进程重启后由补偿任务接手）。
    // 用 referenceId 反查。
    const found = await getBillingByReference(context.referenceId);
    id = found?.id ?? null;
  }
  if (!id) return;
  await updateBillingEntry(id, {
    status: patch.status,
    settledAmount: patch.settledAmount,
    ...(patch.entitlementAmount !== undefined
      ? { entitlementAmount: patch.entitlementAmount }
      : {}),
    ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
    ...(patch.nextAttemptAt !== undefined ? { nextAttemptAt: patch.nextAttemptAt } : {}),
  });
}

/* ------------------------------ 补偿 ------------------------------ */

/** 指数退避：1s、2s、4s、…封顶 5 分钟。 */
export function compensationDelay(attempt: number): number {
  const base = 1_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 5 * 60 * 1000);
}

/** 补偿重试上限；超过则按欠费处理（目标五第 11 步）。 */
export const MAX_COMPENSATION_ATTEMPTS = 8;

export interface CompensationResult {
  processed: number;
  settled: number;
  failed: number;
}

/**
 * 第十步 + 第十一步：处理补偿队列。
 *
 * 由内核 job（ADR-0013）周期调用。对每条 COMPENSATING 台账：
 * - 重新按快照金额结算（幂等键仍是原 referenceId）；
 * - 成功 → COMPENSATED；
 * - 失败且未超限 → 增加 attempt、推迟 nextAttemptAt；
 * - 失败且超限 → FAILED（欠费），并记明确日志供运维介入。
 *
 * 幂等前提：钱包结算按 `(referenceType, referenceId)` 幂等，所以「上次其实
 * 扣成功但状态没写回」的重放不会二次扣款——它会命中唯一约束并被视为成功路径。
 */
export async function runCompensation(
  wallet: WalletService,
  logger: PluginLogger,
  now = Date.now(),
): Promise<CompensationResult> {
  const pending = await listPendingCompensations(now);
  const result: CompensationResult = { processed: 0, settled: 0, failed: 0 };

  for (const entry of pending) {
    result.processed += 1;
    const amount = entry.settledAmount > 0 ? entry.settledAmount : entry.reservedAmount;
    try {
      if (entry.holdId) {
        await wallet.settleHold(entry.holdId, amount, {
          type: 'llm_gateway_usage',
          referenceType: 'gateway_usage_log',
          referenceId: entry.referenceId,
        });
      } else {
        await wallet.debit(entry.userId, amount, entry.currency, {
          type: 'llm_gateway_usage',
          referenceType: 'gateway_usage_log',
          referenceId: entry.referenceId,
        });
      }
      await updateBillingEntry(entry.id, {
        status: 'COMPENSATED',
        settledAmount: amount,
        lastError: null,
      });
      result.settled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = (entry.attempt ?? 0) + 1;
      if (attempt >= MAX_COMPENSATION_ATTEMPTS) {
        await updateBillingEntry(entry.id, {
          status: 'FAILED',
          attempt,
          lastError: message.slice(0, 300),
        });
        // 欠费：这里是**唯一**允许账户进入明确欠费态的地方。运维须介入：
        // 要么补扣成功，要么人工核销。不静默、不重试。
        logger.error(
          `llm-gateway: billing compensation exhausted for ${entry.referenceId} ` +
            `(user ${entry.userId}, ${amount} ${entry.currency}): ${message}`,
        );
        result.failed += 1;
      } else {
        await updateBillingEntry(entry.id, {
          attempt,
          nextAttemptAt: now + compensationDelay(attempt),
          lastError: message.slice(0, 300),
        });
      }
    }
  }
  return result;
}

/* ------------------------------ 失败释放 ------------------------------ */

/**
 * 请求在**消耗上游之前**失败时，全额释放预留。
 *
 * 与 `settle(amount=0)` 的区别：这里还没有 usage log（请求根本没发出去），
 * 所以不写账单，只关台账 + 释放 hold。
 */
export async function release(
  wallet: WalletService,
  logger: PluginLogger,
  context: BillingContext,
): Promise<void> {
  if (context.hold) {
    await wallet.releaseHold(context.hold.id).catch((error: unknown) => {
      // 释放失败不阻塞错误响应：hold 会由内核过期清扫（15 分钟）归还。
      logger.warn(
        `llm-gateway: release hold ${context.hold?.id ?? ''} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  await closeEntry(context, { status: 'RELEASED', settledAmount: 0, amount: 0 });
}

/* ------------------------------ 无预留请求的计费 ------------------------------ */

/**
 * 建一个「零预留」计费上下文：用于不需要预留的 endpoint（GET /v1/models、
 * 文件列表等纯读接口）或预估金额为 0 的请求。仍建台账，保证每个请求可对账。
 */
export async function reserveFree(input: {
  userId: string;
  apiKeyId: string;
  accountId: string | null;
  model: string;
  currency: string;
  price: ServedPrice;
}): Promise<BillingContext> {
  const referenceId = randomUUID();
  const snapshot = priceSnapshotOf(input.price);
  const entry = await createBillingEntry({
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    accountId: input.accountId,
    model: input.model,
    referenceId,
    holdId: null,
    status: 'RESERVED',
    reservedAmount: 0,
    settledAmount: 0,
    currency: input.currency,
    priceSnapshot: snapshot,
    entitlementId: null,
    entitlementAmount: 0,
    attempt: 0,
    nextAttemptAt: 0,
    lastError: null,
  });
  return {
    referenceId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    accountId: input.accountId,
    model: input.model,
    currency: input.currency,
    price: input.price,
    priceSnapshot: snapshot,
    discountPercent: 0,
    upstreamKeyId: '',
    entitlementId: null,
    entitlementAmount: 0,
    hold: null,
    entryId: entry.id,
  };
}

/* ------------------------------ 对账辅助 ------------------------------ */

/** 台账状态（给管理端筛选用）。 */
export type BillingStatus =
  'RESERVED' | 'SETTLED' | 'RELEASED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';

export { getBillingEntry, getBillingByReference };
export type { BillingEntryRow, GatewayUsageLogData };
