import { formatMinorCurrency, isWalletError, type ExtensionInstance } from '@stackpanel/sdk';
import { context } from './context';
import { recordModel, type ReferralCode, type ReferralConfig, type ReferralRecord } from './data';

/**
 * 钱包流水里标记「这笔钱来自推广」的 referenceType。
 *
 * 幂等靠内核账本的 `@@unique([referenceType, referenceId])`：同一个归因记录的
 * 同一侧奖励只会入账一次，重复投递（事件重放、任务重试）不会多发钱。
 */
export const REFERRAL_REFERENCE_TYPE = 'REFERRAL';

/** 流水展示类型；钱包明细页对未知 type 会回退显示 note。 */
const LEDGER_TYPE_INVITER = 'REFERRAL_REWARD';
const LEDGER_TYPE_INVITEE = 'REFERRAL_INVITEE_REWARD';
/** 追回流水的展示类型：与奖励入账分开，用户账单上能一眼看出是「收回」。 */
const LEDGER_TYPE_CLAWBACK_INVITER = 'REFERRAL_REWARD_CLAWBACK';

/** Prisma 把唯一索引冲突报成 P2002。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** 推广人这条记录该拿多少：单码覆盖优先，否则用全局默认。 */
export function resolveInviterReward(code: ReferralCode | null, config: ReferralConfig): number {
  const override = code?.rewardAmount ?? null;
  if (override !== null && Number.isSafeInteger(override) && override >= 0) return override;
  return config.rewardAmount;
}

type RecordInstance = ExtensionInstance<ReferralRecord>;

/**
 * 把一个归因记录推进到目标状态，并在需要时入账。
 *
 * 数据写入与钱包入账放在同一个 `ctx.tx` 里：要么「记录已结清 + 钱已到账」同时
 * 成立，要么都不成立，不会出现记录说已发但账上没钱（或反之）的中间态。
 */
async function settleRecord(
  record: RecordInstance,
  patch: Partial<ReferralRecord>,
  payout: {
    userId: string;
    amount: number;
    currency: string;
    referenceId: string;
    ledgerType: string;
    note: string;
  } | null,
): Promise<'paid' | 'already-paid'> {
  const pluginCtx = context();
  const nextSpec: ReferralRecord = { ...record.spec, ...patch };
  try {
    await pluginCtx.tx(async (tx) => {
      await tx.extensions.update<ReferralRecord>(recordModel, record.name, nextSpec, {
        expectedVersion: record.version,
      });
      if (payout && payout.amount > 0) {
        await tx.wallet.credit(payout.userId, payout.amount, payout.currency, {
          type: payout.ledgerType,
          referenceType: REFERRAL_REFERENCE_TYPE,
          referenceId: payout.referenceId,
          note: payout.note,
        });
      }
    });
    // 奖励入账是「钱」的事实，必须回执。幂等键绑定 referenceId：钱包账本的唯一索引
    // 已保证只入账一次，通知同样只应出现一次（重放命中 P2002 时不会走到这里）。
    if (payout && payout.amount > 0) {
      await notifyPayout(pluginCtx, payout);
    }
    return 'paid';
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // 钱之前已经发过（幂等命中）。这里只把记录状态补齐，绝不重复入账。
    pluginCtx.logger.warn(
      `referral: 奖励已发放，跳过重复入账 ${payout?.referenceId ?? record.name}`,
    );
    const latest = await pluginCtx.extensions.get<ReferralRecord>(recordModel, record.name);
    if (latest && latest.spec.inviterState !== nextSpec.inviterState) {
      await pluginCtx.extensions.update<ReferralRecord>(recordModel, record.name, nextSpec, {
        expectedVersion: latest.version,
      });
    }
    return 'already-paid';
  }
}

/** 取记录的最新版本。 */
async function latestRecord(record: RecordInstance): Promise<RecordInstance> {
  const fresh = await context().extensions.get<ReferralRecord>(recordModel, record.name);
  return fresh ?? record;
}

