/**
 * 企业微信「应用发送邮件」客户端（零依赖，只用全局 `fetch`）。
 *
 * 文档：<https://developer.work.weixin.qq.com/document/path/97445>
 *
 *   POST /cgi-bin/exmail/app/compose_send?access_token=ACCESS_TOKEN
 *   { "to": { "emails": ["a@b.com"] }, "subject": "…", "content": "…",
 *     "content_type": "html", "cc": …, "bcc": … }
 *
 * 两件必须做对、否则线上表现为"配好了但发不出去"的事：
 *
 * 1. **access_token 必须缓存。** token 由 `corpid` + 自建应用 secret 换取，有效期
 *    7200 秒；企业微信对 `gettoken` 本身有频率限制。每封信都换 token 会先撞限频
 *    （45009），再表现为发送失败。
 * 2. **token 会在缓存期内被服务端作废**（改了 secret、重新授权、管理员手动刷新）。
 *    所以发送遇到 token 类错误码时清缓存并重试一次，而不是把 40014 直接抛给用户。
 *
 * 这个客户端**不重试业务错误**：收件人地址非法、应用无邮箱权限、IP 不在白名单
 * 都是配置问题，重试只会把一次失败变成三次日志。业务错误照原样上报，由内核决定
 * 是否重投（通知通道的语义是"抛错即请求重试"）。
 */

export interface WecomMailConfig {
  /** 企业 ID（我的企业 → 企业信息）。 */
  corpId: string;
  /** 自建应用的 Secret（应用管理 → 应用 → Secret）。 */
  corpSecret: string;
  /** 默认 `https://qyapi.weixin.qq.com`；允许指向内网代理/镜像。 */
  baseUrl: string;
  /** 单次 HTTP 超时（毫秒）。 */
  timeoutMs: number;
}

export interface WecomMailMessage {
  to: string[];
  subject: string;
  content: string;
  contentType: 'html' | 'text';
  cc?: string[];
  bcc?: string[];
}

/** 稳定的错误码：前端只做本地化映射，不判断厂商错误文本。 */
export type WecomErrorCode =
  | 'wecom.invalid_corp_id'
  | 'wecom.invalid_secret'
  | 'wecom.ip_not_allowed'
  | 'wecom.mail_forbidden'
  | 'wecom.token_invalid'
  | 'wecom.rate_limited'
  | 'wecom.network_error'
  | 'wecom.bad_response'
  | 'wecom.send_failed';

export class WecomError extends Error {
  readonly code: WecomErrorCode;
  /** 企业微信原始错误码；`undefined` 表示根本没拿到业务响应（网络/解析）。 */
  readonly errcode: number | undefined;

  constructor(
    code: WecomErrorCode,
    message: string,
    options: { errcode?: number | undefined; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WecomError';
    this.code = code;
    this.errcode = options.errcode;
  }
}

/** 换一个新 token 就能恢复：都是"这次的 token 不可用"。 */
const TOKEN_RETRYABLE = new Set([
  40014, // 不合法的 access_token
  42001, // access_token 已过期
  41001, // 缺少 access_token
]);

/** 厂商错误码 → 稳定错误码。未列出的一律 `wecom.send_failed`（保留原始 errcode）。 */
const CODE_BY_ERRCODE: Record<number, WecomErrorCode> = {
  40001: 'wecom.invalid_secret',
  40013: 'wecom.invalid_corp_id',
  48002: 'wecom.mail_forbidden',
  60011: 'wecom.mail_forbidden',
  60020: 'wecom.ip_not_allowed',
  45009: 'wecom.rate_limited',
  45033: 'wecom.rate_limited',
};

/** 企业微信单次最多 50 个收件人。 */
const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 512;
/** 正文上限：企业微信侧更小，这里只挡住明显异常（例如误把整个页面塞进通知）。 */
const MAX_CONTENT_BYTES = 512 * 1024;
/** 提前一分钟换 token，避免"刚好过期"的边界。 */
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 7200;

interface WecomResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

export interface WecomClientDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  warn?: (message: string) => void;
}

