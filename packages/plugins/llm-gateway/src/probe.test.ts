/**
 * 上游探测（A2）测试：测活与余额只做「读」与解析，不伪造数字。
 *
 * 用 `vi.stubGlobal('fetch')` 伪造上游，验证三条纪律：
 * - 模型清单三形态（OpenAI `data` / Anthropic `data` / Gemini `models`）都能解析；
 * - 上游非 2xx 时 `ok=false` 且保留状态码（运维要看得到 401/429）；
 * - 余额：只有明确支持的厂商才 `supported=true`，其余明说查不到。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBalance, probeAccount } from './probe.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeAccount', () => {
  it('lists OpenAI models and reports whether the target exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] })),
    );
    const result = await probeAccount({
      provider: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-y',
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gpt-x', 'gpt-y']);
    expect(result.hasModel).toBe(true);
  });

  it('understands the Gemini shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ models: [{ name: 'models/gemini-x' }] })),
    );
    const result = await probeAccount({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'k',
      model: 'gemini-x',
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gemini-x']);
  });

  it('keeps the upstream status on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 401)),
    );
    const result = await probeAccount({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.hasModel).toBeNull();
  });

  it('reports a network failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const result = await probeAccount({
      provider: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('fetchBalance', () => {
  it('computes OpenRouter remaining credits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: { total_credits: 20, total_usage: 7.5 } })),
    );
    const result = await fetchBalance({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
    });
    expect(result.supported).toBe(true);
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(12.5);
  });

  it('parses DeepSeek balance_infos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: '42.00' }] }),
      ),
    );
    const result = await fetchBalance({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
    });
    expect(result).toMatchObject({ supported: true, currency: 'CNY', amount: 42 });
  });

  it('says unsupported instead of faking zero', async () => {
    const result = await fetchBalance({
      provider: 'openai-chat',
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
    });
    expect(result.supported).toBe(false);
    expect(result.amount).toBeNull();
  });
});
