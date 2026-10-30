import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
import { AltchaService, resolveConfig } from './index.js';
import { createChallenge } from './challenge.js';

function fakeCtx(options: { secretsAvailable?: boolean } = {}) {
  const secrets = new Map<string, string>();
  const state = new Map<string, { value: string; expiresAt: number }>();
  const logs: string[] = [];
  const ctx = {
    secrets: {
      isAvailable: () => options.secretsAvailable ?? true,
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
    state: {
      set: async (key: string, value: string, ttlMs?: number) => {
        state.set(key, { value, expiresAt: Date.now() + (ttlMs ?? 0) });
      },
      consume: async (key: string) => {
        const entry = state.get(key);
        if (!entry) return null;
        state.delete(key);
        return entry.value;
      },
    },
    logger: {
      warn: (message: string) => logs.push(`warn ${message}`),
      info: (message: string) => logs.push(`info ${message}`),
      error: (message: string) => logs.push(`error ${message}`),
    },
  };
  return { ctx: ctx as unknown as PluginContext, secrets, state, logs };
}

async function ready(options?: { secretsAvailable?: boolean }) {
  const harness = fakeCtx(options);
  const service = new AltchaService(harness.ctx);
  await service.load();
  return { service, ...harness };
}

function mint(solution: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(solution)).toString('base64');
}

