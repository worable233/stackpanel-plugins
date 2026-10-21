/**
 * adaptor 通用实现。
 *
 * 绝大多数「也说 OpenAI Chat」的厂商（DeepSeek / Mistral / OpenRouter /
 * SiliconFlow / Ollama / 自定义兼容）行为完全一致，只有 baseUrl 默认值与
 * label 不同。把公共逻辑收在一个 `createAdaptor` 工厂里，厂商文件只声明差异，
 * 避免 13 份复制粘贴的请求构造代码各自漂移。
 */

import type { Protocol } from '../protocol.js';
import { GatewayError } from '../errors.js';
import {
  parseRetryAfter,
  parseUpstreamError,
  type AdaptorAccount,
  type AdaptorCapabilities,
  type AdaptorErrorInput,
  type AdaptorRequestInput,
  type ProviderAdaptor,
  type UpstreamCall,
} from './types.js';
import type { IRUsage } from '../protocol.js';

/** 大多数 adaptor 的能力基座（对话 + 流式 + 工具 + 图片）。 */
export const DEFAULT_CAPABILITIES: AdaptorCapabilities = {
  operations: [],
  streaming: true,
  websocket: false,
  customSigning: false,
  toolCalls: true,
  images: true,
  promptCache: false,
  streamUsage: true,
};

export interface AdaptorOptions {
  id: string;
  label: string;
  protocol: Protocol;
  capabilities?: Partial<AdaptorCapabilities>;
  /** 覆写鉴权头。返回空对象表示用默认 Bearer。 */
  authHeaders?: (account: AdaptorAccount) => Record<string, string>;
  /** 覆写端点构造。 */
  buildRequest?: (input: AdaptorRequestInput, fallback: UpstreamCall) => UpstreamCall;
  /** 覆写 usage 提取。返回 null 表示上游未提供。 */
  extractUsage?: (body: unknown) => IRUsage | null;
  /** 覆写错误分类。 */
  classifyError?: (input: AdaptorErrorInput) => GatewayError | null;
  /** 覆写可重试判定。 */
  isRetryable?: (error: GatewayError, status: number | null) => boolean;
  /** 厂商特有顶层字段（跨协议转换时保留）。 */
  preservedFields?: readonly string[];
}

/** 默认鉴权：`Authorization: Bearer <key>`。 */
export function bearerAuth(account: AdaptorAccount): Record<string, string> {
  return { authorization: `Bearer ${account.apiKey}` };
}

/**
 * 默认端点构造：把 codec 编码好的 body 发到 `baseUrl + subPath`。
 *
 * `joinUrl` 与旧 `gateway.ts` 里的实现同构（去重版本段，例如 baseUrl 已是
 * `…/v1` 时不重复拼 `v1/`）。刻意复制而非 import：adaptors 不应依赖旧转发器，
 * 旧的 gateway.ts 会在重构完成后删除。
 */
export function defaultBuildRequest(input: AdaptorRequestInput): UpstreamCall {
  const { account, body, subPath, query } = input;
  const url = joinUpstreamUrl(account.baseUrl, subPath, query);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const serialized = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return { url, method: 'POST', headers, body: serialized };
}

/** 拼接上游 URL，处理 baseUrl 已带版本段的情况。 */
export function joinUpstreamUrl(baseUrl: string, subPath: string, query?: URLSearchParams): string {
  const base = baseUrl.replace(/\/+$/, '');
  let rest = subPath.replace(/^\/+/, '');
  const version = /\/v\d+[a-z]*$/.exec(base);
  if (version) {
    const seg = version[0].slice(1);
    if (rest === seg) rest = '';
    else if (rest.startsWith(`${seg}/`)) rest = rest.slice(seg.length + 1);
  }
  const path = rest ? `${base}/${rest}` : base;
  const qs = query?.toString() ?? '';
  return qs ? `${path}?${qs}` : path;
}

