import { isPublicHttpUrl, resolvesToUnsafeAddress } from '@stackpanel/net-guard';
import type { Preset } from './presets.js';

/**
 * The outbound half of the capability: POST a challenge response to the
 * vendor's `siteverify` and read a boolean back.
 *
 * Three properties matter more than the protocol itself:
 *
 * 1. **Fail closed.** Any timeout, network error, non-2xx status, unparsable body
 *    or missing success field yields `{ success: false }`. The kernel's
 *    `enforce` treats that as "not verified", so a broken vendor can never become
 *    a free pass.
 * 2. **No SSRF.** The endpoint is operator-configurable (and the `generic` preset
 *    exists precisely for private deployments), so it is validated twice: as a
 *    public https URL up front, and again by resolving the hostname at request
 *    time. Rejecting only on the literal would leave a DNS-rebinding window
 *    between "validated" and "connected".
 * 3. **No secret in the response.** The reason string carries the vendor's error
 *    codes and nothing else; the secret never reaches a log line, a response
 *    body, or the browser.
 */

/**
 * Hard ceiling on one verification. The user is waiting on this.
 *
 * Measured against a live siteverify endpoint: 1.0s, 1.9s, 2.3s, 3.2s, 7.1s over
 * five consecutive calls. An 8s budget therefore rejected a perfectly valid
 * challenge under normal jitter — the first live login test failed exactly that
 * way (`reason=timeout`) and passed on immediate retry with the same token.
 * Correctness beats latency here: the request only happens after a human solved a
 * challenge, so a patient ceiling is better than a false "verification failed".
 */
export const VERIFY_TIMEOUT_MS = 15_000;

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

// DNS verdicts are cached to keep the SSRF pre-flight off the hot path: every
// login re-resolves the same hostname. Safe verdicts expire quickly so a rebind
// cannot ride a long-lived "safe" answer; unsafe verdicts stay cached, because
// caching a refusal only ever fails closed.
const DNS_SAFE_TTL_MS = 60_000;
const DNS_UNSAFE_TTL_MS = 5 * 60_000;
const dnsVerdicts = new Map<string, { unsafe: boolean; expiresAt: number }>();

async function cachedResolveUnsafe(hostname: string): Promise<boolean> {
  const cached = dnsVerdicts.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.unsafe;
  const unsafe = await resolvesToUnsafeAddress(hostname);
  dnsVerdicts.set(hostname, {
    unsafe,
    expiresAt: Date.now() + (unsafe ? DNS_UNSAFE_TTL_MS : DNS_SAFE_TTL_MS),
  });
  return unsafe;
}

export interface VerifyInput {
  token: string;
  action?: string | undefined;
  remoteIp?: string | undefined;
}

export interface VerifyOutcome {
  success: boolean;
  reason?: string;
  /** Raw vendor payload, for the admin "test" route only. Never logged wholesale. */
  raw?: unknown;
}

export interface VerifyDeps {
  fetch?: typeof fetch;
  /** Injected in tests so SSRF resolution never touches real DNS. */
  resolveUnsafe?: (hostname: string) => Promise<boolean>;
}

export interface VerifySettings {
  preset: Preset;
  verifyUrl: string;
  secret: string;
  /** Operator overrides for exotic field names (applied on top of the preset). */
  fieldMap?: Record<string, string> | undefined;
  /** Extra static request fields (e.g. `sitekey`). */
  extraFields?: Record<string, string> | undefined;
  /** How the action reaches the vendor, when it supports one. */
  actionField?: string | undefined;
}

function joinErrors(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.filter((item) => typeof item === 'string' || typeof item === 'number');
    return parts.length > 0 ? parts.join(',') : undefined;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Verify one challenge response.
 *
 * Never throws: the caller is a kernel `enforce` path where a thrown error would
 * surface as a 500 instead of the deterministic `auth.captcha_failed`.
 */
export async function verifyChallenge(
  settings: VerifySettings,
  input: VerifyInput,
  deps: VerifyDeps = {},
): Promise<VerifyOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const resolveUnsafe = deps.resolveUnsafe ?? cachedResolveUnsafe;

  if (!settings.verifyUrl) {
    return { success: false, reason: 'missing_verify_url' };
  }
  if (!isPublicHttpUrl(settings.verifyUrl)) {
    // Covers a saved http:// or private-address endpoint, and re-checks after an
    // operator edits the config by hand.
    return { success: false, reason: 'unsafe_verify_url' };
  }

  let hostname: string;
  try {
    hostname = new URL(settings.verifyUrl).hostname;
  } catch {
    return { success: false, reason: 'invalid_verify_url' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  // A race loser that rejects later must not surface as an unhandled rejection.
  void aborted.catch(() => {});

  try {
    // Bound the pre-flight DNS check by the same budget: an unresponsive resolver
    // must not outlive the request it was supposed to protect.
    if (await Promise.race([resolveUnsafe(hostname), aborted])) {
      return { success: false, reason: 'unsafe_verify_url' };
    }

    const fields: Record<string, string> = {};
    fields[settings.fieldMap?.['secret'] ?? settings.preset.secretField] = settings.secret;
    fields[settings.fieldMap?.['token'] ?? settings.preset.tokenField] = input.token;
    if (input.remoteIp && settings.preset.optionalFields.includes('remoteip')) {
      fields[settings.fieldMap?.['remoteIp'] ?? 'remoteip'] = input.remoteIp;
    }
    if (input.action && settings.preset.supportsAction) {
      fields[settings.actionField ?? 'action'] = input.action;
    }
    for (const [name, value] of Object.entries(settings.extraFields ?? {})) {
      fields[name] = value;
    }

    // Encoding is a property of the endpoint, not of the call: a JSON-only
    // siteverify answers `bad-request` to a form post, which reads like a
    // credential error and sends the operator hunting for the wrong thing.
    const asJson = settings.preset.requestFormat === 'json';

    const response = await doFetch(settings.verifyUrl, {
      method: 'POST',
      headers: {
        'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded',
        accept: 'application/json',
        // Vendors such as Turnstile use this to bind the response to the widget.
        ...(settings.extraFields?.['idempotency_key']
          ? { 'Idempotency-Key': settings.extraFields['idempotency_key'] }
          : {}),
      },
      body: asJson ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      signal: controller.signal,
      // Never follow a redirect: a 30x could walk a validated URL to an internal
      // host that was never checked.
      redirect: 'error',
    });

    if (!response.ok) {
      return { success: false, reason: `http_${response.status}` };
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) return { success: false, reason: 'invalid_response' };

    const veto = settings.preset.denyFields.find((name) => {
      const value = payload[name];
      return value !== undefined && value !== null && value !== false && value !== '';
    });
    if (veto) {
      // `{ success: true, degraded: true }` means the vendor could not fully
      // verify. Accepting it would turn a transient degradation into a pass.
      return { success: false, reason: `denied_${veto}`, raw: payload };
    }

    const successField = settings.fieldMap?.['success'] ?? settings.preset.successField;
    const passed = payload[successField] === true;
    if (passed) return { success: true, raw: payload };

    const reason = settings.preset.errorFields
      .map((field) => joinErrors(payload[field]))
      .find((value) => value !== undefined);
    return { success: false, reason: reason ?? 'rejected', raw: payload };
  } catch (error) {
    // AbortError (timeout), DNS failure, TLS failure — all "not verified".
    const name = (error as { name?: string }).name;
    return { success: false, reason: name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