/** 发放推广人奖励。已在 paid 状态的记录直接跳过。 */
export async function awardInviter(
  record: RecordInstance,
  code: ReferralCode | null,
  config: ReferralConfig,
): Promise<'paid' | 'already-paid' | 'skipped'> {
  const current = await latestRecord(record);
  if (current.spec.inviterState === 'paid') return 'already-paid';
  if (current.spec.inviterState === 'rejected') return 'skipped';

  const amount = resolveInviterReward(code, config);
  const now = new Date().toISOString();
  return settleRecord(
    current,
    { inviterState: 'paid', rewardAmount: amount, paidAt: now },
    amount > 0
      ? {
          userId: record.spec.inviterId,
          amount,
          currency: config.currency,
          referenceId: `${record.name}:inviter`,
          ledgerType: LEDGER_TYPE_INVITER,
          note: `推广奖励 ${record.spec.code}`,
        }
      : null,
  );
}

/** 发放被邀请人注册奖励；与触发档位无关，归因成立即发。 */
export async function awardInvitee(
  record: RecordInstance,
  config: ReferralConfig,
): Promise<'paid' | 'already-paid' | 'skipped'> {
  const current = await latestRecord(record);
  if (current.spec.inviteeState === 'paid') return 'already-paid';

  const amount = config.inviteeRewardAmount;
  return settleRecord(
    current,
    { inviteeState: 'paid', inviteeRewardAmount: amount },
    amount > 0
      ? {
          userId: record.spec.inviteeId,
          amount,
          currency: config.currency,
          referenceId: `${record.name}:invitee`,
          ledgerType: LEDGER_TYPE_INVITEE,
          note: '推广注册奖励',
        }
      : null,
  );
}

/** 标记归因记录被风控拒绝（不发任何奖励）。 */
export async function rejectRecord(record: RecordInstance, reason: string): Promise<void> {
  const pluginCtx = context();
  pluginCtx.logger.warn(`referral: 归因被拒绝 ${record.name} ${reason}`);
  await pluginCtx.extensions.update<ReferralRecord>(
    recordModel,
    record.name,
    { ...record.spec, inviterState: 'rejected' },
    { expectedVersion: record.version },
  );
}

/** 首单支付把 pending 记录推进为合格，并立即给推广人发奖。 */
export async function qualifyByOrder(
  record: RecordInstance,
  orderId: string,
  code: ReferralCode | null,
  config: ReferralConfig,
): Promise<void> {
  if (record.spec.inviterState !== 'pending') return;
  const qualified: RecordInstance = {
    ...record,
    spec: { ...record.spec, qualifiedOrderId: orderId, qualifiedAt: new Date().toISOString() },
  };
  // 先落订单标记再发奖（发奖会写 inviterState=paid，两者在同一事务里各自更新一版）。
  const pluginCtx = context();
  await pluginCtx.extensions.update<ReferralRecord>(recordModel, record.name, qualified.spec, {
    expectedVersion: record.version,
  });
  const latest = await pluginCtx.extensions.get<ReferralRecord>(recordModel, record.name);
  if (!latest) return;
  await awardInviter(latest, code, config);
}

/** 追回一侧奖励的结果。 */
export type ClawbackOutcome = 'clawed' | 'nothing-to-claw' | 'insufficient-balance';

/**
 * 追回一侧奖励。
 *
 * 三个刻意的设计决定：
 *
 * 1. **扣回失败不阻断退款**。`wallet.debit` 在余额不足时抛 409。这笔钱可能已经被
 *    用户花掉，此时让退款整体失败是错的 —— 退款是商店对用户的承诺，推广追回是
 *    平台与推广人之间的账。所以余额不足时**仍然**把记录标成 `clawed_back`，
 *    但记 `clawedBackAmount` 为实际扣到的金额（这里是 0），由后台人工补扣。
 *    这样账不会说谎：状态表示「应当追回」，金额表示「真正追回了多少」。
 *
 * 2. **扣回用独立 referenceId**（`:inviter:clawback`）。账本幂等键是
 *    `(referenceType, referenceId)`，若复用入账时的 id，第二次投递会被当成
 *    「已存在」而静默跳过；独立 id 让「入账」与「扣回」各自幂等。
 *
 * 3. **只处理 paid 状态**。`pending` 还没发钱，`rejected` 从来没发过，
 *    `clawed_back` 已追回过 —— 三种都无需动作，天然幂等。
 */
