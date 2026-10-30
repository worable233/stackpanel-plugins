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
  /** `container` protocol: the class the loader scans for. */
  containerClass?: string;
  /** `container` protocol: dotted path of the re-scan hook, e.g. `capCaptcha.mount`. */
  remount?: string;
  /** `container` protocol: hidden field the loader injects to carry the token. */
  hiddenField?: string;
  tag?: string;
  attributes?: Record<string, string>;
  tokenAttribute?: string;
  event?: string;
  resetEvent?: string;
  renderOptions?: Record<string, unknown>;
  sources?: {
    script?: string[];
    style?: string[];
    frame?: string[];
    connect?: string[];
    worker?: string[];
  };
}

export interface Preset {
  id: string;
  /** Operator-facing label; never translated — it is a product name. */
  label: string;
  /** Default `siteverify` endpoint. Overridable per deployment. */
  verifyUrl: string;
  /**
   * How the request body is encoded. The siteverify family is mostly
   * form-encoded, but not universally: a provider that only accepts JSON answers
   * `bad-request` to a form post, which reads like a credential problem.
   */
  requestFormat: 'form' | 'json';
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
  /**
   * Response fields whose *truthy* value vetoes an otherwise successful verdict.
   *
   * Some services answer `{ success: true, degraded: true }` when they could not
   * fully verify (e.g. a challenge minted while the backend was degraded). Those
   * must not be treated as a pass, and "check one extra flag" belongs in data —
   * not in a vendor branch in `verify.ts`.
   */
  denyFields: string[];
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
  denyFields: [],
  requestFormat: 'form',
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
  denyFields: [],
  requestFormat: 'form',
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
  denyFields: [],
  requestFormat: 'form',
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
 * Cap (cap.bug.im) — proof-of-work challenge, ALTCHA under the hood.
 *
 * Deliberately used as the reference for the **third** widget protocol. Cap is
 * neither a factory (`script`) nor a custom element the host can read from
 * (`element`): its loader scans the page for `div.cap-captcha`,
 * renders an `<altcha-widget>` inside it, and writes the solution into a hidden
 * input it injects into the surrounding `<form>`. A React form has three
 * consequences, all handled by the host's `container` branch:
 *
 *  - the container must be *inside* the form, or the injected input never joins
 *    the submission;
 *  - a loader that already scanned `DOMContentLoaded` cannot see a container
 *    mounted later, hence `remount` (`window.capCaptcha.mount()`);
 *  - the token arrives through the DOM, not a callback.
 *
 * `siteverify` takes **JSON** and may answer `{success:true, degraded:true}` when
 * it could not fully verify — that is honoured as a rejection via `denyFields`.
 * `https://cap.bug.im/docs`
 */
const CAP: Preset = {
  id: 'cap',
  label: 'Cap（cap.bug.im / ALTCHA PoW）',
  verifyUrl: 'https://cap.bug.im/v1/siteverify',
  requestFormat: 'json',
  tokenField: 'response',
  secretField: 'secret',
  successField: 'success',
  errorFields: ['error-codes', 'error'],
  denyFields: ['degraded'],
  optionalFields: [],
  supportsAction: false,
  widget: {
    script: 'https://cap.bug.im/v1.js',
    containerClass: 'cap-captcha',
    remount: 'capCaptcha.mount',
    hiddenField: 'cap-response',
    sources: {
      script: ['https://cap.bug.im'],
      style: ['https://cap.bug.im'],
      connect: ['https://cap.bug.im'],
      // ALTCHA solves in `new Worker(URL.createObjectURL(blob))`.
      worker: ['https://cap.bug.im'],
    },
  },
  hint: 'cap.bug.im：填 sitekey 与 csk_ 密钥即可。允许域名需包含页面实际 hostname，本地测试要把 127.0.0.1 单独加入。',
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
  denyFields: [],
  requestFormat: 'form',
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
