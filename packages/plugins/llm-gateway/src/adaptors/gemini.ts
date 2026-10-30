/**
 * Google Gemini（AI Studio）与 Google Vertex AI。
 *
 * 两者 body 同形，差异在**端点与鉴权**：
 * - AI Studio：`/v1beta/models/{model}:generateContent`，头 `x-goog-api-key`，
 *   usage 在 `usageMetadata`（`promptTokenCount` / `candidatesTokenCount`）。
 * - Vertex：`/v1/projects/{project}/locations/{region}/publishers/google/models/{model}:generateContent`，
 *   鉴权是 OAuth2 Bearer（服务账号换 token），项目与区域来自账号 options。
 *
 * Gemini 的 usage 字段名与 OpenAI 完全不同，必须靠 adaptor 的
 * `extractUsage` 兜住；这也是「先做统一 adaptor 接口」的直接收益。
 */

import { createAdaptor } from './base.js';
import type { IRUsage } from '@stackpanel/llm-protocol';
import type {
  AdaptorAccount,
  AdaptorErrorInput,
  AdaptorRequestInput,
  ProviderAdaptor,
  UpstreamCall,
} from './types.js';
import { GatewayError } from '../errors.js';
import { parseUpstreamError } from './types.js';

/** Gemini 的 usageMetadata：promptTokenCount / candidatesTokenCount / thoughtsTokenCount。 */
export function geminiExtractUsage(body: unknown): IRUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const meta = (body as Record<string, unknown>)['usageMetadata'];
  if (typeof meta !== 'object' || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = m[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const input = num('promptTokenCount');
  const output = num('candidatesTokenCount');
  const total = num('totalTokenCount');
  if (input === undefined && output === undefined && total === undefined) return null;
  const thoughts = num('thoughtsTokenCount');
  const cached = num('cachedContentTokenCount');
  const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
  const outputTokens = output ?? Math.max(0, (total ?? 0) - (input ?? 0));
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    ...(typeof cached === 'number' && cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(typeof thoughts === 'number' && thoughts > 0 ? { reasoningTokens: thoughts } : {}),
  };
}

function geminiClassify(input: AdaptorErrorInput): GatewayError | null {
  const parsed = parseUpstreamError(input.bodyText);
  if (input.status === 400 && /API key not valid/i.test(parsed.message ?? '')) {
    return new GatewayError(502, 'upstream_credential_missing', '上游账号凭证无效', {
      retryable: false,
    });
  }
  if (input.status === 429) {
    // Gemini 免费层配额耗尽：重试无用，要熔断该账号一段时间。
    if (/quota|RESOURCE_EXHAUSTED/i.test(`${parsed.type ?? ''} ${parsed.message ?? ''}`)) {
      return new GatewayError(429, 'upstream_rate_limited', '上游配额耗尽', {
        retryable: true,
      });
    }
  }
  if (
    input.status === 403 &&
    /permission|PERMISSION_DENIED/i.test(`${parsed.type ?? ''} ${parsed.message ?? ''}`)
  ) {
    return new GatewayError(502, 'upstream_credential_missing', '上游账号无权限或已停用', {
      retryable: false,
    });
  }
  return null;
}

/** 从账号 options 读项目 / 区域（Vertex）。 */
function vertexOptions(account: AdaptorAccount): { project: string; region: string } {
  const project = typeof account.options['project'] === 'string' ? account.options['project'] : '';
  const region =
    typeof account.options['region'] === 'string' && account.options['region'].length > 0
      ? account.options['region']
      : 'us-central1';
  return { project, region };
}

export const geminiAdaptor: ProviderAdaptor = createAdaptor({
  id: 'gemini',
  label: 'Google Gemini',
  protocol: 'gemini',
  capabilities: {
    operations: ['embeddings'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: (account) => ({ 'x-goog-api-key': account.apiKey }),
  extractUsage: geminiExtractUsage,
  classifyError: geminiClassify,
  preservedFields: ['safetySettings', 'generationConfig', 'systemInstruction', 'tools'],
});

/**
 * Vertex AI。鉴权用 OAuth2 Bearer：账号 options 里的 `accessToken`（由管理端写入
 * 或由服务账号刷新任务更新）。项目段 `projects/{project}/locations/{region}` 必须
 * 出现在路径中。
 */
export const vertexAdaptor: ProviderAdaptor = createAdaptor({
  id: 'vertex',
  label: 'Google Vertex AI',
  protocol: 'gemini',
  capabilities: {
    operations: ['embeddings'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: (account) => {
    const token =
      typeof account.options['accessToken'] === 'string' ? account.options['accessToken'] : '';
    if (!token) {
      // 没有 token 就是配置缺失；不要静默发匿名请求（会得到 401 且难排查）。
      throw new GatewayError(502, 'upstream_credential_missing', 'Vertex 账号缺少访问令牌');
    }
    return { authorization: `Bearer ${token}` };
  },
  buildRequest: (input: AdaptorRequestInput, fallback: UpstreamCall): UpstreamCall => {
    const { project, region } = vertexOptions(input.account);
    if (!project) {
      throw new GatewayError(502, 'upstream_credential_missing', 'Vertex 账号缺少 project 配置');
    }
    const base = input.account.baseUrl.replace(/\/+$/, '');
    // codec 给出的是 `v1beta/models/{model}:{action}`；Vertex 要插 projects/locations 段，
    // 且本身已经有 `…/models/` 前缀，所以把 codec 的子路径规整成 `{model}:{action}`。
    const tail = input.subPath
      .replace(/^\/+/, '')
      .replace(/^v1beta\//, '')
      .replace(/^models\//, '');
    const query = new URLSearchParams(input.query);
    if (input.stream) query.set('alt', 'sse');
    const qs = query.toString();
    return {
      ...fallback,
      url: `${base}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${tail}${qs ? `?${qs}` : ''}`,
    };
  },
  extractUsage: geminiExtractUsage,
  classifyError: geminiClassify,
  preservedFields: ['safetySettings', 'generationConfig', 'systemInstruction'],
});

/** 供测试断言用：拼 URL 时 version 段去重的行为。 */
export function vertexUrl(
  baseUrl: string,
  subPath: string,
  project: string,
  region: string,
): string {
  const tail = subPath
    .replace(/^\/+/, '')
    .replace(/^v1beta\//, '')
    .replace(/^models\//, '');
  return `${baseUrl.replace(/\/+$/, '')}/v1/projects/${project}/locations/${region}/publishers/google/models/${tail}`;
}
