/**
 * 预算预警与限额（B3）。
 *
 * ## 为什么要放在 Redis（state）而不是查流水
 *
 * 「本月已花多少」如果每次请求都去聚合 usage-log，热路径就要扫一遍月内流水，
 * 成本随历史线性增长。这里把它做成**状态计数器**：结算时 `INCRBY`，预留前
 * `GET` 一次，O(1) 且多副本一致（state 就是内核 Redis 封装）。
 *
 * 计数器与流水的口径差异是**接受**的：进程崩溃可能丢一次增量（少算），
 * 因此限额只用于「止损与提醒」，不用来开票；对账仍以 usage-log 为准。
 *
 * ## 软硬两档
 *
 * - `action: 'warn'`：只提醒，不拦请求（阈值默认 80%，到 100% 再提醒一次）；
 * - `action: 'block'`：达到 `amountLimit` 后返回 402 `budget_exceeded`。
 *
 * 提醒按「用户 + 周期 + 档位」去重，避免每个请求都发一条通知。
 */

import { logger, pluginContext, state } from './context.js';

export type BudgetPeriod = 'day' | 'month';

export interface BudgetLimit {
  /** 目标用户；空串表示全局默认值（对未单独配置的用户生效）。 */
  userId: string;
  period: string;
  /** 限额（minor）；0 = 不限。 */
  amountLimit: number;
  /** 预警阈值百分比（1–100）。 */
  warnPercent: number;
  /** warn = 只提醒；block = 达限后拒绝。 */
  action: string;
  enabled: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 周期键：`month:2026-10` / `day:2026-10-07`（UTC，与 createdAt 的入库口径一致）。 */
export function periodKey(period: string, now = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  if (period === 'day') return `day:${iso}`;
  return `month:${iso.slice(0, 7)}`;
}

/** 计数器 key（周期键已含粒度，无需再拼）。 */
export function spendKey(period: string, userId: string, now = new Date()): string {
  return `llm:gw:spend:${periodKey(period, now)}:${userId}`;
}

/** 周期剩余寿命（用于给计数器设 TTL，避免无限堆积）。 */
function ttlMsOf(period: string): number {
  return period === 'day' ? 2 * DAY_MS : 40 * DAY_MS;
}

/** 选出对该用户生效的限额：用户自己的优先，其次全局（`userId === ''`）。 */
export function effectiveLimit(
  limits: readonly BudgetLimit[],
  userId: string,
  period: string,
): BudgetLimit | null {
  const candidates = limits.filter((limit) => limit.enabled && limit.period === period);
  return (
    candidates.find((limit) => limit.userId === userId) ??
    candidates.find((limit) => limit.userId === '') ??
    null
  );
}

export interface BudgetCheck {
  /** 是否放行。 */
  allowed: boolean;
  /** 生效限额；未配置为 null。 */
  limit: BudgetLimit | null;
  /** 本周期已花（minor）。 */
  spent: number;
  /** 拒绝原因（仅 allowed=false 时有值）。 */
  message?: string;
}

/**
 * 预留前检查（读计数器；state 故障时 fail-open）。
 *
 * fail-open 的理由：限额是运营风控，不是资金安全（真正的资金安全由余额预留
 * 保证）。Redis 抖动时把用户的全站 API 打死，比短暂超支更糟。
 */
export async function checkBudget(
  limits: readonly BudgetLimit[],
  userId: string,
  period: string,
  now = new Date(),
): Promise<BudgetCheck> {
  const limit = effectiveLimit(limits, userId, period);
  if (!limit || limit.amountLimit <= 0) return { allowed: true, limit, spent: 0 };
  const raw = await state()
    .get(spendKey(period, userId, now))
    .catch(() => null);
  const spent = raw ? Number(raw) : 0;
  const used = Number.isFinite(spent) ? spent : 0;
  if (limit.action === 'block' && used >= limit.amountLimit) {
    return {
      allowed: false,
      limit,
      spent: used,
      message: `本${period === 'day' ? '日' : '月'}额度已用尽（${used}/${limit.amountLimit}）`,
    };
  }
  return { allowed: true, limit, spent: used };
}

/**
 * 结算后累加计数器（尽力而为：失败只记日志，不影响计费）。
 *
 * 同时累加日/月两档——两个周期都可能被配置，多写一次 INCRBY 比按需判断更省。
 */
export async function recordSpend(userId: string, amount: number, now = new Date()): Promise<void> {
  if (!(amount > 0)) return;
  for (const period of ['day', 'month'] as const) {
    const key = spendKey(period, userId, now);
    const ttl = ttlMsOf(period);
    try {
      // state 只有 `incr(key)`（+1），没有 `incrby`。金额计数器用「锁内读改写」
      // 保证同一用户的并发结算不会互相覆盖；锁竞争时主动放弃这一次累加——
      // 限额是止损工具而非账本，少算一次远好于阻塞结算。
      const updated = await state().withLock(`${key}:lock`, 2_000, async () => {
        const raw = await state().get(key);
        const current = raw ? Number(raw) : 0;
        const base = Number.isFinite(current) ? current : 0;
        await state().set(key, String(base + amount), ttl);
      });
      if (!updated) logger().warn(`llm-gateway: budget counter ${key} busy, increment skipped`);
    } catch (error) {
      logger().warn(`llm-gateway: budget counter ${key} failed: ${String(error)}`);
    }
  }
}

/**
 * 达到阈值时的提醒（best-effort，按「用户+周期+档位」去重）。
 *
 * 只在请求路径上调用一次；`warnPercent` 与 100% 各提醒一次。
 */
export async function maybeWarnBudget(input: {
  userId: string;
  limit: BudgetLimit;
  spent: number;
  period: string;
  now?: Date;
}): Promise<void> {
  const { limit, spent } = input;
  if (!limit.enabled || limit.amountLimit <= 0) return;
  const now = input.now ?? new Date();
  const warnAt = Math.max(1, Math.min(100, Math.trunc(limit.warnPercent))) / 100;
  const tiers: Array<'warn' | 'limit'> = [];
  if (spent >= limit.amountLimit) tiers.push('limit');
  else if (spent >= limit.amountLimit * warnAt) tiers.push('warn');
  if (tiers.length === 0) return;

  const periodId = periodKey(input.period, now);
  for (const tier of tiers) {
    const sentinel = `llm:gw:budget-sent:${periodId}:${input.userId}:${tier}`;
    try {
      if (await state().get(sentinel)) continue;
      await state().set(sentinel, '1', ttlMsOf(input.period));
      const exhausted = tier === 'limit';
      await pluginContext().notifications.create({
        userId: input.userId,
        type: exhausted ? 'gateway.budget.exceeded' : 'gateway.budget.warned',
        title: exhausted ? 'API 额度已达上限' : 'API 额度接近上限',
        body: `${input.period === 'day' ? '本日' : '本月'}已使用 ${spent}/${limit.amountLimit}${
          limit.action === 'block' ? '，后续请求将被拒绝。' : '。'
        }`,
        link: '/account/api-keys',
        data: { spent, limit: limit.amountLimit, period: input.period, tier },
        status: exhausted ? 'error' : 'info',
      });
    } catch (error) {
      logger().warn(`llm-gateway: budget notification failed: ${String(error)}`);
    }
  }
}
