import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider, PluginContext } from '@stackpanel/sdk';
import { wowidPlugin } from './index.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function activatedProvider(): AuthProvider | undefined {
  let provider: AuthProvider | undefined;
  wowidPlugin.onActivate?.({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    registerExtension: vi.fn((_point: string, implementation: AuthProvider) => {
      provider = implementation;
      return () => undefined;
    }),
  } as PluginContext);
  return provider;
}

describe('Wow ID OIDC provider', () => {
  it('builds a PKCE authorization-code request from explicit live configuration', () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      WOWID_MOCK: 'false',
      WOWID_ISSUER: 'https://account.example/identity',
      WOWID_CLIENT_ID: 'stackpanel-live',
      WOWID_REDIRECT_URI: 'https://panel.example/auth/oauth/wowid/callback',
    };
    const provider = activatedProvider();
    expect(provider).toBeDefined();
    const href = provider?.authorizeUrl?.('state-value-0123456789', {
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
      nonce: 'nonce-value-0123456789',
    });
    expect(href).toBeTypeOf('string');
    const url = new URL(href!);
    expect(url.href).toContain('https://account.example/identity/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('stackpanel-live');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://panel.example/auth/oauth/wowid/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce-value-0123456789');
  });

  it('does not register an unconfigured live provider', () => {
    process.env = { ...ORIGINAL_ENV, WOWID_MOCK: 'false' };
    delete process.env.WOWID_ISSUER;
    delete process.env.WOWID_CLIENT_ID;
    expect(activatedProvider()).toBeUndefined();
  });
});
