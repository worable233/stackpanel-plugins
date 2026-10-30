/**
 * 套餐权益的选择与抵扣（B1）。
 *
 * ## 为什么扣减发生在结算时，而不是预留时
 *
 * 钱包预留要冻结资金（`wallet.hold`），而套餐额度不是资金：它只是「还能抵多少」。
 * 若也在预留时冻结，就要再造一张「权益预留表」并在崩溃后对账。这里改成：
 * 预留阶段只**读**剩余额度决定「是否需要 hold 钱包」，结算时用条件更新
 * （`usedAmount <= quota - amount`）原子扣减；条件不满足的差额改走钱包。
 * 好处是没有中间状态需要清理，代价是同一用户并发结算时可能把「预计由套餐覆盖」
 * 的差额落到钱包——这在语义上是正确的（总额不变），只是分摊位置不同。
 *
 * ## 选择顺序
 *
 * 1. 覆盖该模型（`models` 为空 = 全部）；
 * 2. 未过期、状态 `ACTIVE`、还有剩余；
 * 3. `priority` 小的优先（运营可以把短期促销包排前面）；
 * 4. 同优先级按到期时间升序——先用掉最快要过期的额度，减少浪费。
 */

import type { EntitlementRow } from './repository.js';

/** 不限量套餐的 `quotaAmount` 约定值。 */
export const UNLIMITED_QUOTA = 0;

/** 剩余额度（minor）；不限量返回 `Infinity`。 */
export function remainingOf(entitlement: { quotaAmount: number; usedAmount: number }): number {
  if (!(entitlement.quotaAmount > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, entitlement.quotaAmount - Math.max(0, entitlement.usedAmount));
}

/** 权益是否仍然可用（状态 + 有效期）。 */
export function isLive(
  entitlement: { status: string; expiresAt?: string | null },
  now = Date.now(),
): boolean {
  if (entitlement.status !== 'ACTIVE') return false;
  const expiresAt = entitlement.expiresAt;
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  // 无法解析的到期时间按「已过期」处理：宁可要求人工修数据，也不无限放行。
  return Number.isFinite(at) && at > now;
}

/** 该权益是否覆盖模型（空 `models` = 全部）。 */
export function coversModel(entitlement: { models: readonly string[] }, model: string): boolean {
  if (entitlement.models.length === 0) return true;
  if (!model) return false;
  return entitlement.models.includes(model);
}

/**
 * 选出本次请求应使用的权益；没有可用权益返回 `null`。
 */
export function pickEntitlement(
  entitlements: readonly EntitlementRow[],
  model: string,
  now = Date.now(),
): EntitlementRow | null {
  const usable = entitlements.filter(
    (entitlement) =>
      isLive(entitlement, now) && coversModel(entitlement, model) && remainingOf(entitlement) > 0,
  );
  if (usable.length === 0) return null;
  usable.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const left = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY;
    const right = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY;
    return left - right;
  });
  return usable[0] ?? null;
}

/**
 * 把一次结算金额拆成「套餐抵扣 + 钱包实扣」。
 *
 * `remaining` 是结算时读到的剩余额度；服务端不需要知道用户买了多少包，
 * 这里只回答「这一笔能抵多少」。
 */
export function splitSettlement(
  amount: number,
  remaining: number,
): { entitlement: number; wallet: number } {
  if (!(amount > 0)) return { entitlement: 0, wallet: 0 };
  if (!(remaining > 0)) return { entitlement: 0, wallet: amount };
  const covered = Math.min(amount, Math.floor(remaining));
  return { entitlement: covered, wallet: Math.max(0, amount - covered) };
}

/** 权益状态派生（给管理端/用户端展示用，不改库）。 */
export function entitlementStatusOf(
  entitlement: {
    status: string;
    quotaAmount: number;
    usedAmount: number;
    expiresAt?: string | null;
  },
  now = Date.now(),
): string {
  if (entitlement.status === 'REVOKED') return 'REVOKED';
  if (!isLive(entitlement, now)) return 'EXPIRED';
  if (remainingOf(entitlement) <= 0) return 'EXHAUSTED';
  return 'ACTIVE';
}