async function clawbackSide(input: {
  record: RecordInstance;
  userId: string;
  amount: number;
  currency: string;
  referenceId: string;
  ledgerType: string;
  note: string;
}): Promise<ClawbackOutcome> {
  if (input.amount <= 0) return 'nothing-to-claw';
  const pluginCtx = context();
  try {
    await pluginCtx.wallet.debit(input.userId, input.amount, input.currency, {
      type: input.ledgerType,
      referenceType: REFERRAL_REFERENCE_TYPE,
      referenceId: input.referenceId,
      note: input.note,
    });
    return 'clawed';
  } catch (error) {
    // 账本幂等命中：这笔已经扣过了。对调用方而言结果相同。
    if (isUniqueViolation(error)) return 'clawed';
    if (isWalletError(error) && error.code === 'wallet.insufficient_balance') {
      pluginCtx.logger.warn(
        `referral: 追回失败（余额不足），已标记待追回 ${input.userId} ${input.amount}`,
      );
      return 'insufficient-balance';
    }
    throw error;
  }
}

/**
 * 整单退款后追回推广奖励。
 *
 * 触发语义：**只有整单撤销**才追回。部分退款按比例扣佣金会把规则变成一团算术，
 * 且无法向用户解释「退了 30% 为什么佣金扣 31%」；整单撤销才是「这笔交易没发生」。
 *
 * 被邀请人奖励**不追回**：它是「注册」的对价，注册事实并未因退款消失。这是刻意的
 * 产品判断，不是遗漏 —— 若将来要追回，应作为独立的配置项，而不是默认行为。
 */
export async function clawbackByRefund(input: {
  record: RecordInstance;
  orderId: string;
  currency: string;
}): Promise<{ inviter: ClawbackOutcome; invitee: 'not-applicable' }> {
  const current = await latestRecord(input.record);
  if (current.spec.inviterState !== 'paid') {
    return { inviter: 'nothing-to-claw', invitee: 'not-applicable' };
  }
  const amount = current.spec.rewardAmount;
  const outcome = await clawbackSide({
    record: current,
    userId: current.spec.inviterId,
    amount,
    currency: input.currency,
    referenceId: `${current.name}:inviter:clawback`,
    ledgerType: LEDGER_TYPE_CLAWBACK_INVITER,
    note: `推广奖励追回（订单 ${input.orderId} 整单退款）`,
  });
  const pluginCtx = context();
  await pluginCtx.extensions.update<ReferralRecord>(
    recordModel,
    current.name,
    {
      ...current.spec,
      inviterState: 'clawed_back',
      // 实际扣到多少就记多少：余额不足时为 0，后台据此人工补扣。
      clawedBackAmount: outcome === 'clawed' ? amount : 0,
      clawedBackAtMs: Date.now(),
      clawedBackOrderId: input.orderId,
    },
    { expectedVersion: current.version },
  );
  return { inviter: outcome, invitee: 'not-applicable' };
}

/** 奖励入账回执（best-effort）：失败只告警，绝不回滚已入账的钱。 */
async function notifyPayout(
  pluginCtx: ReturnType<typeof context>,
  payout: { userId: string; amount: number; currency: string; referenceId: string; note: string },
): Promise<void> {
  try {
    await pluginCtx.notifications.upsert({
      userId: payout.userId,
      dedupeKey: `referral:reward:${payout.referenceId}`,
      type: 'referral.reward.paid',
      title: '推广奖励已到账',
      body: `${payout.note}：${formatMinorCurrency(payout.amount, payout.currency, 'zh-CN')} 已存入你的钱包。`,
      link: '/account/balance',
      data: {
        amount: payout.amount,
        currency: payout.currency,
        referenceId: payout.referenceId,
      },
      status: 'success',
    });
  } catch (error) {
    pluginCtx.logger.warn(
      `referral: reward notification failed for ${payout.userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