export class WecomMailClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: WecomMailConfig,
    private readonly deps: WecomClientDeps = {},
  ) {}

  /** 当前 token 缓存状态（后台诊断用）：未缓存时为 `null`。 */
  tokenState(): { expiresInSeconds: number } | null {
    if (!this.token) return null;
    const left = Math.max(0, Math.floor((this.token.expiresAt - this.now()) / 1000));
    return { expiresInSeconds: left };
  }

  invalidateToken(): void {
    this.token = null;
  }

  /** 发一封普通邮件。抛 {@link WecomError}，不返回半成品结果。 */
  async send(message: WecomMailMessage): Promise<void> {
    const body = this.buildBody(message);
    const token = await this.accessToken();
    try {
      await this.composeSend(token, body);
    } catch (error) {
      // token 在缓存有效期内被服务端作废：换一个再来一次，仅此一次。
      if (!(error instanceof WecomError) || !TOKEN_RETRYABLE.has(error.errcode ?? -1)) throw error;
      this.deps.warn?.(`wecom-mail: access_token 失效（${String(error.errcode)}），已刷新并重试`);
      this.invalidateToken();
      await this.composeSend(await this.accessToken(), body);
    }
  }

  /** 取（并缓存）access_token。`force` 供测试与配置变更后强制刷新。 */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now() + EXPIRY_SKEW_MS) {
      return this.token.value;
    }
    const url = new URL(`${this.base()}/cgi-bin/gettoken`);
    url.searchParams.set('corpid', this.config.corpId);
    url.searchParams.set('corpsecret', this.config.corpSecret);
    const data = await this.request(url.toString(), { method: 'GET' });
    if (!data.access_token) {
      throw new WecomError('wecom.bad_response', '企业微信未返回 access_token');
    }
    const ttl = (data.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
    this.token = { value: data.access_token, expiresAt: this.now() + ttl };
    return data.access_token;
  }

  private async composeSend(token: string, body: Record<string, unknown>): Promise<void> {
    const url = new URL(`${this.base()}/cgi-bin/exmail/app/compose_send`);
    url.searchParams.set('access_token', token);
    await this.request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private buildBody(message: WecomMailMessage): Record<string, unknown> {
    const to = dedupe(message.to);
    if (to.length === 0) {
      throw new WecomError('wecom.send_failed', '收件人为空');
    }
    if (to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) > MAX_RECIPIENTS) {
      throw new WecomError(
        'wecom.send_failed',
        `单次最多 ${MAX_RECIPIENTS} 个收件人（含抄送与密送）`,
      );
    }
    if (message.subject.length > MAX_SUBJECT) {
      throw new WecomError('wecom.send_failed', `主题超过 ${MAX_SUBJECT} 字符`);
    }
    if (Buffer.byteLength(message.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new WecomError('wecom.send_failed', '正文过大');
    }
    return {
      to: { emails: to },
      ...(message.cc?.length ? { cc: { emails: dedupe(message.cc) } } : {}),
      ...(message.bcc?.length ? { bcc: { emails: dedupe(message.bcc) } } : {}),
      subject: message.subject,
      content: message.content,
      content_type: message.contentType,
    };
  }

  /** 发一次请求并把「HTTP 200 + errcode≠0」翻译成异常（企业微信的失败也是 200）。 */
  private async request(url: string, init: RequestInit): Promise<WecomResponse> {
    const doFetch = this.deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new WecomError(
        'wecom.network_error',
        `无法连接企业微信接口（${error instanceof Error ? error.message : String(error)}）`,
        { cause: error },
      );
    }
    const raw = await response.text().catch(() => '');
    let data: WecomResponse;
    try {
      data = JSON.parse(raw) as WecomResponse;
    } catch {
      throw new WecomError(
        'wecom.bad_response',
        `企业微信返回了非 JSON 响应（HTTP ${response.status}）`,
        { errcode: undefined },
      );
    }
    const errcode = data.errcode ?? 0;
    if (errcode !== 0) {
      const mapped = TOKEN_RETRYABLE.has(errcode)
        ? 'wecom.token_invalid'
        : (CODE_BY_ERRCODE[errcode] ?? 'wecom.send_failed');
      throw new WecomError(mapped, `企业微信返回错误 ${errcode}：${data.errmsg ?? '未知原因'}`, {
        errcode,
      });
    }
    return data;
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
