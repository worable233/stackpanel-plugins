/**
 * 账号排序契约测试（目标一 routing + 目标六 账号选择）。
 *
 * 只测**纯函数** `orderCandidates` / `accountProtocol`（`pickAccount` 要查 DB 与
 * state，属集成测试范畴）。锁死的行为：
 * - 模型白名单：同时匹配对外名与上游名，空 = 不限；
 * - 同入口协议优先，没有同协议账号时才放开跨协议；
 * - 亲和标签只调序不筛除（标签写错不会把整批请求打成 502）；
 * - 优先级降序，同优先级内加权随机。
 */
import { describe, expect, it } from 'vitest';
import { accountProtocol, orderCandidates } from './routing.js';
import type { AccountRow } from './repository.js';

function account(overrides: Partial<AccountRow> & { id: string }): AccountRow {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    provider: 'openai-chat',
    baseUrl: 'https://upstream.example',
    apiKeyRef: 'ref',
    models: [],
    status: 'ACTIVE',
    priority: 0,
    weight: 100,
    maxConcurrency: 0,
    options: {},
    rpmLimit: 0,
    enabled: true,
    affinity: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  } as AccountRow;
}

describe('accountProtocol', () => {
  it('returns the declared provider when it is a known protocol', () => {
    expect(accountProtocol(account({ id: 'a', provider: 'anthropic' }))).toBe('anthropic');
    expect(accountProtocol(account({ id: 'a', provider: 'gemini' }))).toBe('gemini');
  });

  it('falls back to openai-chat for an unknown provider', () => {
    expect(accountProtocol(account({ id: 'a', provider: 'legacy-openai-chat' }))).toBe(
      'openai-chat',
    );
    expect(accountProtocol(account({ id: 'a', provider: 'totally-made-up' }))).toBe(
      'openai-chat',
    );
  });
});

describe('orderCandidates', () => {
  it('keeps accounts whose model whitelist matches the public or upstream name', () => {
    const accounts = [
      account({ id: 'public', models: ['public-alias'] }),
      account({ id: 'upstream', models: ['real-model'] }),
      account({ id: 'open', models: [] }),
      account({ id: 'other', models: ['unrelated'] }),
    ];
    const ordered = orderCandidates(
      accounts,
      { model: 'public-alias', ingress: 'openai-chat', affinity: '' },
      'real-model',
    );
    const ids = ordered.map((a) => a.id);
    expect(ids).toContain('public');
    expect(ids).toContain('upstream');
    expect(ids).toContain('open');
    expect(ids).not.toContain('other');
  });

  it('returns nothing when no account serves the model', () => {
    const ordered = orderCandidates(
      [account({ id: 'a', models: ['only-this'] })],
      { model: 'something-else', ingress: 'openai-chat', affinity: '' },
      'something-else',
    );
    expect(ordered).toEqual([]);
  });

  it('prefers accounts whose protocol matches the ingress', () => {
    const accounts = [
      account({ id: 'anthropic', provider: 'anthropic' }),
      account({ id: 'openai', provider: 'openai-chat' }),
    ];
    const ordered = orderCandidates(accounts, {
      model: 'x',
      ingress: 'openai-chat',
      affinity: '',
    });
    expect(ordered.map((a) => a.id)).toEqual(['openai']);
  });

  it('falls back to cross-protocol accounts only when none matches the ingress', () => {
    const accounts = [account({ id: 'anthropic', provider: 'anthropic' })];
    const ordered = orderCandidates(accounts, {
      model: 'x',
      ingress: 'openai-chat',
      affinity: '',
    });
    expect(ordered.map((a) => a.id)).toEqual(['anthropic']);
  });

  it('reorders by affinity without ever filtering accounts out', () => {
    const accounts = [
      account({ id: 'plain', affinity: '' }),
      account({ id: 'tagged', affinity: 'eu' }),
    ];
    const ordered = orderCandidates(accounts, {
      model: 'x',
      ingress: 'openai-chat',
      affinity: 'eu',
    });
    expect(ordered.map((a) => a.id)).toEqual(['tagged', 'plain']);

    // 亲和标签谁都不匹配时仍返回全部账号（只调序不筛除）。
    const noMatch = orderCandidates(accounts, {
      model: 'x',
      ingress: 'openai-chat',
      affinity: 'apac',
    });
    expect(new Set(noMatch.map((a) => a.id))).toEqual(new Set(['plain', 'tagged']));
  });

  it('sorts by priority descending', () => {
    const accounts = [
      account({ id: 'low', priority: 1 }),
      account({ id: 'high', priority: 10 }),
      account({ id: 'mid', priority: 5 }),
    ];
    const ordered = orderCandidates(accounts, {
      model: 'x',
      ingress: 'openai-chat',
      affinity: '',
    });
    expect(ordered.map((a) => a.id)).toEqual(['high', 'mid', 'low']);
  });
});
