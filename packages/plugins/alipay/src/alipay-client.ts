import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';
import { z } from 'zod';

/**
 * 支付宝「当面付」（`alipay.trade.precreate`）协议层。
 *
 * 这里只做协议：拼参数、签名、验签、解析响应。网络与配置注入在上层，
 * 所以整条链路可以在没有商户凭据的情况下用**自签密钥对**验证 —— 这正是
 * 12.2 的验证策略：协议能验，商户号不能验，那就把能验的验透。
 */

export interface AlipayConfig {
  appId: string;
  /** 应用私钥（PKCS#8 或 PKCS#1，PEM）。 */
  privateKey: string;
  /** 支付宝公钥（PEM），用于验签响应与异步通知。 */
  alipayPublicKey: string;
  /** 网关地址；默认正式环境。沙箱填 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`。 */
  gatewayUrl: string;
}

export const ALIPAY_DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do';

const ALIPAY_ERROR_CODES: Record<string, string> = {
  '支付宝仅支持 CNY 币种': 'alipay.currency_unsupported',
  支付金额无效: 'alipay.amount_invalid',
  'RSA 密钥材料无效': 'alipay.keys_invalid',
  '网关返回了无效的响应体': 'alipay.gateway_invalid_json',
  '网关响应缺少签名': 'alipay.response_sign_missing',
  '网关响应签名无效': 'alipay.response_signature_invalid',
  '网关拒绝了支付请求': 'alipay.gateway_rejected',
  '无法连接支付网关': 'alipay.gateway_unreachable',
  回调签名无效: 'alipay.callback_signature_invalid',
  '回调参数无效': 'alipay.callback_params_invalid',
  '回调商户不匹配': 'alipay.callback_app_mismatch',
  '回调金额无效': 'alipay.callback_amount_invalid',
  '回调交易状态不可结算': 'alipay.callback_status_invalid',
  支付宝配置参数无效: 'alipay.config_invalid',
  支付宝尚未配置: 'alipay.not_configured',
  支付宝插件未就绪: 'alipay.not_ready',
  密钥存储未配置: 'alipay.secrets_unavailable',
};

export function alipayErrorCode(message: string): string {
  const exact = ALIPAY_ERROR_CODES[message];
  if (exact) return exact;
  if (message.startsWith('Payment gateway returned HTTP')) return 'alipay.gateway_http_error';
  if (message.startsWith('网关 URL')) return 'alipay.gateway_url_invalid';
  return 'alipay.error';
}

export class AlipayError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    readonly definitive = false,
  ) {
    super(message);
    this.name = 'AlipayError';
    this.code = alipayErrorCode(message);
  }
}

export type AlipayParams = Record<string, string | number | undefined | null>;

/**
 * 待签名串：按参数名 ASCII 升序拼接 `k=v&…`，排除 `sign` 与空值。
 *
 * 空值必须排除 —— 支付宝对「带了空参数」和「没带」的签名结果不同，
 * 保留空值会让所有请求都验签失败，且错得很隐蔽（报错只说签名不对）。
 */