/** 通用 usage 提取：覆盖 OpenAI（prompt_tokens）与 Anthropic（input_tokens）两种字段名。 */
export function genericExtractUsage(body: unknown): IRUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const root = body as Record<string, unknown>;
  const usage = (root['usage'] ?? root['usageMetadata']) as Record<string, unknown> | undefined;
  if (typeof usage !== 'object' || usage === null) return null;
  const num = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const input =
    num('prompt_tokens') ?? num('input_tokens') ?? num('promptTokenCount') ?? undefined;
  const output =
    num('completion_tokens') ?? num('output_tokens') ?? num('candidatesTokenCount') ?? undefined;
  const total = num('total_tokens') ?? num('totalTokenCount');
  if (input === undefined && output === undefined && total === undefined) return null;
  const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
  const outputTokens = output ?? Math.max(0, (total ?? 0) - (input ?? 0));
  const cacheRead =
    num('cache_read_input_tokens') ??
    num('prompt_tokens_details_cache_read') ??
    ((usage['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'] as
      | number
      | undefined) ??
    num('cachedContentTokenCount');
  const cacheWrite =
    num('cache_creation_input_tokens') ??
    ((usage['prompt_tokens_details'] as Record<string, unknown> | undefined)?.[
      'cache_write_tokens'
    ] as number | undefined);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    ...(typeof cacheRead === 'number' && cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/**
 * 通用错误分类。
 *
 * 关键点（目标四 9/13）：必须把上游 429 的 Retry-After 留住并透传，
 * 否则调度器的 cooldown 只能靠猜。其余状态码映射到稳定 code。
 */
export function genericClassifyError(input: AdaptorErrorInput): GatewayError {
  const parsed = parseUpstreamError(input.bodyText);
  const retryAfter = parseRetryAfter(input.headers);
  const detail = parsed.message ? `：${parsed.message}` : '';

  if (input.status === 429) {
    return new GatewayError(429, 'upstream_rate_limited', `上游限流${detail}`, {
      retryAfterSeconds: retryAfter,
      retryable: true,
    });
  }
  if (input.status === 408 || input.status === 504) {
    return new GatewayError(504, 'upstream_timeout', `上游超时${detail}`, { retryable: true });
  }
  if (input.status === 401 || input.status === 403) {
    // 上游拒绝的是网关持有的账号凭证，不是用户 key。对用户表现为 502：
    // 这是平台侧配置问题，不该让客户端以为自己的 key 无效（那会触发重试/换 key）。
    return new GatewayError(502, 'upstream_credential_missing', `上游账号凭证无效${detail}`, {
      retryable: false,
    });
  }
  if (input.status === 404) {
    return new GatewayError(502, 'upstream_model_unsupported', `上游不支持该模型或路径${detail}`, {
      retryable: false,
    });
  }
  if (input.status === 400 || input.status === 422) {
    return new GatewayError(input.status, 'upstream_error', `上游拒绝请求${detail}`, {
      retryable: false,
    });
  }
  if (input.status >= 500) {
    return new GatewayError(502, 'upstream_unavailable', `上游不可用（${input.status}）${detail}`, {
      retryAfterSeconds: retryAfter,
      retryable: true,
    });
  }
  return new GatewayError(502, 'upstream_error', `上游返回 ${input.status}${detail}`, {
    retryable: false,
  });
}

/** 通用可重试判定：429/408/5xx 可重试。 */
export function genericIsRetryable(error: GatewayError): boolean {
  return error.retryable;
}

/** 用一组选项构造一个 adaptor（未覆写的部分走通用实现）。 */
export function createAdaptor(options: AdaptorOptions): ProviderAdaptor {
  const capabilities: AdaptorCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  const auth = options.authHeaders ?? bearerAuth;
  const extract = options.extractUsage ?? genericExtractUsage;
  const classify = options.classifyError ?? genericClassifyError;
  const retryable = options.isRetryable ?? genericIsRetryable;

  return {
    id: options.id,
    label: options.label,
    protocol: options.protocol,
    capabilities,
    preservedFields: options.preservedFields ?? [],
    buildRequest(input) {
      const fallback = defaultBuildRequest(input);
      fallback.headers = { ...fallback.headers, ...auth(input.account) };
      if (!options.buildRequest) return fallback;
      const custom = options.buildRequest(input, fallback);
      // 厂商覆写后仍要保证有鉴权头（除非它显式给了别的头）。
      return { ...custom, headers: { ...auth(input.account), ...custom.headers } };
    },
    authHeaders: auth,
    extractUsage(body) {
      return extract(body) ?? genericExtractUsage(body);
    },
    classifyError(input) {
      return classify(input) ?? genericClassifyError(input);
    },
    isRetryable(error, status) {
      return retryable(error, status);
    },
  };
}
