import {
  X509Certificate,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

/**
 * 微信支付 v3 协议层（纯函数 + 真实 crypto）。
 *
 * 三件容易做错的事，对应下面三个函数：
 * 1. 请求签名串是 `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n`（末尾也有换行），
 *    少一个 `\n` 就是 401 `SIGN_ERROR`，而且报错不会告诉你是哪一段错了。
 * 2. 回调/应答的签名串是 `TIMESTAMP\nNONCE\nBODY\n` —— 与请求的不同，且必须用
 *    **原始报文字符串**，不能 `JSON.stringify(parsed)`（字段顺序一变就验不过）。
 * 3. 回调解密是 AES-256-GCM，`ciphertext` 是 `密文 || 认证标签(16B)` 的 base64，
 *    APIv3 密钥不是 hex 而就是 32 个字符本身。
 */

export const WECHATPAY_DEFAULT_API_BASE = 'https://api.mch.weixin.qq.com';

/** 回调时间戳容差：超过 5 分钟视为重放。 */
export const NOTIFICATION_TIMESTAMP_TOLERANCE_S = 300;

const PEM_LINE = 64;

export const WECHATPAY_ERROR_CODES = {
  'config-invalid': '微信支付配置无效',
  'config-missing': '微信支付尚未配置',
  'key-invalid': 'RSA 密钥材料无效',
  'api-v3-key-invalid': 'APIv3 密钥必须是 32 个字符',
  'request-failed': '无法连接微信支付网关',
  'gateway-error': '微信支付网关返回错误',
  'sign-error': '微信支付请求签名失败',
  'verify-failed': '微信支付应答签名无效',
  'notification-invalid': '回调报文无效',
  'notification-expired': '回调时间戳超出容差',
  'decrypt-failed': '回调报文解密失败',
  'appid-mismatch': '回调 AppID 与配置不一致',
  'unsupported-currency': '微信支付仅支持 CNY 币种',
  'order-create-failed': '微信支付下单失败',
} as const;

export type WechatPayErrorCode = keyof typeof WECHATPAY_ERROR_CODES;

export class WechatPayError extends Error {
  /** 是否属于「重试也没用」的确定性失败（参数/配置/签名问题）。 */
  readonly definitive: boolean;

  constructor(
    readonly code: WechatPayErrorCode,
    message: string = WECHATPAY_ERROR_CODES[code],
    readonly status = 502,
    definitive = false,
  ) {
    super(message);
    this.name = 'WechatPayError';
    this.definitive = definitive;
  }
}

export const configSchema = z.object({
  appId: z.string().trim().min(1).max(64),
  mchId: z.string().trim().min(1).max(64),
  /** 商户 API 证书序列号（不是证书内容）。 */
  serialNo: z.string().trim().min(1).max(64),
  /** 商户 API 私钥（apiclient_key.pem 内容），裸 base64 也接受。 */
  privateKey: z.string().trim().min(1).max(20_000),
  /** APIv3 密钥：32 个字符，用于回调解密。 */
  apiV3Key: z.string().length(32),
  /** 微信支付平台公钥（PEM），用于应答与回调验签。 */
  platformPublicKey: z.string().trim().min(1).max(20_000),
  apiBase: z.string().trim().url().max(512).optional(),
});

export type WechatPayConfig = z.infer<typeof configSchema>;

export interface SignedRequest {
  authorization: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface NotificationHeaders {
  timestamp?: string | undefined;
  nonce?: string | undefined;
  signature?: string | undefined;
  serial?: string | undefined;
}

export interface DecryptedTransaction {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  success_time?: string;
  amount?: { total?: number; currency?: string; payer_total?: number };
}

function wrapPem(body: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += PEM_LINE) lines.push(body.slice(i, i + PEM_LINE));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** 接受 PEM 或裸 base64；控制台复制出来的通常是裸 base64。 */
export function loadPrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  try {
    if (trimmed.includes('BEGIN')) return createPrivateKey(trimmed);
    return createPrivateKey(wrapPem(trimmed.replace(/\s+/g, ''), 'PRIVATE KEY'));
  } catch {
    throw new WechatPayError('key-invalid', WECHATPAY_ERROR_CODES['key-invalid'], 400, true);
  }
}

export function loadPublicKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  try {
    if (trimmed.includes('BEGIN')) return createPublicKey(trimmed);
    return createPublicKey(wrapPem(trimmed.replace(/\s+/g, ''), 'PUBLIC KEY'));
  } catch {
    throw new WechatPayError('key-invalid', WECHATPAY_ERROR_CODES['key-invalid'], 400, true);
  }
}

