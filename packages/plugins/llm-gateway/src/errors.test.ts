/**
 * 错误模型与脱敏的契约测试（目标四 13/14）。
 *
 * 这些用例不依赖 DB / Redis，直接跑纯函数，保证：
 * - 无论输入什么异常，错误体形状恒定（OpenAI 兼容）；
 * - API key 永远不会从 `redactSecrets` 漏出去。
 */
import { describe, expect, it } from 'vitest';
import {
  GatewayError,
  defaultTypeFor,
  errorBody,
  redactSecrets,
  redactValue,
  toGatewayError,
} from './errors.js';

describe('GatewayError', () => {
  it('derives type from status and defaults retryable for 429/408/5xx', () => {
    expect(defaultTypeFor(400)).toBe('invalid_request_error');
    expect(defaultTypeFor(401)).toBe('authentication_error');
    expect(defaultTypeFor(403)).toBe('permission_error');
    expect(defaultTypeFor(404)).toBe('not_found_error');
    expect(defaultTypeFor(405)).toBe('method_not_allowed');
    expect(defaultTypeFor(408)).toBe('timeout_error');
    expect(defaultTypeFor(429)).toBe('rate_limit_error');
    expect(defaultTypeFor(503)).toBe('overloaded_error');
    expect(defaultTypeFor(500)).toBe('api_error');

    expect(new GatewayError(429, 'rate_limited', 'x').retryable).toBe(true);
    expect(new GatewayError(408, 'upstream_timeout', 'x').retryable).toBe(true);
    expect(new GatewayError(502, 'upstream_error', 'x').retryable).toBe(true);
    expect(new GatewayError(400, 'invalid_request', 'x').retryable).toBe(false);
  });

  it('honours explicit options over defaults', () => {
    const error = new GatewayError(429, 'insufficient_quota', 'quota', {
      retryable: false,
      retryAfterSeconds: 12,
      param: 'model',
      type: 'insufficient_quota',
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.param).toBe('model');
    expect(error.type).toBe('insufficient_quota');
  });

  it('normalizes unknown errors into a 500 internal_error', () => {
    const mapped = toGatewayError(new Error('boom'));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('internal_error');
    expect(mapped.message).toContain('boom');
  });

  it('passes through an existing GatewayError unchanged', () => {
    const original = new GatewayError(404, 'model_not_found', 'nope');
    expect(toGatewayError(original)).toBe(original);
  });
});

describe('errorBody', () => {
  it('always emits the stable OpenAI shape', () => {
    const body = errorBody(
      { message: 'bad', type: 'invalid_request_error', code: 'invalid_request' },
      400,
    );
    expect(body).toEqual({
      error: {
        message: 'bad',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: null,
        status: 400,
      },
    });
  });
});

describe('redactSecrets', () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwxyz',
    'sk-ant-api03-abcdefghijklmnop',
    'sk-or-v1-1234567890abcdef',
    'AIzaSyA1234567890abcdefghijklmnopqrst',
    'AKIAIOSFODNN7EXAMPLE',
    'ASIAIOSFODNN7EXAMPLE',
    'sp_abcdefghijklmnopqrstuvwx',
  ];

  it.each(secrets)('redacts %s', (secret) => {
    const output = redactSecrets(`upstream rejected key ${secret} please fix`);
    expect(output).not.toContain(secret);
    expect(output).toContain('***');
  });

  it('redacts authorization header values', () => {
    expect(redactSecrets('Authorization: Bearer abcdefgh1234')).not.toContain('abcdefgh1234');
    expect(redactSecrets('x-api-key: abcdefgh1234')).not.toContain('abcdefgh1234');
  });

  it('redacts api keys embedded in a query string', () => {
    const output = redactSecrets('GET /v1beta/models/x?key=AIzaSecretValue1234567890');
    expect(output).not.toContain('AIzaSecretValue1234567890');
  });

  it('redacts AWS signature material', () => {
    expect(redactSecrets('SecretAccessKey=abcdef0123456789')).not.toContain('abcdef0123456789');
    expect(redactSecrets('X-Amz-Signature=deadbeefdeadbeef')).not.toContain('deadbeefdeadbeef');
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('model gpt-4o not found')).toBe('model gpt-4o not found');
  });
});

describe('redactValue', () => {
  it('redacts nested secret-bearing fields and string values', () => {
    const out = redactValue({
      authorization: 'Bearer abcdefgh1234',
      nested: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', note: 'ok' },
      list: ['sk-abcdefghijklmnopqrstuvwxyz'],
    }) as Record<string, unknown>;
    expect(out['authorization']).toBe('***');
    expect((out['nested'] as Record<string, unknown>)['apiKey']).toBe('***');
    expect(JSON.stringify(out)).not.toContain('abcdefgh1234');
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});
