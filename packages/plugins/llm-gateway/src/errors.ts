/**
 * 稳定的 OpenAI 兼容错误模型。
 *
 * 目标四（13）：所有错误都必须转换成稳定的 OpenAI-compatible error schema。
 * 无论是入参校验失败、上游 429、账号熔断、计费补偿失败还是未知异常，客户端
 * 看到的都必须是同一形状：
 *
 *   { "error": { "message", "type", "code", "param"?, "status"? } }
 *
 * 这样 OpenAI SDK 的 `APIError` 解析、以及各种客户端库的重试判定
 * （`error.type === 'rate_limit_error'`）在所有分支上行为一致。
 *
 * 纪律：错误消息里**绝不能**出现上游 API key、内部文件路径或上游原始响应体。
 * 上游原文只进审计/日志，且经 `redactSecrets` 清洗。
 */

import type { RawHttpReply } from '@stackpanel/sdk';

/** OpenAI 错误 `type` 的封闭集合（与官方 SDK 的分支对齐）。 */
export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'method_not_allowed'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'timeout_error'
  | 'api_error'
  | 'overloaded_error';

/**
 * 稳定错误码。客户端与运维面板按 code 分支，不解析 message（message 会本地化）。
 * 新增码必须同时更新 `docs/API-COMPATIBILITY.md`。
 */
export type GatewayErrorCode =
  // 入参 / 协议
  | 'invalid_request'
  | 'invalid_json'
  | 'missing_model'
  | 'model_not_found'
  | 'model_not_allowed'
  | 'endpoint_not_found'
  | 'unsupported_endpoint'
  | 'unsupported_content_type'
  | 'payload_too_large'
  | 'unsupported_parameter'
  // 鉴权 / 授权
  | 'invalid_api_key'
  | 'key_expired'
  | 'insufficient_scope'
  | 'ip_not_allowed'
  | 'permission_revoked'
  // 配额 / 限速
  | 'rate_limited'
  | 'concurrency_limited'
  | 'insufficient_balance'
  | 'quota_exceeded'
  | 'upstream_rate_limited'
  // 上游
  | 'no_upstream'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'upstream_credential_missing'
  | 'upstream_unavailable'
  | 'upstream_model_unsupported'
  | 'bad_upstream'
  // 计费
  | 'preauth_failed'
  | 'billing_failed'
  | 'billing_compensation_pending'
  // 其它
  | 'not_implemented'
  | 'invalid_upstream'
  | 'internal_error';

export interface GatewayErrorShape {
  message: string;
  type: GatewayErrorType;
  code: GatewayErrorCode | string;
  param?: string | null;
}

/** 可直接抛出的网关错误：带 HTTP 状态与稳定 code。 */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode | string;
  readonly type: GatewayErrorType;
  readonly param: string | null;
  /** 上游返回的 Retry-After（秒），透传给客户端。 */
  readonly retryAfterSeconds: number | null;
  /** 是否可重试（供内部 loop 判定；不影响客户端响应）。 */
  readonly retryable: boolean;

  constructor(
    status: number,
    code: GatewayErrorCode | string,
    message: string,
    options: {
      type?: GatewayErrorType;
      param?: string | null;
      retryAfterSeconds?: number | null;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.type = options.type ?? defaultTypeFor(status);
    this.param = options.param ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.retryable = options.retryable ?? (status === 429 || status === 408 || status >= 500);
  }
}

/** 由 HTTP 状态推导 OpenAI 错误 `type`。 */
export function defaultTypeFor(status: number): GatewayErrorType {
  if (status === 400 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 405) return 'method_not_allowed';
  if (status === 408) return 'timeout_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'api_error';
}

/** 组装 OpenAI 错误响应体。 */
export function errorBody(
  shape: GatewayErrorShape,
  status: number,
): {
  error: { message: string; type: string; code: string; param: string | null; status: number };
} {
  return {
    error: {
      message: shape.message,
      type: shape.type,
      code: String(shape.code),
      param: shape.param ?? null,
      status,
    },
  };
}

/** 把任意异常归一成 `GatewayError`（未知异常按 500 处理，不泄漏内部细节）。 */
export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayError(500, 'internal_error', `网关内部错误：${redactSecrets(message)}`);
}

/**
 * 写出错误响应。已发送响应头（流式已经开始）时只能结束连接，不能再改状态码 ——
 * 此时保持 OpenAI 的 `[DONE]`/SSE 语义由调用方负责，这里只保证不抛。
 */
export function sendGatewayError(reply: RawHttpReply, error: unknown): void {
  const gw = toGatewayError(error);
  const headersSent = (reply.raw as { headersSent?: boolean } | undefined)?.headersSent === true;
  if (headersSent) {
    reply.end();
    return;
  }
  reply.status(gw.status);
  reply.header('content-type', 'application/json; charset=utf-8');
  if (gw.retryAfterSeconds !== null) {
    reply.header('retry-after', String(Math.max(1, Math.ceil(gw.retryAfterSeconds))));
  }
  reply.end(
    JSON.stringify(
      errorBody({ message: gw.message, type: gw.type, code: gw.code, param: gw.param }, gw.status),
    ),
  );
}

/** 兼容旧调用点的极简错误写出（无 type 细节时用）。 */
export function sendErrorJson(
  reply: RawHttpReply,
  status: number,
  message: string,
  code: GatewayErrorCode | string,
): void {
  reply.status(status);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.end(JSON.stringify(errorBody({ message, type: defaultTypeFor(status), code }, status)));
}

/* ------------------------------ 脱敏 ------------------------------ */

/**
 * 目标四（14）：API key 不得出现在日志、URL、异常和 usage metadata 中。
 * 这里做最后一道防线：任何要落日志/进错误消息的字符串都过一遍。
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / DeepSeek / OpenRouter / SiliconFlow 风格：sk-…、sk-or-v1-…
  /\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g,
  // Anthropic：sk-ant-…
  /\bsk-ant-[A-Za-z0-9_\-]{8,}/g,
  // Google：AIza…
  /\bAIza[A-Za-z0-9_\-]{20,}/g,
  // AWS：AKIA… / ASIA…
  /\b(AKIA|ASIA)[A-Z0-9]{12,}/g,
  // 平台自有凭证：sp_…
  /\bsp_[A-Za-z0-9_\-]{16,}/g,
  // Bearer / x-api-key 头里的任意值
  /\b(Bearer|x-api-key|x-goog-api-key)[\s:=]+[A-Za-z0-9._\-]{8,}/gi,
  // 查询串里的 key= 参数
  /([?&](?:api[-_]?key|key|access_token|token)=)[^&\s"']{6,}/gi,
  // AWS 签名里的 SecretAccessKey / Signature
  /(SecretAccessKey=)[^&\s"']+/gi,
  /(X-Amz-Signature=)[A-Fa-f0-9]+/gi,
];

/** 把疑似密钥替换成 `***`。用于日志、错误消息与 usage metadata。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => {
      // 带捕获组的规则保留前缀（如 `?api_key=`），只抹值。
      if (typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix)) {
        return `${prefix}***`;
      }
      const head = match.slice(0, 3);
      return /\b(sk|rk|pk)-/.test(match) || /^(AKIA|ASIA)/.test(match) ? `${head}-***` : '***';
    });
  }
  return out;
}

/** 递归脱敏任意 JSON 值（用于 usage metadata / 审计 meta）。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(authorization|api[-_]?key|x-api-key|x-goog-api-key|access_token|secret)$/i.test(key)) {
        out[key] = '***';
        continue;
      }
      out[key] = redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}
