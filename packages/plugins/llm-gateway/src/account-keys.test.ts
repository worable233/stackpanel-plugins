/**
 * 账号多 Key 选择（A1）契约测试。
 *
 * 锁死四件事：
 * - 主 key 永远存在（旧数据不迁移也能用），额外 key 按权重参与；
 * - 某把 key 冷却时**只**跳过它，不是整号不可用；
 * - 全部 key 都在冷却时返回 null（调用方换号），而不是硬选一把冷却中的；
 * - state 读失败时失败开放（按未冷却处理）。
 */
import { describe, expect, it } from 'vitest';
import {
  PRIMARY_KEY_ID,
  accountKeyById,
  accountKeys,
  clearAccountKeyCooldown,
  coolAccountKey,
  coolingKeys,
  keyCooldownKey,
  pickAccountKey,
} from './account-keys.js';
import type { AccountRow } from './repository.js';
import { InMemoryState } from './state-stub.test-util.js';

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acct-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    name: 'primary-account',
    provider: 'openai-chat',
    baseUrl: 'https://api.example.com',
    apiKeyRef: 'account.acct-1',
    models: [],
    status: 'ACTIVE',
    priority: 0,
    weight: 100,
    maxConcurrency: 0,
    options: {},
    rpmLimit: 0,
    enabled: true,
    affinity: '',
    keys: [],
    balanceCurrency: '',
    ...overrides,
  };
}

describe('accountKeys', () => {
  it('always exposes the primary key first', () => {
    const keys = accountKeys(account());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: PRIMARY_KEY_ID, apiKeyRef: 'account.acct-1' });
  });

  it('appends extra keys and drops malformed entries', () => {
    const keys = accountKeys(
      account({
        keys: [
          { id: 'k1', label: 'one', apiKeyRef: 'ref-1', weight: 50 },
          { id: '', label: 'broken', apiKeyRef: 'ref-x', weight: 1 },
          { id: PRIMARY_KEY_ID, label: 'shadow', apiKeyRef: 'ref-shadow', weight: 1 },
          { id: 'k2', label: 'two', apiKeyRef: '', weight: 1 },
        ],
      }),
    );
    expect(keys.map((key) => key.id)).toEqual([PRIMARY_KEY_ID, 'k1']);
    expect(accountKeyById(account({ keys: [] }), 'nope')).toBeNull();
  });
});

describe('pickAccountKey', () => {
  it('skips keys that are cooling down', async () => {
    const state = new InMemoryState();
    const row = account({
      keys: [{ id: 'k1', label: 'one', apiKeyRef: 'ref-1', weight: 100 }],
    });
    await coolAccountKey(state, row.id, PRIMARY_KEY_ID, 60_000, '429');
    const picked = await pickAccountKey(state, row);
    expect(picked?.id).toBe('k1');
  });

  it('returns null when every key is cooling', async () => {
    const state = new InMemoryState();
    const row = account({
      keys: [{ id: 'k1', label: 'one', apiKeyRef: 'ref-1', weight: 100 }],
    });
    await coolAccountKey(state, row.id, PRIMARY_KEY_ID, 60_000, '429');
    await coolAccountKey(state, row.id, 'k1', 60_000, '429');
    expect(await pickAccountKey(state, row)).toBeNull();
  });

  it('honours the exclude set (already tried keys)', async () => {
    const state = new InMemoryState();
    const row = account({
      keys: [{ id: 'k1', label: 'one', apiKeyRef: 'ref-1', weight: 100 }],
    });
    expect(await pickAccountKey(state, row, new Set([PRIMARY_KEY_ID]))).toMatchObject({ id: 'k1' });
    expect(await pickAccountKey(state, row, new Set([PRIMARY_KEY_ID, 'k1']))).toBeNull();
  });

  it('fails open when the state read throws', async () => {
    const state = new InMemoryState();
    state.get = async () => {
      throw new Error('redis down');
    };
    const row = account();
    expect(await pickAccountKey(state, row)).toMatchObject({ id: PRIMARY_KEY_ID });
  });

  it('coolingKeys lists only keys with a sentinel', async () => {
    const state = new InMemoryState();
    const row = account({
      keys: [{ id: 'k1', label: 'one', apiKeyRef: 'ref-1', weight: 100 }],
    });
    await state.set(keyCooldownKey(row.id, 'k1'), '429', 60_000);
    const cooling = await coolingKeys(state, row.id, accountKeys(row));
    expect([...cooling]).toEqual(['k1']);
    await clearAccountKeyCooldown(state, row.id, 'k1');
    expect(await state.get(keyCooldownKey(row.id, 'k1'))).toBeNull();
  });
});