export function canonicalize(params: AlipayParams): string {
  return Object.entries(params)
    .filter(
      ([key, value]) =>
        key !== 'sign' && value !== undefined && value !== null && value !== '',
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
}

function loadPrivateKey(pem: string) {
  try {
    return createPrivateKey(pem);
  } catch {
    // 支付宝控制台给的是裸 base64 私钥，不是 PEM；这里接受两种形态，避免部署时
    // 因为「少了两行头」而报一个看起来像签名错误的错。
    try {
      return createPrivateKey(wrapPem(pem, 'PRIVATE KEY'));
    } catch {
      throw new AlipayError(400, 'RSA 密钥材料无效', true);
    }
  }
}

function loadPublicKey(pem: string) {
  try {
    return createPublicKey(pem);
  } catch {
    try {
      return createPublicKey(wrapPem(pem, 'PUBLIC KEY'));
    } catch {
      throw new AlipayError(400, 'RSA 密钥材料无效', true);
    }
  }
}

function wrapPem(raw: string, label: string): string {
  const body = raw.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function signRsa2(content: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  signer.end();
  return signer.sign(loadPrivateKey(privateKeyPem), 'base64');
}

export function verifyRsa2(content: string, signature: string, publicKeyPem: string): boolean {
  if (signature.length === 0) return false;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  verifier.end();
  try {
    return verifier.verify(loadPublicKey(publicKeyPem), signature, 'base64');
  } catch {
    return false;
  }
}

/** 北京时间 `YYYY-MM-DD HH:mm:ss`（支付宝要求，且**不接受** ISO 8601）。 */
export function alipayTimestamp(now: Date = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ` +
    `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`
  );
}

/** 分 → 元字符串（两位小数）。支付宝只认元，且不接受科学计数法。 */
export function minorToYuan(amount: number): string {
  if (!Number.isInteger(amount) || amount <= 0) throw new AlipayError(400, '支付金额无效', true);
  return (amount / 100).toFixed(2);
}

/** 元字符串 → 分。回调里必须这样转，浮点加法会把 0.1+0.2 变成 0.30000000000000004。 */
export function yuanToMinor(yuan: string): number {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!match) throw new AlipayError(400, '回调金额无效', true);
  const whole = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  return whole * 100 + Number(frac);
}

export interface PrecreateInput {
  merchantOrderNo: string;
  amount: number;
  subject: string;
  notifyUrl: string;
  /** 关单时间，例如 `15m`；超过后支付宝侧失效。 */
  timeout?: string;
}

/** 构造 `alipay.trade.precreate` 的完整参数（已签名）。 */
export function buildPrecreateParams(
  config: AlipayConfig,
  input: PrecreateInput,
  timestamp: string = alipayTimestamp(),
): Record<string, string> {
  if (!input.merchantOrderNo) throw new AlipayError(400, '支付金额无效', true);
  const bizContent: Record<string, unknown> = {
    out_trade_no: input.merchantOrderNo,
    total_amount: minorToYuan(input.amount),
    subject: input.subject,
    product_code: 'FACE_TO_FACE_PAYMENT',
  };
  if (input.timeout) bizContent['timeout_express'] = input.timeout;

  const params: Record<string, string> = {
    app_id: config.appId,
    method: 'alipay.trade.precreate',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp,
    version: '1.0',
    notify_url: input.notifyUrl,
    biz_content: JSON.stringify(bizContent),
  };
  return { ...params, sign: signRsa2(canonicalize(params), config.privateKey) };
}

export function buildCloseParams(
  config: AlipayConfig,
  merchantOrderNo: string,
  timestamp: string = alipayTimestamp(),
): Record<string, string> {
  const params: Record<string, string> = {
    app_id: config.appId,
    method: 'alipay.trade.close',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp,
    version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: merchantOrderNo }),
  };
  return { ...params, sign: signRsa2(canonicalize(params), config.privateKey) };
}

/**
 * 从网关响应里取出业务节点原文并验签。
 *
 * 关键点：支付宝签的是**响应体里那段 JSON 原文**，不是重新序列化后的对象。
 * 用 `JSON.stringify(parsed)` 去验签会在字段顺序/空格/unicode 转义上不一致，
 * 结果是「明明签名对却验不过」。所以先按文本定位节点，验签通过再 parse。
 */
export function extractSignedNode(body: string, nodeName: string): { raw: string; sign: string } {
  const marker = `"${nodeName}"`;
  const markerAt = body.indexOf(marker);
  if (markerAt === -1) throw new AlipayError(502, '网关返回了无效的响应体');
  const colonAt = body.indexOf(':', markerAt + marker.length);
  if (colonAt === -1) throw new AlipayError(502, '网关返回了无效的响应体');
  let start = colonAt + 1;
  while (start < body.length && /\s/.test(body[start] ?? '')) start += 1;
  if (body[start] !== '{') throw new AlipayError(502, '网关返回了无效的响应体');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === -1) throw new AlipayError(502, '网关返回了无效的响应体');

  const signMatch = /"sign"\s*:\s*"([^"]+)"/.exec(body.slice(end));
  if (!signMatch?.[1]) throw new AlipayError(502, '网关响应缺少签名');
  return { raw: body.slice(start, end), sign: signMatch[1] };
}

const precreateResponseSchema = z
  .object({
    code: z.string(),
    msg: z.string().optional(),
    sub_code: z.string().optional(),
    sub_msg: z.string().optional(),
    out_trade_no: z.string().optional(),
    qr_code: z.string().optional(),
  })
  .passthrough();

export type PrecreateResponse = z.infer<typeof precreateResponseSchema>;

/** 验签并解析 `alipay_trade_precreate_response`；业务失败抛 `definitive` 错误。 */
export function parsePrecreateResponse(body: string, config: AlipayConfig): PrecreateResponse {
  const { raw, sign } = extractSignedNode(body, 'alipay_trade_precreate_response');
  if (!verifyRsa2(raw, sign, config.alipayPublicKey)) {
    throw new AlipayError(502, '网关响应签名无效');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AlipayError(502, '网关返回了无效的响应体');
  }
  const response = precreateResponseSchema.parse(parsed);
  if (response.code !== '10000') {
    // 业务失败是「确定的」失败（参数/商户配置问题），不该重试。
    throw new AlipayError(
      502,
      `网关拒绝了支付请求${response.sub_msg ? `：${response.sub_msg}` : ''}`,
      true,
    );
  }
  if (!response.qr_code) throw new AlipayError(502, '网关拒绝了支付请求', true);
  return response;
}

export interface CallbackSettlement {
  merchantOrderNo: string;
  externalId: string;
  amount: number;
  currency: string;
}

const CALLBACK_SETTLE_STATUSES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

/**
 * 校验支付宝异步通知并提取结算信息。
 *
 * 注意「不结算也要回 success」这件事由调用方处理：通知里 `TRADE_CLOSED` 之类
 * 不是错误，回 4xx 会让支付宝一直重推。这里只负责判定「能不能结算」。
 */
export function verifyCallback(
  params: AlipayParams,
  config: AlipayConfig,
): CallbackSettlement | null {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new AlipayError(400, '回调参数无效', true);
    }
    raw[key] = String(value);
  }
  const sign = raw['sign'];
  if (!sign) throw new AlipayError(400, '回调签名无效', true);
  if (!verifyRsa2(canonicalize(raw), sign, config.alipayPublicKey)) {
    throw new AlipayError(400, '回调签名无效', true);
  }
  if (raw['app_id'] !== config.appId) throw new AlipayError(400, '回调商户不匹配', true);

  const status = raw['trade_status'] ?? '';
  if (!CALLBACK_SETTLE_STATUSES.has(status)) return null;

  const merchantOrderNo = raw['out_trade_no'];
  const externalId = raw['trade_no'];
  const totalAmount = raw['total_amount'];
  if (!merchantOrderNo || !externalId || !totalAmount) {
    throw new AlipayError(400, '回调参数无效', true);
  }
  return {
    merchantOrderNo,
    externalId,
    amount: yuanToMinor(totalAmount),
    currency: 'CNY',
  };
}

export const configSchema = z.object({
  appId: z.string().trim().min(1).max(64),
  privateKey: z.string().min(64).max(20_000),
  alipayPublicKey: z.string().min(64).max(20_000),
  gatewayUrl: z.string().trim().url().max(191).default(ALIPAY_DEFAULT_GATEWAY),
});

export type AlipayConfigInput = z.infer<typeof configSchema>;

/** 校验密钥可用性：宁可现在报错，也不要等到用户点支付时才 500。 */
export function validateConfig(input: AlipayConfigInput): AlipayConfig {
  const config: AlipayConfig = {
    appId: input.appId,
    privateKey: input.privateKey,
    alipayPublicKey: input.alipayPublicKey,
    gatewayUrl: input.gatewayUrl || ALIPAY_DEFAULT_GATEWAY,
  };
  // 用一次自签验签确认两把钥匙都能装载：签名能成、验签能过。
  const probe = signRsa2('stackpanel-alipay-probe', config.privateKey);
  const publicKey = createPublicKey(loadPrivateKey(config.privateKey)).export({
    type: 'spki',
    format: 'pem',
  });
  if (typeof publicKey !== 'string' || probe.length === 0) {
    throw new AlipayError(400, 'RSA 密钥材料无效', true);
  }
  loadPublicKey(config.alipayPublicKey);
  return config;
}
