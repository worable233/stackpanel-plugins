/**
 * 长周期请求配额（每 X 小时 N 次 / N token）。
 *
 * ## 为什么需要它，而 `rpmLimit` 不够
 *
 * `rpmLimit` 是**60 秒固定窗口**，用来挡瞬时突发。但「零元免费模型」这类场景要的是
 * 另一种东西：**额度**——「每 6 小时 100 次」，管的是公平分配而不是抗压。两者不能
 * 互相替代：60 秒窗口下 100 次/分钟就是 6000 次/小时，免费额度瞬间被吃穿。
 *
 * ## 窗口对齐
 *
 * 用**固定窗口**（epoch 取整），不是滑动窗口。理由与 `scheduler.ts` 的 RPM 一致：
 * 对状态后端只一次往返，语义可解释（「17:00–23:59 这个窗口你用了 37 次」）。
 * 代价是窗口边界前后可以连打两倍额度。对免费额度而言这是**可接受**的：漏放的量
 * 有上界（2× 额度），而滑动窗口要为每个 key 存一份时间序列，成本高一个数量级。
 *
 * 计数键里带**窗口序号**（`Math.floor(now / windowMs)`），所以「换窗口」是天然的
 * 键变化，不需要清理旧键；TTL 只是让内存不无限增长。这一点很重要——如果用
 * 「固定键 + 到期删除」，到期瞬间的并发会把计数和 TTL 弄乱。
 *
 * ## token 配额怎么记
 *
 * 请求前无法知道真实用量，所以：
 * - **次数配额**在**准入时**先 `incr`（原子占用），超限则回滚（`decr`）并拒绝；
 * - **token 配额**结算后按真实 usage 累加，准入时只能检查已用量。
 *   这不是缺陷，是信息论的必然：token 数是上游算完才有的。所以 token 配额是
 *   **软上限**——一个请求可能让用量越过阈值，越过之后才拒绝后续请求。
 *
 * 内核 `StateService` 只有 `incr(+1)`（无 `incrBy`），100 万 token 逐个 `incr`
 * 是一百万次往返，绝不能那么写。这里用**读-改-写**（`get` + `set`）一次往返
 * 完成累加，并接受并发下偶尔丢一次增量的风险：token 配额是止损手段，不用于
 * 开票（对账仍以 usage-log 为准）。丢掉的那点计数只会让配额略宽松，不会误伤。
 */

import { state } from './context.js';

/** 一条配额规则。 */
export interface QuotaRule {
  /** 目标：key = 该 API 凭证；user = 该用户所有凭证合计。 */
  scope: string;
  /** 窗口长度（小时）。0 = 不限。 */
  windowHours: number;
  /** 窗口内最大请求次数；0 = 不限。 */
  maxRequests: number;
  /** 窗口内最大 token 数；0 = 不限。 */
  maxTokens: number;
  enabled: boolean;
}

export const QUOTA_SCOPES = ['key', 'user', 'off'] as const;

/** 窗口序号：同一窗口内的请求共享同一计数键。 */
export function windowIndex(windowHours: number, now = new Date()): number {
  const windowMs = Math.max(1, Math.round(windowHours * 60 * 60 * 1000));
  return Math.floor(now.getTime() / windowMs);
}

/**
 * 计数键。**必须**含窗口序号，见文件头注释。
 *
 * 用 `:` 分隔而不是拼接，避免 `key:a` + `b` 与 `key:ab` 撞键。
 */
export function quotaKey(
  rule: QuotaRule,
  target: string,
  kind: 'req' | 'tok',
  now = new Date(),
): string | null {
  if (!rule.enabled) return null;
  if (rule.windowHours <= 0) return null;
  if (kind === 'req' && rule.maxRequests <= 0) return null;
  if (kind === 'tok' && rule.maxTokens <= 0) return null;
  const index = windowIndex(rule.windowHours, now);
  return `gw:quota:${kind}:${rule.scope}:${target}:${index}`;
}

/** 键的 TTL：比窗口略长，保证窗口结束后旧键自然过期而不被提前清掉。 */
export function quotaTtlMs(windowHours: number): number {
  const windowMs = Math.max(1, Math.round(windowHours * 60 * 60 * 1000));
  // +60s 余量：同一窗口最后一秒写入的计数不能因 TTL 恰好到期而丢失。
  return windowMs + 60_000;
}

export interface QuotaCheck {
  allowed: boolean;
  /** 命中的规则（被拒时用于给用户提示）。 */
  rule?: QuotaRule | undefined;
  /** 已用 / 上限，被拒时填。 */
  used?: number | undefined;
  limit?: number | undefined;
  /** 当前窗口剩余秒数，作为 `Retry-After`。 */
  retryAfterSeconds?: number | undefined;
  /** 已占用、需要在拒绝时回滚的次数计数键。 */
  reservedKey?: string | null | undefined;
}

