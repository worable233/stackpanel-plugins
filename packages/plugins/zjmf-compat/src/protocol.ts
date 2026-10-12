import type { SpV1Product, SpV1Service } from './bridge.js';

/**
 * Pure ZJMF wire helpers: form decoding, the `{status,msg,data}` envelope and
 * the platform → ZJMF resource projections. No I/O, so the translation is
 * unit-testable in isolation.
 *
 * The reference clients treat the envelope `status` as the authority and always
 * receive HTTP 200 for protocol responses (see `zjmf-client.ts`
 * `authorizedRequest`, which retries on `status` 401/405).
 */

export type FormBody = Record<string, string | string[]>;

export function parseForm(raw: string | Uint8Array): FormBody {
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
  const params = new URLSearchParams(text);
  const out: FormBody = {};
  for (const [key, value] of params) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** First value of a (possibly repeated) form field. */
export function field(form: FormBody, key: string): string | undefined {
  const value = form[key];
  return Array.isArray(value) ? value[0] : value;
}

export function intField(form: FormBody, key: string, fallback = 1): number {
  const raw = field(form, key);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Collect `configoption[<id>]` selections into a flat map. */
export function collectSelections(form: FormBody): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    const match = /^configoption\[(.+)\]$/.exec(key);
    if (!match) continue;
    const id = match[1];
    if (!id) continue;
    const scalar = Array.isArray(value) ? value[0] : value;
    if (scalar !== undefined && scalar !== '') selections[id] = scalar;
  }
  return selections;
}

export function envelope(status: number, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ status, ...payload });
}

export function errorEnvelope(status: number, msg: string): string {
  return JSON.stringify({ status, msg });
}

/** ZJMF clients settle in major units; ours are minor. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND']);

export function minorToMajor(minor: number, currency: string): string {
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
  return (minor / 10 ** digits).toFixed(digits);
}

/** Platform catalog item → ZJMF product shape consumed by `normalizeProduct`. */
export function toZjmfProduct(product: SpV1Product): Record<string, unknown> {
  const price = minorToMajor(product.price, product.currency);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price,
    sale_price: price,
    currency_code: product.currency,
    qty: product.stock,
    status: product.status,
  };
}

/** Platform service → 魔方财务 host shape (`domainstatus` is the run state). */
export function toZjmfHost(service: SpV1Service): Record<string, unknown> {
  return {
    id: service.id,
    domain: service.productName,
    name: service.productName,
    domainstatus: service.status,
    status_text: service.status,
  };
}

/** 魔方 `func` → platform lifecycle action. */
export function provisionAction(func: string): 'suspend' | 'resume' | 'terminate' | null {
  switch (func) {
    case 'suspend':
      return 'suspend';
    case 'unsuspend':
    case 'resume':
      return 'resume';
    case 'terminate':
    case 'delete':
      return 'terminate';
    default:
      return null;
  }
}