export function rsaSign(message: string, privateKey: KeyObject): string {
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(privateKey, 'base64');
}

export function rsaVerify(message: string, signature: string, publicKey: KeyObject): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(message);
  verifier.end();
  try {
    return verifier.verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

/** 请求签名串。注意末尾的换行，它属于签名内容本身。 */
export function requestSignMessage(input: {
  method: string;
  urlPath: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return `${input.method.toUpperCase()}\n${input.urlPath}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;
}

/** 应答/通知签名串（只有三段）。 */
export function notificationSignMessage(input: {
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return `${input.timestamp}\n${input.nonce}\n${input.body}\n`;
}

export function buildAuthorization(input: {
  method: string;
  urlPath: string;
  body: string;
  mchId: string;
  serialNo: string;
  privateKey: KeyObject;
  timestamp?: string;
  nonce?: string;
}): SignedRequest {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const signature = rsaSign(
    requestSignMessage({
      method: input.method,
      urlPath: input.urlPath,
      timestamp,
      nonce,
      body: input.body,
    }),
    input.privateKey,
  );
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchId}",` +
    `nonce_str="${nonce}",` +
    `signature="${signature}",` +
    `timestamp="${timestamp}",` +
    `serial_no="${input.serialNo}"`;
  return { authorization, timestamp, nonce, signature };
}

/**
 * 校验应答/回调签名。
 *
 * 时间戳容差是**防重放**的：微信会重推通知，但重推时必须带新签名，一张旧报文
 * 原样重放不能无限次通过。
 */
export function verifyNotification(input: {
  headers: NotificationHeaders;
  body: string;
  platformPublicKey: KeyObject;
  now?: number;
}): void {
  const timestamp = input.headers.timestamp;
  const nonce = input.headers.nonce;
  const signature = input.headers.signature;
  if (!timestamp || !nonce || !signature) {
    throw new WechatPayError('notification-invalid', WECHATPAY_ERROR_CODES['notification-invalid'], 401, true);
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age) || age > NOTIFICATION_TIMESTAMP_TOLERANCE_S) {
    throw new WechatPayError('notification-expired', WECHATPAY_ERROR_CODES['notification-expired'], 401, true);
  }
  const ok = rsaVerify(
    notificationSignMessage({ timestamp, nonce, body: input.body }),
    signature,
    input.platformPublicKey,
  );
  if (!ok) {
    throw new WechatPayError('verify-failed', WECHATPAY_ERROR_CODES['verify-failed'], 401, true);
  }
}

/**
 * 解密回调 `resource`。
 *
 * `ciphertext` 是 base64 编码的 `密文 || 16 字节认证标签`，不是纯密文 —— 直接
 * 把整段当密文喂给 decipher 会在 `final()` 抛「unable to authenticate data」。
 */
export function decryptResource(input: {
  ciphertext: string;
  nonce: string;
  associatedData?: string | undefined;
  apiV3Key: string;
}): string {
  if (Buffer.byteLength(input.apiV3Key, 'utf8') !== 32) {
    throw new WechatPayError(
      'api-v3-key-invalid',
      WECHATPAY_ERROR_CODES['api-v3-key-invalid'],
      500,
      true,
    );
  }
  try {
    const raw = Buffer.from(input.ciphertext, 'base64');
    if (raw.length <= 16) throw new Error('ciphertext too short');
    const data = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(input.apiV3Key, 'utf8'),
      Buffer.from(input.nonce, 'utf8'),
    );
    decipher.setAuthTag(tag);
    if (input.associatedData) decipher.setAAD(Buffer.from(input.associatedData, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof WechatPayError) throw error;
    throw new WechatPayError('decrypt-failed', WECHATPAY_ERROR_CODES['decrypt-failed'], 401, true);
  }
}

/** 测试与调试用：按微信的格式加密一段明文。 */
export function encryptResource(input: {
  plaintext: string;
  nonce: string;
  associatedData?: string | undefined;
  apiV3Key: string;
}): string {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(input.apiV3Key, 'utf8'),
    Buffer.from(input.nonce, 'utf8'),
  );
  if (input.associatedData) cipher.setAAD(Buffer.from(input.associatedData, 'utf8'));
  const body = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString('base64');
}

