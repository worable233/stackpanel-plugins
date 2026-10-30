import { describe, expect, it, vi } from 'vitest';
import { PRESETS, isValidVerifyUrl, presetById } from './presets.js';
import { verifyChallenge } from './verify.js';
import { buildClientConfig, resolveConfig } from './index.js';

/**
 * Captcha provider plugin.
 *
 * The cases that matter are the failure ones: this code sits in front of every
 * sign-in, so an outage, a bad endpoint or a malformed response must produce
 * "not verified" — never a pass, and never an exception that would surface as a
 * 500 instead of a deterministic rejection.
 */

const neverUnsafe = async (): Promise<boolean> => false;

function response(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const preset = presetById('turnstile')!;

function settings(overrides: Partial<Parameters<typeof verifyChallenge>[0]> = {}) {
  return {
    preset,
    verifyUrl: 'https://challenges.example.test/siteverify',
    secret: 'sk_secret',
    ...overrides,
  };
}

describe('presets', () => {
  it('covers the factory family and the DOM-scanning family', () => {
    const kinds = PRESETS.map((item) =>
      item.widget.containerClass ? 'container' : item.widget.tag ? 'element' : 'script',
    );
    expect(kinds).toContain('script');
    expect(kinds).toContain('container');
  });

  it('rejects a non-public verify endpoint', () => {
    // The endpoint is operator-supplied and carries the secret, so a loopback or
    // metadata address would be an SSRF pivot plus a secret leak.
    expect(isValidVerifyUrl('http://127.0.0.1/siteverify')).toBe(false);
    expect(isValidVerifyUrl('https://169.254.169.254/siteverify')).toBe(false);
    expect(isValidVerifyUrl('http://public.example.test/siteverify')).toBe(false);
    expect(isValidVerifyUrl('https://challenges.cloudflare.com/turnstile/v0/siteverify')).toBe(
      true,
    );
  });
});

describe('verifyChallenge', () => {
  it('posts the token and secret as form fields and honours success', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }));
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome.success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://challenges.example.test/siteverify');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).redirect).toBe('error');
    const body = String((init as RequestInit).body);
    expect(body).toContain('response=tok');
    expect(body).toContain('secret=sk_secret');
  });

  it('never follows a redirect away from a validated endpoint', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }));
    await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('error');
  });

  it('treats a rejected challenge as a failure with the vendor error code', async () => {
    const fetchMock = vi.fn(async () =>
      response({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome).toMatchObject({ success: false, reason: 'invalid-input-response' });
  });

  it('fails closed on a non-2xx status', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }, { status: 502 }));
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome).toMatchObject({ success: false, reason: 'http_502' });
  });

  it('fails closed on a network error instead of throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome).toMatchObject({ success: false, reason: 'network_error' });
  });

  it('fails closed on an unparsable body', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }));
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome).toMatchObject({ success: false, reason: 'invalid_response' });
  });

  it('refuses to call a host that resolves to a private address', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }));
    const outcome = await verifyChallenge(settings(), { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: async () => true,
    });
    // DNS-rebinding guard: the literal looked public, the resolution did not.
    expect(outcome).toMatchObject({ success: false, reason: 'unsafe_verify_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the action only to a vendor that understands it', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }));
    await verifyChallenge(
      settings(),
      { token: 'tok', action: 'login' },
      { fetch: fetchMock as unknown as typeof fetch, resolveUnsafe: neverUnsafe },
    );
    expect(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).toContain('action=login');

    const hcaptchaFetch = vi.fn(async () => response({ success: true }));
    await verifyChallenge(
      settings({ preset: presetById('hcaptcha')! }),
      { token: 'tok', action: 'login' },
      { fetch: hcaptchaFetch as unknown as typeof fetch, resolveUnsafe: neverUnsafe },
    );
    expect(String((hcaptchaFetch.mock.calls[0]![1] as RequestInit).body)).not.toContain('action=');
  });
});

