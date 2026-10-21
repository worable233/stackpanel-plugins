import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

export interface EpayConfig {
  baseUrl: string;
  pid: string;
  privateKey: string;
  platformPublicKey: string;
  methods: Array<'alipay' | 'wxpay' | 'qqpay'>;
}

/** Stable codes for EasyPay errors (ADR-0012). */
const EPAY_ERROR_CODES: Record<string, string> = {
  金额无效: 'epay.amount_invalid',
  支付金额无效: 'epay.amount_invalid',
  '网关 URL 无效': 'epay.gateway_url_invalid',
  网关主机名无法解析: 'epay.gateway_unresolved',
  网关拒绝了支付请求: 'epay.gateway_rejected',
  网关返回了不完整的支付响应: 'epay.gateway_incomplete',
  无法连接支付网关: 'epay.gateway_unreachable',
  '支付网关返回了无效的 JSON': 'epay.gateway_invalid_json',
  支付网关响应无效: 'epay.gateway_invalid_response',
  支付网关响应签名无效: 'epay.signature_invalid',
  '商户 PID 无效': 'epay.pid_invalid',
  至少选择一个支付方式: 'epay.methods_required',
  'RSA 密钥材料无效': 'epay.keys_invalid',
  '易支付仅支持 CNY 币种': 'epay.currency_unsupported',
  密钥存储未配置: 'epay.secrets_unavailable',
  易支付配置参数无效: 'epay.config_invalid',
  易支付支付方式配置无效: 'epay.methods_invalid',
  易支付尚未配置: 'epay.not_configured',
  易支付插件未就绪: 'epay.not_ready',
  回调签名无效: 'epay.callback_signature_invalid',
  支付回调参数无效: 'epay.callback_params_invalid',
  支付回调参数不完整: 'epay.callback_params_incomplete',
  回调参数无效: 'epay.callback_params_invalid',
};

/** Resolve a stable code from an EasyPay error message (exact, then prefix). */
export function epayErrorCode(message: string): string {
  const exact = EPAY_ERROR_CODES[message];
  if (exact) return exact;
  if (message.startsWith('网关 URL 必须')) return 'epay.gateway_url_insecure';
  if (message.startsWith('Payment gateway returned HTTP')) return 'epay.gateway_http_error';
  return 'epay.error';
}

export class EpayError extends Error {
  /** Stable error code (ADR-0012). */
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    readonly definitive = false,
  ) {
    super(message);
    this.name = 'EpayError';
    this.code = epayErrorCode(message);
  }
}

type ScalarParameters = Record<string, string | number | undefined | null>;

const responseSchema = z
  .object({
    code: z.coerce.number(),
    msg: z.string().optional(),
    message: z.string().optional(),
    trade_no: z.string().optional(),
    pay_info: z.string().optional(),
    sign: z.string().optional(),
    sign_type: z.string().optional(),
  })
  .passthrough();

/** Canonical RSA payload used by the common EasyPay V2 family. */
export function canonicalize(parameters: Record<string, unknown>): string {
  return Object.entries(parameters)
    .filter(
      ([key, value]) =>
        key !== 'sign' &&
        key !== 'sign_type' &&
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !Array.isArray(value),
    )
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
}

export function signParameters(parameters: Record<string, unknown>, privateKey: string): string {
  const sign = createSign('RSA-SHA256');
  sign.update(canonicalize(parameters), 'utf8');
  sign.end();
  return sign.sign(loadPrivateKey(privateKey), 'base64');
}

export function verifyParameters(
  parameters: Record<string, unknown>,
  platformPublicKey: string,
): boolean {
  const signature = parameters['sign'];
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const verify = createVerify('RSA-SHA256');
  verify.update(canonicalize(parameters), 'utf8');
  verify.end();
  try {
    return verify.verify(loadPublicKey(platformPublicKey), signature, 'base64');
  } catch {
    return false;
  }
}

export function minorToDecimal(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new EpayError(400, '金额无效', true);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

export function decimalToMinor(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new EpayError(400, '支付金额无效', true);
  }
  const [units, fraction = ''] = value.split('.');
  const result = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result < 1) throw new EpayError(400, '支付金额无效', true);
  return result;
}

export function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EpayError(400, '网关 URL 无效', true);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isUnsafeHostname(url.hostname)
  ) {
    throw new EpayError(400, '网关 URL 必须为公网 HTTPS 源', true);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

/** Re-resolve on use to prevent a public hostname being changed to a private target. */
export async function assertPublicGatewayUrl(value: string): Promise<string> {
  const normalized = normalizeGatewayUrl(value);
  const hostname = new URL(normalized).hostname;
  const literal = isIP(hostname) ? hostname : null;
  if (literal) {
    if (isUnsafeIp(literal)) throw new EpayError(400, '网关 URL 必须为公网地址', true);
    return normalized;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new EpayError(502, '网关主机名无法解析');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeIp(address))) {
    throw new EpayError(400, '网关 URL 必须为公网地址', true);
  }
  return normalized;
}

