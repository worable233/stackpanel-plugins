/**
 * 路由模块（目标一 routing + 目标六 账号选择）。
 *
 * 职责：给定「对外模型名 + 入口协议 + 亲和标签」，从账号池里挑出一个可用上游，
 * 并拿下它的并发位。这里**不做**限流与预留——那是 scheduler / billing 的事，
 * 顺序由 relay 编排（先预留、再选号，见 billing.ts 的顺序纪律）。
 *
 * 与旧实现的差别：
 * - 旧 `pickAccount` 只看 `status === 'ACTIVE'`，不读 `enabled`，不查健康/冷却/
 *   熔断，也不看账号自身的 `rpmLimit`。结果是被熔断的账号还会被反复选中。
 * - 旧实现把加权随机与协议优先混在一个函数里；这里拆成「构造有序候选」与
 *   「占位」两步，纯函数的排序可以单测，占位只做一次后端往返。
 */

import type { StateLease } from '@stackpanel/sdk';
import type { Protocol } from '@stackpanel/llm-protocol';
import { isProtocol } from '@stackpanel/llm-protocol';
import { toStringArray } from './keys.js';
import { listActiveAccounts, type AccountRow } from './repository.js';
import { weightedOrder } from './scheduler.js';
import type { Scheduler } from './scheduler.js';

/** 账号的协议（非法值回退到 openai-chat，兼容历史 `provider: 'openai-chat'`）。 */
export function accountProtocol(account: AccountRow): Protocol {
  return isProtocol(account.provider) ? account.provider : 'openai-chat';
}

export interface OrderInput {
  /** 对外公开模型名（用户请求里的 model）。 */
  model: string;
  /** 入口协议。 */
  ingress: Protocol;
  /** 渠道亲和标签（请求头 `x-gateway-affinity`）；空串表示不指定。 */
  affinity: string;
}

/**
 * 账号是否对该模型开放。
 *
 * `models` 为空 = 不限；`model` 为空（如 `GET /v1/models` 的元请求）= 不限。
 * 同时匹配对外名与实际上游名：账号配置里写哪个都应该命中，否则改一次
 * `upstreamModel` 映射就会让账号静默不可用。
 */
function servesModel(account: AccountRow, model: string, upstreamModel: string): boolean {
  const models = toStringArray(account.models);
  if (models.length === 0) return true;
  if (model === '') return true;
  return models.includes(model) || (upstreamModel !== '' && models.includes(upstreamModel));
}

/**
 * 构造有序候选列表：亲和命中优先 → 同协议优先 → 优先级降序 → 同优先级加权随机。
 *
 * 亲和（目标六 channel affinity）：带 `x-gateway-affinity: foo` 的请求优先命中
 * `affinity === 'foo'` 的账号——用于把某类流量钉在特定渠道（按地区、按结算主体
 * 分组）。亲和**只调序不筛除**：亲和账号全满时仍会回落到其它账号，否则一个标签
 * 写错就会让整批请求 502。
 *
 * 同协议优先（避免跨协议转换带来的字段损失），没有同协议账号时才放开转换。
 */
export function orderCandidates(
  accounts: readonly AccountRow[],
  input: OrderInput,
  upstreamModel = '',
): AccountRow[] {
  const eligible = accounts.filter((account) => servesModel(account, input.model, upstreamModel));
  if (eligible.length === 0) return [];

  const sameProtocol = eligible.filter((account) => accountProtocol(account) === input.ingress);
  const pool = sameProtocol.length > 0 ? sameProtocol : eligible;

  const affinity = input.affinity.trim();
  const preferred = affinity
    ? pool.filter((account) => (account.affinity ?? '').trim() === affinity)
    : [];
  const remainder = affinity
    ? pool.filter((account) => (account.affinity ?? '').trim() !== affinity)
    : pool;

  const byPriority = (list: readonly AccountRow[]): AccountRow[] => {
    const groups = new Map<number, AccountRow[]>();
    for (const account of list) {
      const group = groups.get(account.priority);
      if (group) group.push(account);
      else groups.set(account.priority, [account]);
    }
    const out: AccountRow[] = [];
    for (const priority of [...groups.keys()].sort((a, b) => b - a)) {
      out.push(...weightedOrder(groups.get(priority) ?? []));
    }
    return out;
  };

  return [...byPriority(preferred), ...byPriority(remainder)];
}

export interface PickAccountInput extends OrderInput {
  upstreamModel: string;
  scheduler: Scheduler;
  /**
   * 本次尝试中已经失败过（或其 key 全部在冷却）的账号 id。
   * 由 relay 在重试/换号时累积，避免把同一个账号反复选中。
   */
  excludeAccountIds?: ReadonlySet<string>;
}

export interface PickedAccount {
  account: AccountRow;
  lease: StateLease;
  /** 该账号的协议（调用方用它决定是否走直通）。 */
  protocol: Protocol;
}

/**
 * 挑账号并拿下并发位。
 *
 * 顺序：候选构造（纯）→ 过滤健康（熔断/冷却，失败开放）→ 批量占位。
 *
 * 健康过滤放在占位**之前**：把已知熔断的账号排除在候选之外，避免为它白白占一个
 * 并发位再退回来（旧实现就是这个浪费）。代价是「查询与占位之间账号刚被打熔断」
 * 仍可能被选中——这由 relay 的失败重试兜底（下一轮会重新查健康）。
 *
 * @returns 无可用账号（全部禁用 / 满载 / 熔断 / 冷却）时返回 null
 */
export async function pickAccount(input: PickAccountInput): Promise<PickedAccount | null> {
  const accounts = await listActiveAccounts();
  if (accounts.length === 0) return null;

  // `enabled === false` 是运维手动摘除：不进候选（与 status 不同——status 表达
  // 账号本身的有效性，enabled 表达「此刻是否参与」）。
  const excluded = input.excludeAccountIds ?? new Set<string>();
  const manual = accounts.filter(
    (account) => account.enabled !== false && !excluded.has(account.id),
  );
  if (manual.length === 0) return null;

  const ordered = orderCandidates(manual, input, input.upstreamModel);
  if (ordered.length === 0) return null;

  // 逐账号查健康状态。查不到（Redis 抖动 / 从未写过）按健康处理：失败开放，
  // 否则一次 state 故障会让整个网关 502。所有账号都不可用时再返回 null。
  const health = await Promise.all(
    ordered.map((account) => input.scheduler.isServable(account.id).catch(() => true)),
  );
  const healthy = ordered.filter((_, index) => health[index] !== false);
  if (healthy.length === 0) return null;

  const leased = await input.scheduler.acquireAccountLease(
    healthy.map((account) => ({ id: account.id, maxConcurrency: account.maxConcurrency })),
  );
  if (!leased) return null;

  const account = healthy.find((candidate) => candidate.id === leased.accountId);
  if (!account) {
    // 租约反查不到账号（账号在两次读之间被删除）：把位子还回去，避免泄漏。
    await input.scheduler.releaseAccountLease(leased.lease).catch(() => false);
    return null;
  }

  return { account, lease: leased.lease, protocol: accountProtocol(account) };
}
