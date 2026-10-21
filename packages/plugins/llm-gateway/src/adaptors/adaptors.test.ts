/**
 * adaptor 契约测试（目标三）：13 个 provider 的请求构造 / 鉴权头 / usage 提取 /
 * 错误分类 / 重试判定。全部是纯单测，不需要 DB / Redis。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROVIDERS,
  isKnownProvider,
  listAdaptors,
  registerBuiltinAdaptors,
  resolveAdaptor,
} from './index.js';
import { customAdaptor } from './compatible.js';
import type { AdaptorAccount, AdaptorRequestInput } from './types.js';
import { parseRetryAfter, parseUpstreamError, stripUpstreamNoise } from './types.js';
import { GatewayError } from '../errors.js';
import type { IRRequest } from '../protocol.js';

registerBuiltinAdaptors();

function account(overrides: Partial<AdaptorAccount> = {}): AdaptorAccount {
  return {
    id: 'acct-1',
    name: 'test',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test-abcdefghijklmnop',
    options: {},
    ...overrides,
  };
}

function request(overrides: Partial<AdaptorRequestInput> = {}): AdaptorRequestInput {
  const ir: IRRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    stream: false,
    raw: {},
  };
  return {
    account: account(),
    body: { model: 'gpt-4o', messages: [] },
    subPath: 'v1/chat/completions',
    query: new URLSearchParams(),
    stream: false,
    ir,
    ...overrides,
  };
}

describe('provider registry', () => {
  it('exposes all 13 builtin providers', () => {
    expect([...BUILTIN_PROVIDERS]).toEqual([
      'openai',
      'azure-openai',
      'anthropic',
      'gemini',
      'vertex',
      'bedrock',
      'deepseek',
      'mistral',
      'cohere',
      'ollama',
      'openrouter',
      'siliconflow',
      'openai-compatible',
    ]);
    for (const id of BUILTIN_PROVIDERS) {
      expect(resolveAdaptor(id), id).not.toBeNull();
      expect(isKnownProvider(id)).toBe(true);
    }
  });

  it('resolves legacy/blank provider ids to the custom adaptor', () => {
    expect(resolveAdaptor('')).toBe(customAdaptor);
    expect(resolveAdaptor('openai-chat')).toBe(customAdaptor);
    expect(resolveAdaptor('openai-compatible')).toBe(customAdaptor);
  });

  it('does not fall back for an unknown provider (explicit failure)', () => {
    expect(resolveAdaptor('not-a-provider')).toBeNull();
    expect(isKnownProvider('not-a-provider')).toBe(false);
  });

  it('registers exactly the 13 builtin adaptors', () => {
    expect(listAdaptors().length).toBe(BUILTIN_PROVIDERS.length);
  });
});

describe('auth headers', () => {
  const cases: Array<[string, keyof Record<string, string>, string]> = [
    ['openai', 'authorization', 'Bearer sk-test-abcdefghijklmnop'],
    ['deepseek', 'authorization', 'Bearer sk-test-abcdefghijklmnop'],
    ['azure-openai', 'api-key', 'sk-test-abcdefghijklmnop'],
    ['gemini', 'x-goog-api-key', 'sk-test-abcdefghijklmnop'],
  ];

  it.each(cases)('%s uses the right auth header', (provider, header, value) => {
    const adaptor = resolveAdaptor(provider);
    expect(adaptor).not.toBeNull();
    const headers = adaptor!.authHeaders(account());
    expect(headers[header as string]).toBe(value);
  });

  it('anthropic sends x-api-key and anthropic-version', () => {
    const headers = resolveAdaptor('anthropic')!.authHeaders(account());
    expect(headers['x-api-key']).toBe('sk-test-abcdefghijklmnop');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('vertex throws when accessToken is missing (no anonymous request)', () => {
    expect(() => resolveAdaptor('vertex')!.authHeaders(account())).toThrow(GatewayError);
    const withToken = resolveAdaptor('vertex')!.authHeaders(
      account({ options: { accessToken: 'ya29.token' } }),
    );
    expect(withToken['authorization']).toBe('Bearer ya29.token');
  });

  it('openrouter adds x-title and optional http-referer', () => {
    const headers = resolveAdaptor('openrouter')!.authHeaders(account());
    expect(headers['x-title']).toBe('StackPanel');
    const withReferer = resolveAdaptor('openrouter')!.authHeaders(
      account({ options: { httpReferer: 'https://app.example.com' } }),
    );
    expect(withReferer['http-referer']).toBe('https://app.example.com');
  });

  it('ollama omits auth when no key is configured', () => {
    expect(resolveAdaptor('ollama')!.authHeaders(account({ apiKey: '' }))).toEqual({});
  });
});

describe('buildRequest', () => {
  it('posts to baseUrl + subPath with bearer auth by default', () => {
    const call = resolveAdaptor('openai')!.buildRequest(request());
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer sk-test-abcdefghijklmnop');
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('does not duplicate the version segment when baseUrl already ends with /v1', () => {
    const call = resolveAdaptor('openai')!.buildRequest(
      request({ account: account({ baseUrl: 'https://api.example.com/v1' }) }),
    );
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('azure rewrites to the deployments path and sets api-version', () => {
    const call = resolveAdaptor('azure-openai')!.buildRequest(
      request({
        account: account({ options: { deployment: 'my-deploy', apiVersion: '2024-10-21' } }),
      }),
    );
    expect(call.url).toContain('/openai/deployments/my-deploy/chat/completions');
    expect(call.url).toContain('api-version=2024-10-21');
    expect(call.headers['api-key']).toBe('sk-test-abcdefghijklmnop');
  });

  it('vertex rewrites to projects/locations and adds alt=sse when streaming', () => {
    const call = resolveAdaptor('vertex')!.buildRequest(
      request({
        account: account({
          options: { project: 'my-project', region: 'us-central1', accessToken: 'ya29' },
        }),
        subPath: 'v1beta/models/gemini-2.5-pro:generateContent',
        stream: true,
      }),
    );
    expect(call.url).toContain(
      '/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(call.url).toContain('alt=sse');
  });

  it('vertex throws when project is missing', () => {
    expect(() =>
      resolveAdaptor('vertex')!.buildRequest(
        request({
          account: account({ options: { accessToken: 'ya29' } }),
          subPath: 'v1beta/models/x:generateContent',
        }),
      ),
    ).toThrow(GatewayError);
  });

  it('bedrock wraps the body in an anthropic_version envelope', () => {
    const call = resolveAdaptor('bedrock')!.buildRequest(
      request({
        account: account({ baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' }),
        body: { messages: [] },
        ir: { model: 'anthropic.claude-3', messages: [], stream: false, raw: {} },
      }),
    );
    expect(call.url).toContain('/model/anthropic.claude-3/invoke');
    const parsed = JSON.parse(call.body as string) as Record<string, unknown>;
    expect(parsed['anthropic_version']).toBe('bedrock-2023-05-31');
  });
});

describe('capabilities', () => {
  it('openai declares the full non-chat operation set', () => {
    const ops = resolveAdaptor('openai')!.capabilities.operations;
    for (const op of [
      'embeddings',
      'images.generations',
      'images.edits',
      'audio.speech',
      'audio.transcriptions',
      'audio.translations',
      'moderations',
      'files.list',
      'files.create',
      'files.delete',
      'batches.create',
      'batches.get',
      'fine_tuning.create',
      'fine_tuning.get',
    ]) {
      expect(ops, op).toContain(op);
    }
  });

  it('anthropic and bedrock only do chat (no non-chat operations)', () => {
    expect(resolveAdaptor('anthropic')!.capabilities.operations).toEqual([]);
    expect(resolveAdaptor('bedrock')!.capabilities.operations).toEqual([]);
  });

  it('bedrock is the only customSigning provider', () => {
    const signing = listAdaptors()
      .filter((a) => a.capabilities.customSigning)
      .map((a) => a.id);
    expect(signing).toEqual(['bedrock']);
  });

  it('cohere supports rerank and mistral supports moderations', () => {
    expect(resolveAdaptor('cohere')!.capabilities.operations).toContain('rerank');
    expect(resolveAdaptor('mistral')!.capabilities.operations).toContain('moderations');
  });

  it('opts Mistral out of stream_options injection (strict compat layer)', () => {
    expect(resolveAdaptor('mistral')!.capabilities.streamUsage).toBe(false);
    expect(resolveAdaptor('openai')!.capabilities.streamUsage).toBe(true);
  });
});

describe('usage extraction', () => {
  it('extracts OpenAI usage with reasoning details', () => {
    const usage = resolveAdaptor('openai')!.extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
        completion_tokens_details: { reasoning_tokens: 12 },
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      reasoningTokens: 12,
      cacheReadTokens: 30,
    });
  });

  it('extracts Anthropic usage with cache read/write', () => {
    const usage = resolveAdaptor('anthropic')!.extractUsage({
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
    });
  });

  it('extracts Gemini usageMetadata', () => {
    const usage = resolveAdaptor('gemini')!.extractUsage({
      usageMetadata: {
        promptTokenCount: 70,
        candidatesTokenCount: 30,
        totalTokenCount: 100,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 10,
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 70,
      outputTokens: 30,
      totalTokens: 100,
      reasoningTokens: 5,
      cacheReadTokens: 10,
    });
  });

  it('extracts DeepSeek prompt_cache_hit_tokens', () => {
    const usage = resolveAdaptor('deepseek')!.extractUsage({
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        prompt_cache_hit_tokens: 20,
      },
    });
    expect(usage?.cacheReadTokens).toBe(20);
  });

  it('returns null when the upstream gave no usage', () => {
    expect(resolveAdaptor('openai')!.extractUsage({ choices: [] })).toBeNull();
  });
});

function headers(map: Record<string, string>): Headers {
  return new Headers(map);
}

describe('error classification', () => {
  it('maps upstream 429 to upstream_rate_limited and keeps Retry-After', () => {
    const error = resolveAdaptor('deepseek')!.classifyError({
      status: 429,
      bodyText: JSON.stringify({ error: { message: 'slow down' } }),
      headers: headers({ 'retry-after': '7' }),
    });
    expect(error.status).toBe(429);
    expect(error.code).toBe('upstream_rate_limited');
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.retryable).toBe(true);
  });

  it('maps upstream 401/403 to a 502 credential error (not user auth)', () => {
    const error = resolveAdaptor('openai')!.classifyError({
      status: 401,
      bodyText: '',
      headers: headers({}),
    });
    expect(error.status).toBe(502);
    expect(error.code).toBe('upstream_credential_missing');
    expect(error.retryable).toBe(false);
  });

  it('maps upstream 404 to upstream_model_unsupported', () => {
    const error = resolveAdaptor('openai')!.classifyError({
      status: 404,
      bodyText: '',
      headers: headers({}),
    });
    expect(error.code).toBe('upstream_model_unsupported');
  });

  it('maps upstream 5xx to upstream_unavailable and retryable', () => {
    const error = resolveAdaptor('openai')!.classifyError({
      status: 503,
      bodyText: '',
      headers: headers({}),
    });
    expect(error.status).toBe(502);
    expect(error.code).toBe('upstream_unavailable');
    expect(error.retryable).toBe(true);
  });

  it('detects OpenAI context_length_exceeded as non-retryable 400', () => {
    const error = resolveAdaptor('openai')!.classifyError({
      status: 400,
      bodyText: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }),
      headers: headers({}),
    });
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.retryable).toBe(false);
  });

  it('detects DeepSeek balance exhaustion as insufficient_quota', () => {
    const error = resolveAdaptor('deepseek')!.classifyError({
      status: 402,
      bodyText: JSON.stringify({ error: { code: 'Insufficient Balance' } }),
      headers: headers({}),
    });
    expect(error.status).toBe(429);
    expect(error.code).toBe('insufficient_quota');
    expect(error.retryable).toBe(false);
  });

  it('treats Anthropic 529 as overloaded and retryable with cooldown', () => {
    const error = resolveAdaptor('anthropic')!.classifyError({
      status: 529,
      bodyText: '',
      headers: headers({ 'retry-after': '3' }),
    });
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(3);
  });

  it('treats Gemini invalid API key as a 502 credential error', () => {
    const error = resolveAdaptor('gemini')!.classifyError({
      status: 400,
      bodyText: JSON.stringify({
        error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' },
      }),
      headers: headers({}),
    });
    expect(error.status).toBe(502);
    expect(error.code).toBe('upstream_credential_missing');
  });
});

describe('retry decisions', () => {
  it('isRetryable follows the classified error', () => {
    const adaptor = resolveAdaptor('openai')!;
    expect(adaptor.isRetryable(new GatewayError(429, 'upstream_rate_limited', 'x'), 429)).toBe(
      true,
    );
    expect(
      adaptor.isRetryable(new GatewayError(400, 'invalid_request', 'x', { retryable: false }), 400),
    ).toBe(false);
  });
});

describe('shared helpers', () => {
  it('parseUpstreamError reads OpenAI/Anthropic/Gemini shapes', () => {
    expect(parseUpstreamError('{"error":{"message":"m","type":"t","code":"c"}}')).toMatchObject({
      message: 'm',
      type: 't',
      code: 'c',
    });
    expect(parseUpstreamError('{"type":"error","error":{"type":"overloaded_error"}}').type).toBe(
      'overloaded_error',
    );
    expect(
      parseUpstreamError('{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}'),
    ).toMatchObject({ message: 'quota', code: '429', type: 'RESOURCE_EXHAUSTED' });
  });

  it('parseRetryAfter handles seconds and HTTP dates', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '5' }))).toBe(5);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(headers({ 'retry-after': future }));
    expect(parsed).toBeGreaterThanOrEqual(0);
    expect(parsed).toBeLessThanOrEqual(11);
  });

  it('stripUpstreamNoise drops credential-bearing fields', () => {
    expect(stripUpstreamNoise({ api_key: 'x', authorization: 'y', model: 'm' })).toEqual({
      model: 'm',
    });
  });
});