describe('resolveConfig', () => {
  const base = { preset: 'turnstile', siteKey: 'site-key', secret: 'sk_secret' };

  it('rejects an unknown provider preset', () => {
    expect(() => resolveConfig({ ...base, preset: 'nope' })).toThrow();
  });

  it('rejects an unknown guarded action', () => {
    // The action vocabulary is closed by the kernel; a typo must fail loudly at
    // save time instead of silently guarding nothing.
    expect(() => resolveConfig({ ...base, actions: { sign_in: 'required' } })).toThrow();
  });

  it('rejects a private verify URL', () => {
    expect(() => resolveConfig({ ...base, verifyUrl: 'http://10.0.0.1/siteverify' })).toThrow();
  });

  it('accepts per-action policy', () => {
    const config = resolveConfig({
      ...base,
      actions: { login: 'required', change_password: 'optional' },
    });
    expect(config.actions).toEqual({ login: 'required', change_password: 'optional' });
  });
});

describe('buildClientConfig', () => {
  const base = { preset: 'turnstile', siteKey: 'site-key', secret: 'sk_secret', actions: {} };

  it('publishes the script protocol for a factory widget', () => {
    const config = buildClientConfig(resolveConfig(base));
    expect(config).toMatchObject({ kind: 'script', globalFn: 'turnstile', siteKey: 'site-key' });
    // Never the secret.
    expect(JSON.stringify(config)).not.toContain('sk_secret');
  });

  it('publishes the container protocol for a DOM-scanning loader', () => {
    const config = buildClientConfig(
      resolveConfig({
        ...base,
        preset: 'cap',
      }),
    );
    expect(config).toMatchObject({
      kind: 'container',
      script: 'https://cap.bug.im/v1.js',
      containerClass: 'cap-captcha',
      siteKey: 'site-key',
      hiddenField: 'cap-response',
      // Without the re-scan hook a React-mounted container is never bound.
      remount: 'capCaptcha.mount',
    });
  });

  it('declares the stylesheet and blob-worker origins a PoW widget needs', () => {
    const config = buildClientConfig(resolveConfig({ ...base, preset: 'cap' })) as {
      sources?: { style?: string[]; worker?: string[] };
    };
    // ALTCHA injects a theme CSS and solves in a blob worker; omitting either from
    // the CSP leaves the widget invisible or unable to compute.
    expect(config.sources?.style).toContain('https://cap.bug.im');
    expect(config.sources?.worker).toContain('https://cap.bug.im');
  });

  it('declares the CSP origins its widget needs', () => {
    const config = buildClientConfig(resolveConfig(base)) as {
      sources?: { script?: string[]; frame?: string[] };
    };
    expect(config.sources?.frame).toContain('https://challenges.cloudflare.com');
  });
});

describe('verifyChallenge — JSON siteverify', () => {
  const cap = presetById('cap')!;
  const capSettings = {
    preset: cap,
    verifyUrl: 'https://cap.bug.im/v1/siteverify',
    secret: 'csk_secret',
  };

  it('posts JSON, not a form, when the preset says so', async () => {
    const fetchMock = vi.fn(async () => response({ success: true }));
    const outcome = await verifyChallenge(capSettings, { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome.success).toBe(true);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    // A JSON-only endpoint answers `bad-request` to a form post, which reads like a
    // credential error and sends the operator hunting for the wrong thing.
    expect(JSON.parse(String(init.body))).toEqual({ secret: 'csk_secret', response: 'tok' });
  });

  it('rejects a degraded pass', async () => {
    const fetchMock = vi.fn(async () => response({ success: true, degraded: true }));
    const outcome = await verifyChallenge(capSettings, { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    // The vendor could not fully verify. Treating this as a pass turns a transient
    // service degradation into a free bypass.
    expect(outcome).toMatchObject({ success: false, reason: 'denied_degraded' });
  });

  it('accepts an explicit degraded:false alongside success', async () => {
    const fetchMock = vi.fn(async () => response({ success: true, degraded: false }));
    const outcome = await verifyChallenge(capSettings, { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome.success).toBe(true);
  });

  it('surfaces the vendor error code on rejection', async () => {
    const fetchMock = vi.fn(async () =>
      response({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    );
    const outcome = await verifyChallenge(capSettings, { token: 'tok' }, {
      fetch: fetchMock as unknown as typeof fetch,
      resolveUnsafe: neverUnsafe,
    });
    expect(outcome).toMatchObject({ success: false, reason: 'timeout-or-duplicate' });
  });
});