describe('AltchaService', () => {
  it('generates a signing key on first activation, so no configuration is needed', async () => {
    const { service, secrets, logs } = await ready();
    expect(service.isConfigured()).toBe(true);
    expect(secrets.get('altcha-hmac-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.some((line) => line.includes('generated a local HMAC key'))).toBe(true);
  });

  it('reuses the stored key across restarts', async () => {
    const { ctx, secrets } = fakeCtx();
    const first = new AltchaService(ctx);
    await first.load();
    const fingerprint = (await first.status()).keyFingerprint;
    const second = new AltchaService(ctx);
    await second.load();
    expect((await second.status()).keyFingerprint).toBe(fingerprint);
    expect(secrets.get('altcha-hmac-key')).toHaveLength(64);
  });

  it('stays inert (never "configured") when the platform cannot store secrets', async () => {
    const { service, logs } = await ready({ secretsAvailable: false });
    expect(service.isConfigured()).toBe(false);
    expect(service.policyFor('login')).toBeNull();
    expect(service.clientConfigFor('login')).toBeNull();
    expect(await service.verify({ token: 'x' })).toEqual({
      success: false,
      reason: 'not_configured',
    });
    expect(logs.some((line) => line.includes('SETTINGS_ENCRYPTION_KEY'))).toBe(true);
  });

  it('declares a policy per guarded action and stays silent about others', async () => {
    const { service } = await ready();
    expect(service.policyFor('login')).toEqual({ mode: 'required' });
    expect(service.policyFor('password_reset')).toEqual({ mode: 'required' });
    expect(service.policyFor('something_else')).toBeNull();
  });

  it('exposes an element widget served from the same origin, declaring only a blob worker', async () => {
    const { service } = await ready();
    const config = service.clientConfigFor('login') as Record<string, unknown>;
    expect(config.kind).toBe('element');
    expect(config.tag).toBe('altcha-widget');
    expect(config.script).toBe('/api/plugins/altcha/widget.js');
    expect(config.hiddenField).toBe('altcha');
    // The solver runs in a blob-URL worker; the host CSP needs that declared or
    // the widget renders but can never finish.
    expect(config.sources).toEqual({ worker: ['blob:'] });
    expect((config.attributes as Record<string, string>).challenge).toBe(
      '/api/plugins/altcha/challenge?action=login',
    );
  });

  it('hides the widget for an action switched off', async () => {
    const { service } = await ready();
    await service.configure({ actions: { login: 'off' } });
    expect(service.policyFor('login')).toEqual({ mode: 'off' });
    expect(service.clientConfigFor('login')).toBeNull();
  });

  it('issues, verifies and then refuses the same solution (single use)', async () => {
    const { service } = await ready();
    const challenge = await service.issue('login');
    const number = Number(
      [...Array(challenge.maxnumber).keys()].find(
        (n) => createHash('sha256').update(challenge.salt + n).digest('hex') === challenge.challenge,
      ) ?? -1,
    );
    expect(number).toBeGreaterThanOrEqual(0);
    const token = mint({ ...challenge, number });

    expect(await service.verify({ token, action: 'login' })).toEqual({ success: true });
    expect(await service.verify({ token, action: 'login' })).toEqual({
      success: false,
      reason: 'replayed_or_unknown',
    });
  });

  it('refuses a correctly signed challenge it never issued', async () => {
    const { service, secrets } = await ready();
    const key = secrets.get('altcha-hmac-key')!;
    const challenge = createChallenge({ hmacKey: key, number: 4 });
    const token = mint({ ...challenge, number: 4 });
    expect(await service.verify({ token, action: 'login' })).toEqual({
      success: false,
      reason: 'replayed_or_unknown',
    });
  });

  it('refuses a token signed by another key', async () => {
    const { service } = await ready();
    const challenge = createChallenge({ hmacKey: 'c'.repeat(64), number: 4 });
    const token = mint({ ...challenge, number: 4 });
    expect(await service.verify({ token, action: 'login' })).toEqual({
      success: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a forged token instead of throwing', async () => {
    const { service } = await ready();
    expect(await service.verify({ token: 'forge' })).toEqual({
      success: false,
      reason: 'malformed',
    });
  });

  it('rejects an unknown action on the challenge endpoint', async () => {
    const { service } = await ready();
    await expect(service.issue('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('persists configuration and drops unknown action keys', async () => {
    const { service, secrets } = await ready();
    await service.configure({
      actions: { login: 'optional', made_up: 'required' },
      maxNumber: 2_000,
      expiresMinutes: 3,
      language: 'zh-cn',
      theme: 'dark',
      singleUse: false,
    });
    const stored = JSON.parse(secrets.get('altcha-config')!);
    expect(stored.actions.login).toBe('optional');
    expect(stored.actions.made_up).toBeUndefined();
    expect(stored.actions.register).toBe('required');

    const status = await service.status();
    expect(status.maxNumber).toBe(2_000);
    expect(status.expiresMinutes).toBe(3);
    expect(status.language).toBe('zh-cn');
    expect(status.theme).toBe('dark');
    expect(status.singleUse).toBe(false);
  });

  it('rejects invalid configuration', async () => {
    const { service } = await ready();
    await expect(service.configure({ maxNumber: 1 })).rejects.toMatchObject({
      code: 'altcha.invalid_config',
    });
  });

  it('self-tests by solving and verifying its own challenge', async () => {
    const { service } = await ready();
    const result = await service.selfTest();
    expect(result.ok).toBe(true);
    expect(result.firstAttempt).toEqual({ success: true });
    expect(result.secondAttempt).toEqual({ success: false, reason: 'replayed_or_unknown' });
  });

  it('survives a corrupt stored configuration by falling back to defaults', async () => {
    const harness = fakeCtx();
    const probe = new AltchaService(harness.ctx);
    await probe.load();
    harness.secrets.set('altcha-config', 'not json');
    const service = new AltchaService(harness.ctx);
    await service.load();
    expect(service.policyFor('login')).toEqual({ mode: 'required' });
    expect(harness.logs.some((line) => line.includes('unreadable'))).toBe(true);
  });
});

describe('resolveConfig', () => {
  it('defaults every guarded action to required', () => {
    const config = resolveConfig(null);
    expect(config.actions.login).toBe('required');
    expect(config.actions.api_token_create).toBe('required');
    expect(config.singleUse).toBe(true);
  });

  it('treats expiresMinutes 0 as "never expires"', () => {
    expect(resolveConfig({ expiresMinutes: 0 }).expiresMs).toBe(0);
    expect(resolveConfig({ expiresMinutes: 5 }).expiresMs).toBe(300_000);
  });

  it('drops an empty language so the widget follows the browser', () => {
    expect(resolveConfig({ language: '   ' }).language).toBeNull();
  });
});