export function buildNativeOrderBody(
  config: Pick<WechatPayConfig, 'appId' | 'mchId'>,
  request: { merchantOrderNo: string; amount: number; subject: string; notifyUrl: string; expiresInMs?: number },
): Record<string, unknown> {
  const timeExpire =
    request.expiresInMs === undefined
      ? undefined
      : new Date(Date.now() + request.expiresInMs).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return {
    appid: config.appId,
    mchid: config.mchId,
    description: request.subject.slice(0, 127),
    out_trade_no: request.merchantOrderNo,
    ...(timeExpire ? { time_expire: timeExpire } : {}),
    notify_url: request.notifyUrl,
    // 微信支付金额单位就是「分」，与内核 amount 一致，不做换算。
    amount: { total: request.amount, currency: 'CNY' },
  };
}

export function parseNativeOrderResponse(body: string): { code_url?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WechatPayError('gateway-error', '微信支付应答不是 JSON', 502, true);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new WechatPayError('gateway-error', '微信支付应答格式无效', 502, true);
  }
  return parsed as { code_url?: string };
}

/** 网关错误体是 `{code, message, detail}`，不是 RFC 7807。 */
export function parseErrorBody(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    return {
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}

/** 一张已解密并校验过有效期的微信支付平台证书。 */
export interface PlatformCertificate {
  serialNo: string;
  certificatePem: string;
  publicKey: KeyObject;
  /** `X509Certificate.validTo` 的毫秒时间戳；过期即不可用于验签。 */
  expiresAtMs: number;
}

/**
 * 解析 `GET /v3/certificates` 的应答。
 *
 * 这一步有个鸡生蛋问题：应答本身要验签，而要验签就得先有平台公钥。所以首次
 * 必须由管理员贴一张（bootstrap），之后的轮换才由轮换任务接管 —— 这也是配置里
 * `platformPublicKey` 仍然必填的原因，不是偷懒。
 *
 * 解出来的内容是一张 X.509 证书（不是裸公钥），`createPublicKey` 不接受无结构的
 * 字符串，所以用 `X509Certificate` 解析并顺手拿到有效期：**过期证书不装**，
 * 否则轮换失败时我们会拿着过期证书继续验签，症状是所有回调突然 401。
 */
export function parseCertificateList(
  body: string,
  apiV3Key: string,
  now: number = Date.now(),
): PlatformCertificate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WechatPayError('gateway-error', '平台证书列表不是 JSON', 502, true);
  }
  const list = (parsed as { data?: unknown }).data;
  if (!Array.isArray(list)) {
    throw new WechatPayError('gateway-error', '平台证书列表格式无效', 502, true);
  }

  const certificates: PlatformCertificate[] = [];
  for (const item of list) {
    const entry = item as {
      serial_no?: unknown;
      encrypt_certificate?: { ciphertext?: unknown; nonce?: unknown; associated_data?: unknown };
    };
    const serialNo = typeof entry.serial_no === 'string' ? entry.serial_no.trim() : '';
    const encrypted = entry.encrypt_certificate;
    if (!serialNo || !encrypted) continue;
    if (typeof encrypted.ciphertext !== 'string' || typeof encrypted.nonce !== 'string') continue;

    const pem = decryptResource({
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      ...(typeof encrypted.associated_data === 'string'
        ? { associatedData: encrypted.associated_data }
        : {}),
      apiV3Key,
    });
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(pem);
    } catch {
      throw new WechatPayError('gateway-error', '平台证书无法解析', 502, true);
    }
    const expiresAtMs = Date.parse(certificate.validTo);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
    certificates.push({
      serialNo,
      certificatePem: pem,
      publicKey: certificate.publicKey,
      expiresAtMs,
    });
  }

  if (certificates.length === 0) {
    throw new WechatPayError('gateway-error', '平台证书列表里没有可用证书', 502, true);
  }
  return certificates;
}

