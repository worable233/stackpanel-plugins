/**
 * 账号多 Key（A1）。
 *
 * 选号只决定「哪一个上游账号」。一个账号背后可以有多把 key：
 * - 主 key 仍是 `account.apiKeyRef`（旧数据无需迁移即可继续工作）；
 * - 额外的 key 存在 `account.keys[]`，每把独立 `apiKeyRef` 与权重；
 * - 某把 key 被上游限流/封禁时，只冷却这一把（state 哨兵），同账号其它 key
 *   继续可用——这是单 key 账号做不到的可用性。
 *
 * 纪律：key 级冷却**失败开放**。state 读不到时按「未冷却」处理，与
 * `Scheduler.isServable` 同一取向：一次 Redis 抖动不该让整个网关 429。
 */

import type { StateService } from '@stackpanel/sdk';
import type { AccountRow } from './repository.js';
import { weightedOrder } from './scheduler.js';

/** 主 key 的稳定 id；额外 key 的 id 由管理端生成（uuid）。 */
export const PRIMARY_KEY_ID = 'primary';

export interface AccountKey {
  id: string;
  label: string;
  apiKeyRef: string;
  /** 组内加权；越大越先被选中（与账号权重同一语义）。 */
  weight: number;
}

/** 账号的全部 key（主 key 在前），过滤掉空条目。 */
export function accountKeys(account: AccountRow): AccountKey[] {
  const primary: AccountKey = {
    id: PRIMARY_KEY_ID,
    label: 'primary',
    apiKeyRef: account.apiKeyRef,
    weight: 100,
  };
  const extra = (account.keys ?? [])
    .filter(
      (key) =>
        typeof key?.id === 'string' &&
        key.id.length > 0 &&
        key.id !== PRIMARY_KEY_ID &&
        typeof key.apiKeyRef === 'string' &&
        key.apiKeyRef.length > 0,
    )
    .map((key) => ({
      id: key.id,
      label: key.label ?? '',
      apiKeyRef: key.apiKeyRef,
      weight: Number.isFinite(key.weight) && key.weight > 0 ? Math.trunc(key.weight) : 100,
    }));
  return [primary, ...extra];
}

/** 按 id 取 key；未知 id 返回 null。 */
export function accountKeyById(account: AccountRow, id: string): AccountKey | null {
  return accountKeys(account).find((key) => key.id === id) ?? null;
}

/** key 冷却哨兵的 state 键。 */
export function keyCooldownKey(accountId: string, keyId: string): string {
  return `llm:gw:key-cool:${accountId}:${keyId}`;
}

/**
 * 该账号当前处于冷却的 key 集合。
 *
 * 一次性并发读所有 key；单个读失败按「不冷却」处理（失败开放）。
 */
export async function coolingKeys(
  state: StateService,
  accountId: string,
  keys: readonly AccountKey[],
): Promise<Set<string>> {
  const values = await Promise.all(
    keys.map((key) => state.get(keyCooldownKey(accountId, key.id)).catch(() => null)),
  );
  const cooling = new Set<string>();
  keys.forEach((key, index) => {
    if (values[index]) cooling.add(key.id);
  });
  return cooling;
}

/**
 * 挑一把可用 key。
 *
 * 顺序：加权随机（weight 越大越可能靠前）→ 跳过冷却中的与 `exclude` 里的。
 * 返回 null 表示该账号当前没有可用 key（调用方应换账号，而不是直接把请求打死）。
 */
export async function pickAccountKey(
  state: StateService,
  account: AccountRow,
  exclude: ReadonlySet<string> = new Set(),
): Promise<AccountKey | null> {
  const candidates = accountKeys(account).filter((key) => !exclude.has(key.id));
  if (candidates.length === 0) return null;
  const cooling = await coolingKeys(state, account.id, candidates);
  const usable = candidates.filter((key) => !cooling.has(key.id));
  if (usable.length === 0) return null;
  const ordered = weightedOrder(usable);
  return ordered[0] ?? null;
}

/** 冷却一把 key（写哨兵，TTL 到点自动恢复）。 */
export async function coolAccountKey(
  state: StateService,
  accountId: string,
  keyId: string,
  ttlMs: number,
  reason: string,
): Promise<void> {
  if (ttlMs <= 0) return;
  await state
    .set(keyCooldownKey(accountId, keyId), reason.slice(0, 200), ttlMs)
    .catch(() => undefined);
}

/** 清除一把 key 的冷却（成功调用后）。 */
export async function clearAccountKeyCooldown(
  state: StateService,
  accountId: string,
  keyId: string,
): Promise<void> {
  await state.del(keyCooldownKey(accountId, keyId)).catch(() => undefined);
}
