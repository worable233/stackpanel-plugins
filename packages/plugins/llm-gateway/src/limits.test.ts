/**
 * 预算限额（B3）契约测试。
 *
 * 重点：
 * - 周期键必须跨用户隔离、跨周期不串；
 * - 用户级限额优先于全局默认；
 * - `warn` 只提醒、`block` 才拒绝；
 * - state 故障时 fail-open（限额不是资金安全边界）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
import { bindContext } from './context.js';
import { InMemoryState } from './state-stub.test-util.js';
import {
  checkBudget,
  effectiveLimit,
  maybeWarnBudget,
  periodKey,
  recordSpend,
  spendKey,
  type BudgetLimit,
} from './limits.js';

const notifications = { create: vi.fn(async () => ({ id: 'n1' })) };
let state: InMemoryState;

beforeEach(() => {
  state = new InMemoryState();
  notifications.create.mockClear();
  bindContext({
    state,
    notifications,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as PluginContext);
});

function limit(over: Partial<BudgetLimit> = {}): BudgetLimit {
  return {
    userId: 'u1',
    period: 'month',
    amountLimit: 1_000,
    warnPercent: 80,
    action: 'block',
    enabled: true,
    ...over,
  };
}

describe('periodKey / spendKey', () => {
  it('formats day and month keys in UTC', () => {
    const at = new Date('2026-10-07T23:30:00.000Z');
    expect(periodKey('day', at)).toBe('day:2026-10-07');
    expect(periodKey('month', at)).toBe('month:2026-10');
    expect(spendKey('month', 'u1', at)).toBe('llm:gw:spend:month:2026-10:u1');
  });
});

describe('effectiveLimit', () => {
  it('prefers the user-specific row over the global default', () => {
    const limits = [limit({ userId: '', amountLimit: 10 }), limit({ userId: 'u1' })];
    expect(effectiveLimit(limits, 'u1', 'month')?.amountLimit).toBe(1_000);
    expect(effectiveLimit(limits, 'u2', 'month')?.amountLimit).toBe(10);
  });

  it('ignores disabled rows and other periods', () => {
    expect(effectiveLimit([limit({ enabled: false })], 'u1', 'month')).toBeNull();
    expect(effectiveLimit([limit({ period: 'day' })], 'u1', 'month')).toBeNull();
  });
});

describe('checkBudget', () => {
  it('allows when no limit is configured', async () => {
    const result = await checkBudget([], 'u1', 'month');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });

  it('blocks an exhausted budget in block mode', async () => {
    await state.set(spendKey('month', 'u1'), '1000');
    const result = await checkBudget([limit()], 'u1', 'month');
    expect(result.allowed).toBe(false);
    expect(result.spent).toBe(1_000);
    expect(result.message).toContain('额度已用尽');
  });

  it('never blocks in warn mode', async () => {
    await state.set(spendKey('month', 'u1'), '999999');
    const result = await checkBudget([limit({ action: 'warn' })], 'u1', 'month');
    expect(result.allowed).toBe(true);
  });

  it('fails open when the counter backend throws', async () => {
    state.failGet = true;
    try {
      const result = await checkBudget([limit()], 'u1', 'month');
      expect(result.allowed).toBe(true);
      expect(result.spent).toBe(0);
    } finally {
      state.failGet = false;
    }
  });
});

describe('recordSpend', () => {
  it('accumulates day and month counters', async () => {
    const at = new Date('2026-10-07T12:00:00.000Z');
    await recordSpend('u1', 300, at);
    await recordSpend('u1', 200, at);
    expect(await state.get(spendKey('day', 'u1', at))).toBe('500');
    expect(await state.get(spendKey('month', 'u1', at))).toBe('500');
  });

  it('ignores non-positive amounts', async () => {
    await recordSpend('u1', 0);
    expect(await state.get(spendKey('month', 'u1'))).toBeNull();
  });

  it('swallows a state failure instead of failing the request', async () => {
    state.failSet = true;
    await expect(recordSpend('u1', 100)).resolves.toBeUndefined();
  });
});

describe('maybeWarnBudget', () => {
  it('notifies once per period and tier', async () => {
    await maybeWarnBudget({ userId: 'u1', limit: limit(), spent: 800, period: 'month' });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    await maybeWarnBudget({ userId: 'u1', limit: limit(), spent: 900, period: 'month' });
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('sends the exhausted tier when the limit is reached', async () => {
    await maybeWarnBudget({ userId: 'u1', limit: limit(), spent: 1_000, period: 'month' });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gateway.budget.exceeded' }),
    );
  });

  it('does nothing below the warning threshold', async () => {
    await maybeWarnBudget({ userId: 'u1', limit: limit(), spent: 100, period: 'month' });
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
