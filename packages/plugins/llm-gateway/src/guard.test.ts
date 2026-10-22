import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedUpstreamUrl } from './guard.js';

describe('isAllowedUpstreamUrl', () => {
  const original = process.env['NODE_ENV'];
  afterEach(() => {
    if (original === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = original;
  });

  it('allows loopback upstreams outside production', () => {
    process.env['NODE_ENV'] = 'test';
    expect(isAllowedUpstreamUrl('http://127.0.0.1:8080')).toBe(true);
  });

  it('rejects private and internal upstreams in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(isAllowedUpstreamUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isAllowedUpstreamUrl('http://169.254.169.254')).toBe(false);
    expect(isAllowedUpstreamUrl('http://metadata.google.internal')).toBe(false);
    expect(isAllowedUpstreamUrl('http://[::ffff:7f00:1]')).toBe(false);
    expect(isAllowedUpstreamUrl('http://10.0.0.1')).toBe(false);
  });

  it('allows public upstreams in production', () => {
    process.env['NODE_ENV'] = 'production';
    expect(isAllowedUpstreamUrl('https://api.openai.com/v1')).toBe(true);
    expect(isAllowedUpstreamUrl('http://1.1.1.1')).toBe(true);
  });
});