/**
 * 准入检查：次数配额原子占用，token 配额只读检查。
 *
 * 顺序是「先占后判」：`incr` 返回新值，若已超限则 `decr` 回滚并拒绝。这样并发
 * 请求不会都读到「还没满」然后一起放行（先读后写有竞态）。回滚是安全的，因为
 * 被拒的请求本就不该计数。
 *
 * 失败开放：状态后端读不到就放行。与 `scheduler.checkRpm` 一致——状态抖动不该
 * 让全站不可用；配额是止损手段，不是安全边界。
 */
export async function checkQuota(input: {
  rule: QuotaRule | null | undefined;
  keyId: string;
  userId: string;
  now?: Date;
}): Promise<QuotaCheck> {
  const rule = input.rule;
  if (!rule || !rule.enabled || rule.windowHours <= 0) return { allowed: true };
  const now = input.now ?? new Date();
  const target = rule.scope === 'user' ? input.userId : input.keyId;

  // 次数配额：原子占用。
  const reqKey = quotaKey(rule, target, 'req', now);
  if (reqKey) {
    const hits = await state()
      .incr(reqKey, quotaTtlMs(rule.windowHours))
      .catch(() => null);
    if (hits !== null && hits > rule.maxRequests) {
      await state()
        .decr(reqKey)
        .catch(() => 0);
      return {
        allowed: false,
        rule,
        used: hits - 1,
        limit: rule.maxRequests,
        retryAfterSeconds: retryAfterOf(rule.windowHours, now),
        reservedKey: null,
      };
    }
    // 通过则记住键，供调用方在后续阶段失败时回滚（见 releaseQuotaRequest）。
    if (hits !== null) {
      const tokKey = quotaKey(rule, target, 'tok', now);
      if (tokKey) {
        const used = await state()
          .get(tokKey)
          .catch(() => null);
        const usedTokens = used === null ? 0 : Number.parseInt(used, 10) || 0;
        if (usedTokens >= rule.maxTokens) {
          await state()
            .decr(reqKey)
            .catch(() => 0);
          return {
            allowed: false,
            rule,
            used: usedTokens,
            limit: rule.maxTokens,
            retryAfterSeconds: retryAfterOf(rule.windowHours, now),
            reservedKey: null,
          };
        }
      }
      return { allowed: true, reservedKey: reqKey };
    }
  }

  // 次数不限时，token 配额仍要检查。
  const tokKey = quotaKey(rule, target, 'tok', now);
  if (tokKey) {
    const used = await state()
      .get(tokKey)
      .catch(() => null);
    const usedTokens = used === null ? 0 : Number.parseInt(used, 10) || 0;
    if (usedTokens >= rule.maxTokens) {
      return {
        allowed: false,
        rule,
        used: usedTokens,
        limit: rule.maxTokens,
        retryAfterSeconds: retryAfterOf(rule.windowHours, now),
        reservedKey: null,
      };
    }
  }
  return { allowed: true, reservedKey: null };
}

/**
 * 请求在准入之后失败（上游 5xx、余额不足、客户端断开）时回滚次数占用。
 *
 * 只回滚**次数**：失败的请求没有消耗上游 token，但「用户发起了一次请求」这件事
 * 本身是否计数是策略选择。这里选择回滚——免费额度的语义是「成功用到的次数」，
 * 让上游故障吃掉用户额度会引发大量投诉。
 */
export async function releaseQuotaRequest(check: QuotaCheck): Promise<void> {
  if (!check.reservedKey) return;
  await state()
    .decr(check.reservedKey)
    .catch(() => 0);
}

/**
 * 结算后按真实 token 用量累加。永不抛错：计费已成功，配额记账不能反向影响它。
 *
 * 用 `get` + `set` 读-改-写（2 次往返）而不是逐 token `incr`（N 次往返）。
 * 并发下可能丢增量 —— 见文件头「token 配额」一节，这是刻意接受的取舍。
 */
export async function recordQuotaTokens(input: {
  rule: QuotaRule | null | undefined;
  keyId: string;
  userId: string;
  tokens: number;
  now?: Date;
}): Promise<void> {
  const rule = input.rule;
  if (!rule || !rule.enabled || rule.windowHours <= 0) return;
  if (!Number.isFinite(input.tokens) || input.tokens <= 0) return;
  const now = input.now ?? new Date();
  const target = rule.scope === 'user' ? input.userId : input.keyId;
  const tokKey = quotaKey(rule, target, 'tok', now);
  if (!tokKey) return;
  const amount = Math.floor(input.tokens);
  const ttl = quotaTtlMs(rule.windowHours);
  try {
    const current = await state().get(tokKey);
    const used = current === null ? 0 : Number.parseInt(current, 10) || 0;
    await state().set(tokKey, String(used + amount), ttl);
  } catch {
    /* 配额记账失败不影响已完成的计费 */
  }
}

/** 当前窗口剩余秒数（`Retry-After` 用）。 */
export function retryAfterOf(windowHours: number, now = new Date()): number {
  const windowMs = Math.max(1, Math.round(windowHours * 60 * 60 * 1000));
  const elapsed = now.getTime() % windowMs;
  const remainMs = windowMs - elapsed;
  return Math.max(1, Math.ceil(remainMs / 1000));
}
