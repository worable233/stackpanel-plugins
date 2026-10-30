import { isPublicHttpUrl } from '@stackpanel/net-guard';

/**
 * Vendor presets.
 *
 * A preset is **pure data**: the endpoint, the field names its `siteverify`
 * expects, and the widget protocol the host renders. Adding a vendor means
 * adding one object here — no kernel change, no web change, no branch in
 * `verify.ts`.
 *
 * Everything is expressed in terms every siteverify-style API understands (POST
 * a token plus a secret, read a boolean back) because that is the shape the whole
 * family shares. Vendors that deviate do so through `fieldMap`, which is why the
 * `generic` preset can stand in for a private deployment.
 */

/** Widget protocol published to the browser via `clientConfig()`. */
export interface PresetWidget {
  script?: string;
  globalFn?: string;
  tag?: string;
  attributes?: Record<string, string>;
  tokenAttribute?: string;
  event?: string;
  resetEvent?: string;
  renderOptions?: Record<string, unknown>;
  sources?: { script?: string[]; frame?: string[]; connect?: string[] };
}

export interface Preset {
  id: string;
  /** Operator-facing label; never translated — it is a product name. */
  label: string;
  /** Default `siteverify` endpoint. Overridable per deployment. */
  verifyUrl: string;
  /** Request field carrying the challenge response. */
  tokenField: string;
  /** Request field carrying the secret. */
  secretField: string;
  /** Response field that reports the outcome. */
  successField: string;
  /**
   * Response fields whose values are joined into the failure `reason`. These are
   * vendor error codes and are never shown to end users, so they stay untranslated
   * (they land in the kernel's `PluginError.detail` and the server log).
   */
  errorFields: string[];
  /** Extra request fields a vendor accepts (e.g. `remoteip`). */
  optionalFields: string[];
  /** `action` is forwarded only when the vendor understands it. */
  supportsAction: boolean;
  widget: PresetWidget;
  /** Shown in the admin page as the operator-facing note. */
  hint?: string;
}

/**
 * Cloudflare Turnstile — the reference implementation of a managed challenge.
 * `https://developers.cloudflare.com/turnstile/get-started/server-side-validation/`
 */
const TURNSTILE: Preset = {
  id: 'turnstile',
  label: 'Cloudflare Turnstile',
  verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes'],
  optionalFields: ['remoteip'],
  supportsAction: true,
  widget: {
    script: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
    globalFn: 'turnstile',
    sources: {
      script: ['https://challenges.cloudflare.com'],
      frame: ['https://challenges.cloudflare.com'],
      connect: ['https://challenges.cloudflare.com'],
    },
  },
  hint: '在 Cloudflare 控制台创建站点后填入 Site Key 与 Secret Key，测试可用官方 1x00000000000000000000AA。',
};

/**
 * hCaptcha — same request shape, different field names and endpoint.
 * `https://docs.hcaptcha.com/#verify-the-user-response-server-side`
 */
const HCAPTCHA: Preset = {
  id: 'hcaptcha',
  label: 'hCaptcha',
  verifyUrl: 'https://api.hcaptcha.com/siteverify',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes'],
  optionalFields: ['remoteip', 'sitekey'],
  supportsAction: false,
  widget: {
    script: 'https://js.hcaptcha.com/1/api.js',
    globalFn: 'hcaptcha',
    sources: {
      script: ['https://js.hcaptcha.com'],
      frame: ['https://newassets.hcaptcha.com'],
      connect: ['https://api.hcaptcha.com'],
    },
  },
};

/**
 * Google reCAPTCHA v2/v3 — `g-recaptcha-response` is the canonical field name, so
 * the token field differs from the widget factory's callback shape.
 * `https://developers.google.com/recaptcha/docs/verify`
 */
const RECAPTCHA: Preset = {
  id: 'recaptcha',
  label: 'Google reCAPTCHA',
  verifyUrl: 'https://www.google.com/recaptcha/api/siteverify',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes'],
  optionalFields: ['remoteip'],
  supportsAction: false,
  widget: {
    script: 'https://www.google.com/recaptcha/api.js',
    globalFn: 'grecaptcha',
    sources: {
      script: ['https://www.google.com', 'https://www.gstatic.com'],
      frame: ['https://www.google.com', 'https://recaptcha.net'],
      connect: ['https://www.google.com'],
    },
  },
  hint: 'reCAPTCHA 的 render 走 grecaptcha.render，同样的 script 协议可直接复用。',
};

/**
 * Cap — a self-hostable proof-of-work widget. It exposes a custom element rather
 * than a factory, which is exactly why the host supports the second protocol:
 * without it, every non-factory widget would require a new host component.
 * `https://capjs.js.org/guide/`
 */
const CAP: Preset = {
  id: 'cap',
  label: 'Cap（自托管 PoW）',
  verifyUrl: 'https://cap.bug.im/siteverify',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes'],
  optionalFields: [],
  supportsAction: false,
  widget: {
    script: 'https://cdn.jsdelivr.net/npm/@cap.js/widget',
    tag: 'cap-widget',
    attributes: { 'data-cap-api-endpoint': 'https://cap.bug.im/' },
    tokenAttribute: 'data-cap-token',
    event: 'solve',
    resetEvent: 'reset',
    sources: {
      script: ['https://cdn.jsdelivr.net'],
      connect: ['https://cap.bug.im'],
    },
  },
  hint: 'Cap 自托管：把校验地址与 data-cap-api-endpoint 指向自己的实例。',
};

/**
 * Generic siteverify — for a private deployment or a vendor not listed above.
 * The endpoint is operator-supplied and validated as a public https URL before
 * every use (SSRF), so this preset cannot be turned into a request relay.
 */
const GENERIC: Preset = {
  id: 'generic',
  label: '通用 siteverify',
  verifyUrl: '',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes', 'error', 'message'],
  optionalFields: ['remoteip'],
  supportsAction: true,
  widget: {
    script: '',
    globalFn: '',
  },
  hint: '任何接受「POST token + secret，返回 success 布尔」的校验接口，含私有化部署。',
};

export const PRESETS: readonly Preset[] = [TURNSTILE, HCAPTCHA, RECAPTCHA, CAP, GENERIC];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * Validate an operator-supplied verify endpoint.
 *
 * Only absolute, public https URLs are accepted: the request carries the
 * deployment's secret, and the URL is operator-controlled, so accepting a
 * loopback or metadata address would turn this plugin into an SSRF pivot that
 * also leaks the secret. `isPublicHttpUrl` rejects IP literals and hostnames in
 * private/reserved ranges; DNS rebinding is closed at request time in
 * `verify.ts`.
 */
export function isValidVerifyUrl(value: string): boolean {
  return isPublicHttpUrl(value);
}
