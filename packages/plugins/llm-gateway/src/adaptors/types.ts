/**
 * Provider adaptor 契约。
 *
 * 目标三要求「先实现统一 adaptor 接口，再实现各个 provider」。本仓库已有的
 * `ProtocolCodec`（`codecs/types.ts`）解决的是**线协议**问题：一段 JSON 是
 * OpenAI Chat 形态还是 Anthropic Messages 形态，以及两者如何互转。它**不**
 * 解决厂商问题：DeepSeek 说 OpenAI Chat，但 baseUrl、错误体、usage 字段、可重试
 * 判定都不同；Azure 说 OpenAI Chat，但路径要带 `api-version`、鉴权用 `api-key`
 * 头；Bedrock 说 Anthropic，但整体包在 `{messages, anthropic_version}` 里且用
 * SigV4 签名。
 *
 * 所以分两层，各管各的：
 *
 *   ProtocolCodec  = 方言（payload 形状）      → codecs/
 *   ProviderAdaptor = 厂商（端点/鉴权/信封/错误/重试） → adaptors/
 *
 * adaptor 通过 `protocol` 声明自己说哪种方言，内核转发时把 codec 的产物交给
 * adaptor 做最后一次「厂商化」。这样新增一个「也说 OpenAI Chat 的厂商」只需加
 * 一个 adaptor 文件，不必碰任何 codec。
 */

import type { Protocol } from '../protocol.js';
import type { IRRequest, IRResponse, IRUsage } from '../protocol.js';
import type { StreamDecoder } from '../codecs/types.js';
import type { OperationKind } from '../endpoints.js';
import type { GatewayError } from '../errors.js';

/**
 * adaptor 从账号行读到的字段。刻意做成结构化而不是直接传 `AccountRow`：
 * adaptor 只应依赖这些稳定字段，不该知道插件表的其他列（解耦 + 好测）。
 */
export interface AdaptorAccount {
  id: string;
  name: string;
  /** 上游 base URL（已通过 SSRF 校验）。 */
  baseUrl: string;
  /** 解密后的上游凭证。 */
  apiKey: string;
  /** 厂商特有配置（如 Azure 的 deployment、Vertex 的 region/project、Bedrock 的 region）。 */
  options: Readonly<Record<string, unknown>>;
}

/** 一次上游调用的完整描述。 */
export interface UpstreamCall {
  url: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

/** adaptor 声明的能力位。调度器与 endpoint registry 用它们做准入判断。 */
export interface AdaptorCapabilities {
  /** 支持的非对话 operation。 */
  operations: readonly OperationKind[];
  /** 是否支持 SSE 流式。 */
  streaming: boolean;
  /** 是否支持 WebSocket（Realtime / Responses WS）。 */
  websocket: boolean;
  /** 是否需要 SigV4 之类的复杂签名（影响能否走通用路径）。 */
  customSigning: boolean;
  /** 是否支持工具调用。 */
  toolCalls: boolean;
  /** 是否支持多模态图片输入。 */
  images: boolean;
  /** 是否支持 cache read/write 计费字段。 */
  promptCache: boolean;
  /**
   * 是否接受 OpenAI 的 `stream_options: { include_usage: true }`。
   *
   * 严格兼容层（如 Mistral）会对未知的 `stream_options` 报 400，因此**不能**
   * 只看「协议是不是 openai-chat」——Mistral 也自称 openai-chat。缺失该能力位
   * 时按 false 处理：宁可不注入（流式 usage 退化为估算），也不要让上游 400。
   */
  streamUsage: boolean;
}

/** adaptor 的静态元数据 + 行为。 */
export interface ProviderAdaptor {
  /** 稳定 id，与账号行的 `provider` 字段取值一致。 */
  readonly id: string;
  /** 人类可读名（管理端展示）。 */
  readonly label: string;
  /** 说的方言。 */
  readonly protocol: Protocol;
  /** 能力位。 */
  readonly capabilities: AdaptorCapabilities;

  /**
   * 目标三「endpoint 构造」：把 IR 请求变成一次具体的上游 HTTP 调用。
   *
   * 传入的 `codecBody` 是 ProtocolCodec 已经编码好的请求体；adaptor 只在
   * 必要时包装/补字段（Azure 的路径、Bedrock 的信封、Vertex 的项目段）。
   * 默认实现（`baseAdaptor`）直接把它发到 `codec.requestPath()`。
   */
  buildRequest(input: AdaptorRequestInput): UpstreamCall;

