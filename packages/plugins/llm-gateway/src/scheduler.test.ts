/**
 * 调度器契约测试（目标六）。
 *
 * 用内存 `StateService`（`state-stub.test-util.ts`）验证**纯逻辑**：
 * 四级 RPM、并发准入与失败关闭、账号带权重排序、健康/冷却/熔断、长流续租。
 *
 * 这些用例不依赖 DB / Redis，但覆盖的语义正是多实例部署里最容易出错的部分：
 * 计数必须在共享状态里、满载池不被触碰、失败策略显式（限流失败开放、并发失败关闭）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryState } from './state-stub.test-util.js';
import {
  DEFAULT_BREAKER,
  LeaseKeeper,
  Scheduler,
  weightedOrder,
  type AdmissionRequest,
} from './scheduler.js';

function admission(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    keyId: 'key-1',
    userId: 'user-1',
    model: 'test-model',
    provider: 'openai',
    keyRpm: 0,
    keyConcurrency: 0,
    userRpm: 0,
    modelRpm: 0,
    providerRpm: 0,
    globalConcurrency: 0,
    ...overrides,
  };
}

describe('Scheduler.checkRpm', () => {
  it('allows requests under the limit and rejects once the window is exceeded', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    const request = admission({ keyRpm: 2 });

    const first = await scheduler.checkRpm(request);
    const second = await scheduler.checkRpm(request);
    const third = await scheduler.checkRpm(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(429);
      expect(third.code).toBe('rate_limited');
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('checks key / user / model / provider dimensions independently', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);

    // user 维度限制为 1：第一个 key 放行，第二个 key（同用户）被拒。
    expect((await scheduler.checkRpm(admission({ userRpm: 1, keyId: 'a' }))).ok).toBe(true);
    const second = await scheduler.checkRpm(admission({ userRpm: 1, keyId: 'b' }));
    expect(second.ok).toBe(false);

    // model 维度限制为 1：换个用户仍被同模型窗口挡住。
    const modelLimited = await scheduler.checkRpm(
      admission({ modelRpm: 1, userId: 'x', keyId: 'k1' }),
    );
    expect(modelLimited.ok).toBe(true);
    const modelBlocked = await scheduler.checkRpm(
      admission({ modelRpm: 1, userId: 'y', keyId: 'k2' }),
    );
    expect(modelBlocked.ok).toBe(false);
  });

  it('fails open when the counter store throws', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    state.failIncrFor = 'gw:rpm:key:key-1';

    const result = await scheduler.checkRpm(admission({ keyRpm: 1 }));
    expect(result.ok).toBe(true);
  });

  it('treats limit <= 0 as unlimited', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    for (let i = 0; i < 10; i += 1) {
      expect((await scheduler.checkRpm(admission({ keyRpm: 0 }))).ok).toBe(true);
    }
    expect(state.leaseCountFor('gw:rpm:key:key-1')).toBe(0);
  });

  it('enforces the provider window only through checkProviderRpm (post-selection)', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);

    // 选号前 provider 恒为 null：checkRpm 不会累加 provider 窗口。
    expect((await scheduler.checkRpm(admission({ provider: null, providerRpm: 1 }))).ok).toBe(true);
    expect(await state.get('gw:rpm:provider:openai')).toBeNull();

    expect((await scheduler.checkProviderRpm('openai', 1)).ok).toBe(true);
    const blocked = await scheduler.checkProviderRpm('openai', 1);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(429);

    // limit 0 或 provider 为空 → 不限。
    expect((await scheduler.checkProviderRpm('openai', 0)).ok).toBe(true);
    expect((await scheduler.checkProviderRpm(null, 1)).ok).toBe(true);
  });

  it('enforces per-account rpm after selection', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);

    expect((await scheduler.checkAccountRpm('acct-1', 2)).ok).toBe(true);
    expect((await scheduler.checkAccountRpm('acct-1', 2)).ok).toBe(true);
    const blocked = await scheduler.checkAccountRpm('acct-1', 2);
    expect(blocked.ok).toBe(false);
    // 不同账号的窗口互相独立。
    expect((await scheduler.checkAccountRpm('acct-2', 2)).ok).toBe(true);
    // limit 0 / accountId null → 不限。
    expect((await scheduler.checkAccountRpm('acct-1', 0)).ok).toBe(true);
    expect((await scheduler.checkAccountRpm(null, 1)).ok).toBe(true);
  });
});

describe('Scheduler.checkConcurrency', () => {
  it('fails closed when the concurrency lease cannot be acquired', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    const request = admission({ keyConcurrency: 1 });

    const first = await scheduler.checkConcurrency(request);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.leases).toHaveLength(1);

    const second = await scheduler.checkConcurrency(request);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(429);
      expect(second.code).toBe('concurrency_limited');
    }

    // 释放后可以再次取位。
    if (first.ok) await state.releaseLease(first.leases[0]!);
    expect((await scheduler.checkConcurrency(request)).ok).toBe(true);
  });

  it('returns no leases when every limit is unlimited', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    const result = await scheduler.checkConcurrency(admission());
    expect(result).toEqual({ ok: true, leases: [] });
  });
});

describe('Scheduler.acquireAccountLease', () => {
  it('picks the first pool with a free seat and never touches saturated pools', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    const ordered = [
      { id: 'a', maxConcurrency: 1 },
      { id: 'b', maxConcurrency: 1 },
    ];

    const first = await scheduler.acquireAccountLease(ordered);
    expect(first?.accountId).toBe('a');

    // a 满载，应落到 b，而不是给 a 再发一个位。
    const second = await scheduler.acquireAccountLease(ordered);
    expect(second?.accountId).toBe('b');
    expect(state.leaseCountFor('gw:acct:a:inflight')).toBe(1);

    // 两个都满 → null。
    expect(await scheduler.acquireAccountLease(ordered)).toBeNull();
  });

  it('returns null for an empty candidate list', async () => {
    const scheduler = new Scheduler(new InMemoryState());
    expect(await scheduler.acquireAccountLease([])).toBeNull();
  });
});

describe('Scheduler health / cooldown / breaker', () => {
  it('opens the breaker after the failure threshold, then clears on success', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state, {
      failureThreshold: 3,
      openMs: 60_000,
      successThreshold: 1,
    });

    expect(await scheduler.isServable('acct')).toBe(true);
    await scheduler.recordFailure('acct', 'upstream 500', { retryable: true });
    await scheduler.recordFailure('acct', 'upstream 500', { retryable: true });
    const twoFailures = await scheduler.getHealth('acct');
    expect(twoFailures.failures).toBe(2);
    // 未到阈值：熔断未开路。
    expect(twoFailures.openUntil).toBe(0);

    await scheduler.recordFailure('acct', 'upstream 500', { retryable: true });
    // 第 3 次失败 → 开路（openUntil 在未来）。
    const health = await scheduler.getHealth('acct');
    expect(health.failures).toBe(3);
    expect(health.openUntil).toBeGreaterThan(Date.now());
    expect(await scheduler.isServable('acct')).toBe(false);

    await scheduler.recordSuccess('acct');
    expect(await scheduler.isServable('acct')).toBe(true);
    expect((await scheduler.getHealth('acct')).failures).toBe(0);
  });

  it('cools the account immediately on a retryable failure', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    // 一次 5xx 就进入冷却窗口：这是「失败关闭」——宁可暂时不用，也别继续打坏账号。
    await scheduler.recordFailure('acct', 'upstream 500', { retryable: true });
    expect(await scheduler.isServable('acct')).toBe(false);
    // 熔断尚未开路（未到 failureThreshold）。
    expect((await scheduler.getHealth('acct')).openUntil).toBe(0);
  });

  it('does not trip the breaker on non-retryable failures but records the error', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state, DEFAULT_BREAKER);

    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold + 2; i += 1) {
      await scheduler.recordFailure('acct', 'bad request', { retryable: false });
    }
    expect(await scheduler.isServable('acct')).toBe(true);
    expect((await scheduler.getHealth('acct')).failures).toBe(0);
    expect((await scheduler.getHealth('acct')).lastError).toContain('bad request');
  });

  it('honours an upstream Retry-After for the cooldown window', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    await scheduler.recordFailure('acct', 'rate limited', {
      retryable: true,
      retryAfterSeconds: 120,
    });
    const health = await scheduler.getHealth('acct');
    expect(health.cooldownUntil - Date.now()).toBeGreaterThan(100_000);
    expect(await scheduler.isServable('acct')).toBe(false);
  });

  it('treats an unreadable health record as healthy (fail open)', async () => {
    const state = new InMemoryState();
    await state.set('gw:health:acct', '{ not json', 60_000);
    const scheduler = new Scheduler(state);
    expect(await scheduler.isServable('acct')).toBe(true);
  });

  it('manual disable manifests as a long cooldown', async () => {
    const state = new InMemoryState();
    const scheduler = new Scheduler(state);
    await scheduler.setManualDisabled('acct', true);
    expect(await scheduler.isServable('acct')).toBe(false);
    await scheduler.setManualDisabled('acct', false);
    expect(await scheduler.isServable('acct')).toBe(true);
  });
});

describe('LeaseKeeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews the lease on each tick and keeps it alive', async () => {
    vi.useFakeTimers();
    const state = new InMemoryState();
    const lease = await state.acquireLease([{ key: 'gw:global:inflight', limit: 1 }], 10_000);
    expect(lease).not.toBeNull();

    const keeper = new LeaseKeeper(state, [lease!], 10_000);
    keeper.start();
    // 一个续期周期是 ttl/2 = 5s；走过两个周期仍然持有。
    await vi.advanceTimersByTimeAsync(12_000);
    expect(keeper.leaseLost).toBe(false);
    expect(await state.renewLease(lease!, 10_000)).toBe(true);
    await keeper.stop();
  });

  it('reports a lost lease once renewal fails', async () => {
    vi.useFakeTimers();
    const state = new InMemoryState();
    const lease = await state.acquireLease([{ key: 'gw:global:inflight', limit: 1 }], 10_000);
    expect(lease).not.toBeNull();

    const lost: string[] = [];
    const keeper = new LeaseKeeper(state, [lease!], 10_000, (l) => lost.push(l.key));
    keeper.start();
    // 租约被外部清掉（TTL 过期或他人 release），下一次续期必须失败并上报。
    await state.releaseLease(lease!);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(keeper.leaseLost).toBe(true);
    expect(lost).toEqual(['gw:global:inflight']);
    await keeper.stop();
  });

  it('is a no-op to start with no leases', async () => {
    const state = new InMemoryState();
    const keeper = new LeaseKeeper(state, [], 60_000);
    keeper.start();
    expect(keeper.leaseLost).toBe(false);
    await keeper.stop();
  });
});

describe('weightedOrder', () => {
  it('keeps every item and is deterministic when weights are equal', () => {
    const items = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ];
    const out = weightedOrder(items);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('tolerates weight 0 (never divides by zero)', () => {
    const out = weightedOrder([{ id: 'a', weight: 0 }]);
    expect(out).toEqual([{ id: 'a', weight: 0 }]);
  });
});
