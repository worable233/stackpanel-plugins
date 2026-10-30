/**
 * 长周期配额（P1）契约测试。
 *
 * 锁死的纪律：
 * - 次数配额必须**原子占用**（先 incr 后判），否则并发请求会一起放行；
 * - 被拒时**必须回滚**自己那次 incr，不能虚增用量；
 * - 窗口序号进键名 → 换窗口自动归零，不需要清理；
 * - token 配额是**软上限**（请求跑完才知道真实用量）；
 * - 状态后端故障时**失败开放**（配额是止损手段，不是安全边界）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { StateService } from '@stackpanel/sdk';
import { bindContext } from './context.js';
import {
  checkQuota,
  quotaKey,
  quotaTtlMs,
  recordQuotaTokens,
  releaseQuotaRequest,
  retryAfterOf,
  windowIndex,
  type QuotaRule,
} from './quota.js';

/** 极简 state：只实现本模块用到的 get/set/incr/decr。 */
function makeState(): StateService & { dump: () => Record<string, string> } {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    dump: () => Object.fromEntries(data),
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string, ttlMs?: number) {
      data.set(key, value);
      if (ttlMs && ttlMs > 0) ttls.set(key, ttlMs);
    },
    async incr(key: string, ttlMs?: number) {
      const next = (Number.parseInt(data.get(key) ?? '0', 10) || 0) + 1;
      data.set(key, String(next));
      if (!ttls.has(key) && ttlMs && ttlMs > 0) ttls.set(key, ttlMs);
      return next;
    },
    async decr(key: string) {
      const next = Math.max(0, (Number.parseInt(data.get(key) ?? '0', 10) || 0) - 1);
      data.set(key, String(next));
      return next;
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as StateService & { dump: () => Record<string, string> };
}

const RULE: QuotaRule = {
  scope: 'key',
  windowHours: 6,
  maxRequests: 3,
  maxTokens: 0,
  enabled: true,
};

const AT = new Date('2026-10-30T12:00:00Z');

beforeEach(() => {
  // quota.ts 通过 context 的 state() 取后端。
  bindContext({
    state: makeState(),
  } as never);
});

describe('windowIndex / quotaKey', () => {
  it('同一窗口内的时刻共享同一序号', () => {
    const a = windowIndex(6, new Date('2026-10-30T00:00:00Z'));
    const b = windowIndex(6, new Date('2026-10-30T05:59:59Z'));
    expect(a).toBe(b);
  });

  it('跨窗口序号递增', () => {
    const a = windowIndex(6, new Date('2026-10-30T05:59:59Z'));
    const b = windowIndex(6, new Date('2026-10-30T06:00:00Z'));
    expect(b).toBe(a + 1);
  });

  it('未启用 / 窗口为 0 / 上限为 0 时不生成键', () => {
    expect(quotaKey({ ...RULE, enabled: false }, 'k', 'req', AT)).toBeNull();
    expect(quotaKey({ ...RULE, windowHours: 0 }, 'k', 'req', AT)).toBeNull();
    expect(quotaKey({ ...RULE, maxRequests: 0 }, 'k', 'req', AT)).toBeNull();
    expect(quotaKey({ ...RULE, maxTokens: 0 }, 'k', 'tok', AT)).toBeNull();
  });

  it('token 键与次数键不互相污染', () => {
    const req = quotaKey(RULE, 'k1', 'req', AT);
    const tok = quotaKey(RULE, 'k1', 'tok', AT);
    expect(req).not.toBe(tok);
  });

  it('不同 key 的计数互相隔离', () => {
    expect(quotaKey(RULE, 'k1', 'req', AT)).not.toBe(quotaKey(RULE, 'k2', 'req', AT));
  });

  it('TTL 长于窗口，避免窗口最后一秒的计数提前过期', () => {
    expect(quotaTtlMs(6)).toBeGreaterThan(6 * 60 * 60 * 1000);
  });
});