  /**
   * 目标三「鉴权头」。默认 Bearer；Azure 用 `api-key`；Gemini 用 `x-goog-api-key`。
   */
  authHeaders(account: AdaptorAccount): Record<string, string>;

  /** 目标三「usage 提取」。返回 null 表示上游没给，需要估算。 */
  extractUsage(body: unknown): IRUsage | null;

  /**
   * 目标三「错误分类」：把上游状态码 + 响应体变成稳定的 GatewayError。
   * 必须识别 429 的 `Retry-After`、上下文超长、内容审核拒绝等厂商特有情况。
   */
  classifyError(input: AdaptorErrorInput): GatewayError;

  /**
   * 目标三「可重试条件」。默认：429/408/5xx/网络错误可重试，4xx 其余不可。
   * 厂商可覆盖（例如某厂商 400 也代表临时过载）。
   */
  isRetryable(error: GatewayError, status: number | null): boolean;

  /**
   * 目标三「provider 特有字段保留策略」：直通时这些顶层字段必须原样带给上游
   * （例如 OpenRouter 的 `provider`、Vertex 的 `safetySettings`）。同协议直通
   * 本来就会保留未知字段；这份清单用于**跨协议转换**时把厂商字段捞回来。
   */
  readonly preservedFields: readonly string[];

  /** 目标三「SSE 转换」：厂商 SSE 方言的解码器；与 codec 默认一致时省略。 */
  createStreamDecoder?(): StreamDecoder;
}

export interface AdaptorRequestInput {
  account: AdaptorAccount;
  /** 已由 ProtocolCodec 编码的请求体（对象；adaptor 负责定稿为字符串）。 */
  body: unknown;
  /** codec 给出的相对路径。 */
  subPath: string;
  /** 入口 URL query。 */
  query: URLSearchParams;
  /** 是否流式。 */
  stream: boolean;
  /** IR 请求（adaptor 可能需要 model / tools 等）。 */
  ir: IRRequest;
}

export interface AdaptorErrorInput {
  status: number;
  /** 上游响应体（已截断），用于解析厂商错误结构。 */
  bodyText: string;
  headers: Headers;
}

/** 厂商错误体解析结果（供 classifyError 复用）。 */
export interface ParsedUpstreamError {
  message: string | null;
  type: string | null;
  code: string | null;
  /** retry-after 秒数。 */
  retryAfterSeconds: number | null;
}

/** 从上游错误体里尽力挖出 message/type/code（覆盖 OpenAI/Anthropic/Gemini 三种形状）。 */
export function parseUpstreamError(bodyText: string): ParsedUpstreamError {
  const result: ParsedUpstreamError = {
    message: null,
    type: null,
    code: null,
    retryAfterSeconds: null,
  };
  if (!bodyText) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ...result, message: bodyText.slice(0, 500) };
  }
  if (typeof parsed !== 'object' || parsed === null) return result;
  const root = parsed as Record<string, unknown>;

  // OpenAI: {error:{message,type,code}}
  const err = root['error'];
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    result.message = typeof e['message'] === 'string' ? e['message'] : null;
    result.type = typeof e['type'] === 'string' ? e['type'] : null;
    result.code = e['code'] !== undefined && e['code'] !== null ? String(e['code']) : null;
    // Gemini: {error:{code, message, status}} —— status 在 error 内层。
    if (result.type === null && typeof e['status'] === 'string') {
      result.type = e['status'];
    }
  }
  // Anthropic: {type:'error', error:{type, message}}
  // Gemini: {error:{code, message, status}}
  if (result.message === null && typeof root['message'] === 'string') {
    result.message = root['message'];
  }
  if (result.code === null && root['code'] !== undefined && root['code'] !== null) {
    result.code = String(root['code']);
  }
  if (result.type === null && typeof root['status'] === 'string') {
    result.type = root['status'];
  }
  return result;
}

/** 从 Headers 解析 `Retry-After`（秒；HTTP-date 形态按差值算）。 */
export function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return null;
}

/** 上游响应里常见但需要剥离的厂商噪声字段（避免泄漏内部信息）。 */
export function stripUpstreamNoise(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(api[-_]?key|authorization|secret|access_token)$/i.test(key)) continue;
    out[key] = item;
  }
  return out;
}

/** 从 IR 响应安全取出 usage（兜底 0）。 */
export function usageOf(response: IRResponse): IRUsage {
  return response.usage;
}