/**
 * 平台公钥的按键索引。
 *
 * 应答/回调的 `Wechatpay-Serial` 头指出该用哪张证书验签 —— 平台轮换期间新旧并存，
 * **不能**用「当前唯一一张」。找不到时退回 bootstrap 公钥，再找不到就拒绝验签。
 */
export class PlatformKeyring {
  private readonly keys = new Map<string, PlatformCertificate>();

  constructor(private readonly fallback?: KeyObject) {}

  replace(certificates: PlatformCertificate[]): void {
    this.keys.clear();
    for (const certificate of certificates) this.keys.set(certificate.serialNo, certificate);
  }

  get size(): number {
    return this.keys.size;
  }

  /** 按 `Wechatpay-Serial` 取值；未命中且没有有效证书时返回 undefined（调用方必须拒绝）。 */
  forSerial(serial: string | undefined, now: number = Date.now()): KeyObject | undefined {
    const direct = serial ? this.keys.get(serial) : undefined;
    if (direct && direct.expiresAtMs > now) return direct.publicKey;
    // 轮换窗口内旧序列号可能已下线：任取一张仍然有效的证书，比「验签直接失败」好。
    for (const certificate of this.keys.values()) {
      if (certificate.expiresAtMs > now) return certificate.publicKey;
    }
    return this.fallback;
  }

  describe(now: number = Date.now()): Array<{ serialNo: string; expiresAtMs: number }> {
    return [...this.keys.values()]
      .filter((certificate) => certificate.expiresAtMs > now)
      .map((certificate) => ({ serialNo: certificate.serialNo, expiresAtMs: certificate.expiresAtMs }));
  }
}

export function buildCloseOrderBody(config: Pick<WechatPayConfig, 'mchId'>): Record<string, unknown> {
  return { mchid: config.mchId };
}

/**
 * 校验 API 基址：https + 域名 + 路径前缀，禁 IP 字面量与内网域名。
 *
 * 微信支付用不到自定义基址（不像支付宝有沙箱域名），但测试需要打本地桩，
 * 所以保留了可配置项 —— 那就必须把它当 SSRF 入口来防。
 */
export function assertApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WechatPayError('config-invalid', 'API 基址无效', 400, true);
  }
  if (url.protocol !== 'https:') {
    throw new WechatPayError('config-invalid', 'API 基址必须使用 https', 400, true);
  }
  const host = url.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    throw new WechatPayError('config-invalid', 'API 基址不能是 IP 地址', 400, true);
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new WechatPayError('config-invalid', 'API 基址不能指向内网', 400, true);
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

export function validateConfig(config: WechatPayConfig): WechatPayConfig & {
  privateKeyObject: KeyObject;
  platformKeyObject: KeyObject;
  apiBase: string;
} {
  if (Buffer.byteLength(config.apiV3Key, 'utf8') !== 32) {
    throw new WechatPayError(
      'api-v3-key-invalid',
      WECHATPAY_ERROR_CODES['api-v3-key-invalid'],
      400,
      true,
    );
  }
  const privateKeyObject = loadPrivateKey(config.privateKey);
  const platformKeyObject = loadPublicKey(config.platformPublicKey);
  const apiBase = assertApiBase(config.apiBase ?? WECHATPAY_DEFAULT_API_BASE);
  return { ...config, privateKeyObject, platformKeyObject, apiBase };
}

/**
 * 常量时间比较 AppID，避免用 `===` 在错误提示里泄漏逐字符比较时长。
 * （回调里的 appid 是明文，风险很低，但这类比较本来就该这么写。）
 */
export function sameAppId(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