export class EpayClient {
  constructor(
    private readonly config: EpayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createPayment(input: {
    method: string;
    merchantOrderNo: string;
    amount: number;
    subject: string;
    notifyUrl: string;
    returnUrl: string;
    clientIp?: string;
  }): Promise<{ externalId: string; paymentUrl: string }> {
    const parameters: ScalarParameters = {
      pid: this.config.pid,
      method: 'jump',
      type: input.method,
      out_trade_no: input.merchantOrderNo,
      notify_url: input.notifyUrl,
      return_url: input.returnUrl,
      name: input.subject,
      money: minorToDecimal(input.amount),
      clientip: safeClientIp(input.clientIp),
      timestamp: String(Math.floor(Date.now() / 1000)),
      sign_type: 'RSA',
    };
    const response = await this.post('/api/pay/create', parameters);
    if (response.code !== 0) {
      throw new EpayError(502, response.msg ?? response.message ?? '网关拒绝了支付请求', true);
    }
    if (!response.trade_no || !response.pay_info) {
      throw new EpayError(502, '网关返回了不完整的支付响应');
    }
    return { externalId: response.trade_no, paymentUrl: response.pay_info };
  }

  async closePayment(merchantOrderNo: string): Promise<boolean> {
    const response = await this.post('/api/pay/close', {
      pid: this.config.pid,
      out_trade_no: merchantOrderNo,
      timestamp: String(Math.floor(Date.now() / 1000)),
      sign_type: 'RSA',
    });
    return response.code === 0;
  }

  private async post(
    path: string,
    parameters: ScalarParameters,
  ): Promise<z.infer<typeof responseSchema>> {
    const baseUrl = await assertPublicGatewayUrl(this.config.baseUrl);
    const signed = { ...parameters, sign: signParameters(parameters, this.config.privateKey) };
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, `${baseUrl}/`), {
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(
          Object.entries(signed).reduce<Array<[string, string]>>(
            (entries, [key, value]) =>
              value === undefined ? entries : [...entries, [key, String(value)]],
            [],
          ),
        ),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new EpayError(502, '无法连接支付网关');
    }
    if (!response.ok) throw new EpayError(502, `Payment gateway returned HTTP ${response.status}`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new EpayError(502, '支付网关返回了无效的 JSON');
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new EpayError(502, '支付网关响应无效');
    // Only a success response carries trusted fields (trade_no/pay_info), so
    // that is the one we sign-verify. Gateways commonly return business
    // rejections (`code != 0`) *unsigned*; verifying them first masked the real
    // reason ("当前商户未完成实名认证，无法收款") as a bogus "签名无效". The
    // caller surfaces a rejection's `msg` verbatim and never trusts its fields.
    if (parsed.data.code === 0 && !verifyParameters(parsed.data, this.config.platformPublicKey)) {
      throw new EpayError(502, '支付网关响应签名无效');
    }
    return parsed.data;
  }
}

export function validateConfig(config: EpayConfig): EpayConfig {
  const baseUrl = normalizeGatewayUrl(config.baseUrl);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.pid)) throw new EpayError(400, '商户 PID 无效', true);
  if (config.methods.length === 0) throw new EpayError(400, '至少选择一个支付方式', true);
  try {
    loadPrivateKey(config.privateKey);
    loadPublicKey(config.platformPublicKey);
  } catch {
    throw new EpayError(400, 'RSA 密钥材料无效', true);
  }
  return { ...config, baseUrl, methods: [...new Set(config.methods)] };
}

const PEM_BLOCK = /-----BEGIN [^-]+-----/;

/**
 * Load an RSA private key from either a full PEM document or the bare base64
 * (DER) body that the EasyPay merchant panel copies out of its UI. Node's
 * `createPrivateKey` only accepts full PEM, so we detect the missing armor and
 * reconstruct it, trying the two common encodings (PKCS#8 "PRIVATE KEY" and
 * PKCS#1 "RSA PRIVATE KEY").
 */
export function loadPrivateKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (PEM_BLOCK.test(trimmed)) return createPrivateKey(trimmed);
  const der = decodeBase64Body(trimmed);
  const attempts: Array<() => KeyObject> = [
    () => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
    () => createPrivateKey({ key: der, format: 'der', type: 'pkcs1' }),
    () => createPrivateKey(wrapPem('PRIVATE KEY', der)),
    () => createPrivateKey(wrapPem('RSA PRIVATE KEY', der)),
  ];
  return attemptKey(attempts);
}

/**
 * Load an RSA public key from either a full PEM document or the bare base64
 * (DER) body the EasyPay panel provides. Accepts SPKI ("PUBLIC KEY") and PKCS#1
 * ("RSA PUBLIC KEY"), and tolerates a private key being supplied by mistake by
 * deriving the public half from it.
 */
export function loadPublicKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (PEM_BLOCK.test(trimmed)) return createPublicKey(trimmed);
  const der = decodeBase64Body(trimmed);
  const attempts: Array<() => KeyObject> = [
    () => createPublicKey({ key: der, format: 'der', type: 'spki' }),
    () => createPublicKey({ key: der, format: 'der', type: 'pkcs1' }),
    () => createPublicKey(wrapPem('PUBLIC KEY', der)),
    () => createPublicKey(wrapPem('RSA PUBLIC KEY', der)),
    // A private key body also yields the public key.
    () => createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
    () => createPrivateKey({ key: der, format: 'der', type: 'pkcs1' }),
  ];
  return attemptKey(attempts);
}

/** Decode a base64 body (whitespace/newlines allowed) into a DER buffer. */
function decodeBase64Body(material: string): Buffer {
  const compact = material.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new EpayError(400, 'RSA 密钥材料无效', true);
  }
  return Buffer.from(compact, 'base64');
}

/** Wrap raw DER bytes as a PEM document with the given label. */
function wrapPem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function attemptKey(attempts: Array<() => KeyObject>): KeyObject {
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Try the next encoding.
    }
  }
  throw new EpayError(400, 'RSA 密钥材料无效', true);
}

function safeClientIp(value: string | undefined): string {
  return value && isIP(value) === 4 ? value : '127.0.0.1';
}

function isUnsafeHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    (isIP(hostname) !== 0 && isUnsafeIp(hostname))
  );
}

function isUnsafeIp(value: string): boolean {
  if (isIP(value) === 4) {
    const [first = -1, second = -1] = value.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  const lower = value.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  );
}
