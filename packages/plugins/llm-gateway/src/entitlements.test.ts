/**
 * 套餐权益（B1）契约测试。
 *
 * 只测纯逻辑：选择顺序、有效期、模型覆盖、金额拆分。扣减（条件更新）在
 * `billing` 集成路径里覆盖，因为它依赖 extension client 的原子语义。
 */
import { describe, expect, it } from 'vitest';
import {
  coversModel,
  entitlementStatusOf,
  isLive,
  pickEntitlement,
  remainingOf,
  splitSettlement,
} from './entitlements.js';
import type { EntitlementRow } from './repository.js';

function row(over: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    id: 'ent-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    userId: 'u1',
    name: '测试包',
    source: 'admin',
    productId: '',
    orderId: '',
    serviceId: '',
    quotaAmount: 1_000,
    usedAmount: 0,
    models: [],
    startsAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    status: 'ACTIVE',
    priority: 0,
    ...over,
  } as EntitlementRow;
}

describe('remainingOf', () => {
  it('subtracts usage and floors at zero', () => {
    expect(remainingOf({ quotaAmount: 1_000, usedAmount: 400 })).toBe(600);
    expect(remainingOf({ quotaAmount: 1_000, usedAmount: 5_000 })).toBe(0);
  });

  it('treats quota 0 as unlimited', () => {
    expect(remainingOf({ quotaAmount: 0, usedAmount: 999 })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isLive', () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');

  it('requires ACTIVE status and a future expiry', () => {
    expect(isLive(row(), now)).toBe(true);
    expect(isLive(row({ status: 'REVOKED' }), now)).toBe(false);
    expect(isLive(row({ expiresAt: '2026-10-01T00:00:00.000Z' }), now)).toBe(false);
    expect(isLive(row({ expiresAt: null }), now)).toBe(true);
  });

  it('treats an unparsable expiry as expired', () => {
    expect(isLive(row({ expiresAt: 'not-a-date' }), now)).toBe(false);
  });
});

describe('coversModel', () => {
  it('covers everything when the list is empty', () => {
    expect(coversModel({ models: [] }, 'gpt-4o')).toBe(true);
  });

  it('requires an exact model match otherwise', () => {
    expect(coversModel({ models: ['gpt-4o'] }, 'gpt-4o')).toBe(true);
    expect(coversModel({ models: ['gpt-4o'] }, 'gpt-4o-mini')).toBe(false);
    expect(coversModel({ models: ['gpt-4o'] }, '')).toBe(false);
  });
});

describe('pickEntitlement', () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');

  it('skips expired, revoked, exhausted and out-of-scope rows', () => {
    const rows = [
      row({ id: 'expired', expiresAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'revoked', status: 'REVOKED' }),
      row({ id: 'used-up', usedAmount: 1_000 }),
      row({ id: 'other-model', models: ['claude-3'] }),
    ];
    expect(pickEntitlement(rows, 'gpt-4o', now)).toBeNull();
  });

  it('prefers lower priority, then the soonest expiry', () => {
    const rows = [
      row({ id: 'p1-late', priority: 1, expiresAt: '2027-01-01T00:00:00.000Z' }),
      row({ id: 'p0-late', priority: 0, expiresAt: '2026-12-01T00:00:00.000Z' }),
      row({ id: 'p0-soon', priority: 0, expiresAt: '2026-11-01T00:00:00.000Z' }),
    ];
    expect(pickEntitlement(rows, 'gpt-4o', now)?.id).toBe('p0-soon');
  });

  it('returns null for an empty list', () => {
    expect(pickEntitlement([], 'gpt-4o', now)).toBeNull();
  });
});

describe('splitSettlement', () => {
  it('charges the entitlement first and the wallet for the rest', () => {
    expect(splitSettlement(300, 100)).toEqual({ entitlement: 100, wallet: 200 });
    expect(splitSettlement(100, 500)).toEqual({ entitlement: 100, wallet: 0 });
    expect(splitSettlement(100, 0)).toEqual({ entitlement: 0, wallet: 100 });
  });

  it('handles unlimited and zero amounts', () => {
    expect(splitSettlement(250, Number.POSITIVE_INFINITY)).toEqual({
      entitlement: 250,
      wallet: 0,
    });
    expect(splitSettlement(0, 100)).toEqual({ entitlement: 0, wallet: 0 });
  });
});

describe('entitlementStatusOf', () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');

  it('derives revoked/expired/exhausted/active', () => {
    expect(entitlementStatusOf(row({ status: 'REVOKED' }), now)).toBe('REVOKED');
    expect(entitlementStatusOf(row({ expiresAt: '2026-10-01T00:00:00.000Z' }), now)).toBe(
      'EXPIRED',
    );
    expect(entitlementStatusOf(row({ usedAmount: 1_000 }), now)).toBe('EXHAUSTED');
    expect(entitlementStatusOf(row(), now)).toBe('ACTIVE');
  });
});