describe('checkQuota（次数）', () => {
  it('前 N 次通过，第 N+1 次被拒', async () => {
    const input = { rule: RULE, keyId: 'k1', userId: 'u1', now: AT };
    for (let i = 0; i < 3; i += 1) {
      const r = await checkQuota(input);
      expect(r.allowed).toBe(true);
      expect(r.reservedKey).toBeTruthy();
    }
    const denied = await checkQuota(input);
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(3);
    expect(denied.limit).toBe(3);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // 被拒的请求不能虚增用量：计数仍是 3。
    const again = await checkQuota({ ...input, rule: { ...RULE, maxRequests: 10 } });
    expect(again.allowed).toBe(true);
  });

  it('releaseQuotaRequest 归还占用（失败请求不吃额度）', async () => {
    const input = { rule: { ...RULE, maxRequests: 1 }, keyId: 'k1', userId: 'u1', now: AT };
    const first = await checkQuota(input);
    expect(first.allowed).toBe(true);
    await releaseQuotaRequest(first);
    // 归还后还能再用一次。
    expect((await checkQuota(input)).allowed).toBe(true);
  });

  it('换窗口自动归零（无需清理旧键）', async () => {
    const at1 = new Date('2026-10-30T00:00:00Z');
    const at2 = new Date('2026-10-30T06:00:00Z');
    const small = { ...RULE, maxRequests: 1 };
    expect((await checkQuota({ rule: small, keyId: 'k', userId: 'u', now: at1 })).allowed).toBe(
      true,
    );
    expect((await checkQuota({ rule: small, keyId: 'k', userId: 'u', now: at1 })).allowed).toBe(
      false,
    );
    // 新窗口重新开始。
    expect((await checkQuota({ rule: small, keyId: 'k', userId: 'u', now: at2 })).allowed).toBe(
      true,
    );
  });

  it('scope=user 时多个 key 共享额度', async () => {
    const userScoped: QuotaRule = { ...RULE, scope: 'user', maxRequests: 2 };
    expect(
      (await checkQuota({ rule: userScoped, keyId: 'k1', userId: 'u1', now: AT })).allowed,
    ).toBe(true);
    expect(
      (await checkQuota({ rule: userScoped, keyId: 'k2', userId: 'u1', now: AT })).allowed,
    ).toBe(true);
    // 第 3 次（换回 k1）被拒：额度按 user 合计。
    expect(
      (await checkQuota({ rule: userScoped, keyId: 'k1', userId: 'u1', now: AT })).allowed,
    ).toBe(false);
  });

  it('规则为 null / 未启用时直接放行且不占用', async () => {
    expect((await checkQuota({ rule: null, keyId: 'k', userId: 'u' })).allowed).toBe(true);
    expect(
      (await checkQuota({ rule: { ...RULE, enabled: false }, keyId: 'k', userId: 'u' })).allowed,
    ).toBe(true);
    // 没有占用 → reservedKey 为空。
    expect((await checkQuota({ rule: null, keyId: 'k', userId: 'u' })).reservedKey).toBeFalsy();
  });
});

describe('checkQuota（token 软上限）', () => {
  const tokenRule: QuotaRule = {
    scope: 'key',
    windowHours: 6,
    maxRequests: 0,
    maxTokens: 100,
    enabled: true,
  };

  it('已用 token 达到上限后拒绝后续请求', async () => {
    const input = { rule: tokenRule, keyId: 'k1', userId: 'u1', now: AT };
    expect((await checkQuota(input)).allowed).toBe(true);
    await recordQuotaTokens({ ...input, tokens: 100 });
    const denied = await checkQuota(input);
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(100);
    expect(denied.limit).toBe(100);
  });

  it('token 未达上限时放行', async () => {
    const input = { rule: tokenRule, keyId: 'k1', userId: 'u1', now: AT };
    await recordQuotaTokens({ ...input, tokens: 99 });
    expect((await checkQuota(input)).allowed).toBe(true);
  });

  it('recordQuotaTokens 累加而非覆盖', async () => {
    const input = { rule: tokenRule, keyId: 'k1', userId: 'u1', now: AT };
    await recordQuotaTokens({ ...input, tokens: 30 });
    await recordQuotaTokens({ ...input, tokens: 40 });
    // 30 + 40 + 30 = 100 → 达上限，应被拒。若实现是「覆盖」则只有 30，会被放行。
    await recordQuotaTokens({ ...input, tokens: 30 });
    expect((await checkQuota(input)).allowed).toBe(false);
  });

  it('0 / 负数 token 不记（上游可能报 0 用量）', async () => {
    const input = { rule: tokenRule, keyId: 'k1', userId: 'u1', now: AT };
    await recordQuotaTokens({ ...input, tokens: 0 });
    await recordQuotaTokens({ ...input, tokens: -5 });
    expect((await checkQuota(input)).allowed).toBe(true);
  });
});

describe('失败开放', () => {
  it('状态后端抛错时放行（不因状态抖动全站 429）', async () => {
    bindContext({
      state: {
        async get() {
          throw new Error('state down');
        },
        async set() {
          throw new Error('state down');
        },
        async incr() {
          throw new Error('state down');
        },
        async decr() {
          throw new Error('state down');
        },
      },
    } as never);
    const r = await checkQuota({ rule: RULE, keyId: 'k', userId: 'u', now: AT });
    expect(r.allowed).toBe(true);
  });

  it('recordQuotaTokens 失败时不抛（计费已完成，配额记账不能反向影响）', async () => {
    bindContext({
      state: {
        async get() {
          throw new Error('state down');
        },
        async set() {
          throw new Error('state down');
        },
        async incr() {
          throw new Error('state down');
        },
        async decr() {
          throw new Error('state down');
        },
      },
    } as never);
    await expect(
      recordQuotaTokens({ rule: RULE, keyId: 'k', userId: 'u', tokens: 100, now: AT }),
    ).resolves.toBeUndefined();
  });
});

describe('retryAfterOf', () => {
  it('窗口开始时接近整个窗口长度', () => {
    const windowStart = new Date('2026-10-30T00:00:00Z');
    expect(retryAfterOf(6, windowStart)).toBe(6 * 60 * 60);
  });

  it('窗口末尾接近 0 但至少 1 秒', () => {
    const nearEnd = new Date('2026-10-30T05:59:59.500Z');
    const value = retryAfterOf(6, nearEnd);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(2);
  });
});
