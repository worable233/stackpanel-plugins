/**
 * OpenAI 官方 adaptor。
 *
 * 最完整的形态：工具调用、多模态、Responses、embeddings/images/audio/files/
 * batches/fine-tuning 全套，prompt caching 自动生效（`prompt_tokens_details`）。
 */

import { createAdaptor, genericExtractUsage } from './base.js';
import type { IRUsage } from '@stackpanel/llm-protocol';
import type { AdaptorErrorInput, ProviderAdaptor } from './types.js';
import { GatewayError } from '../errors.js';
import { parseUpstreamError } from './types.js';

/** OpenAI 的 usage 里有 reasoning token 与缓存明细，单独提出来。 */
export function openaiExtractUsage(body: unknown): IRUsage | null {
  const base = genericExtractUsage(body);
  if (!base) return null;
  if (typeof body !== 'object' || body === null) return base;
  const usage = (body as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null) return base;
  const details = (usage as Record<string, unknown>)['completion_tokens_details'];
  if (typeof details !== 'object' || details === null) return base;
  const reasoning = (details as Record<string, unknown>)['reasoning_tokens'];
  if (typeof reasoning !== 'number' || reasoning <= 0) return base;
  // reasoning token 已含在 outputTokens 内（OpenAI 语义），单独记一份供计费拆分。
  return { ...base, reasoningTokens: reasoning };
}

/** OpenAI 的上下文超长错误用 code 标识，需要和普通 400 区分（不可重试但要提示）。 */
function openaiClassify(input: AdaptorErrorInput): GatewayError | null {
  const parsed = parseUpstreamError(input.bodyText);
  const code = parsed.code ?? parsed.type ?? '';
  if (input.status === 400 && /context_length_exceeded|string_above_max_length/i.test(code)) {
    return new GatewayError(400, 'invalid_request', '请求超出模型上下文长度', {
      param: 'messages',
      retryable: false,
    });
  }
  if (
    input.status === 400 &&
    /content_policy_violation|content_filter/i.test(`${code} ${parsed.message ?? ''}`)
  ) {
    return new GatewayError(400, 'invalid_request', '内容被上游安全策略拒绝', {
      retryable: false,
    });
  }
  if (
    input.status === 429 &&
    /insufficient_quota|billing/i.test(`${code} ${parsed.message ?? ''}`)
  ) {
    // 账号欠费与单纯限流不同：重试无用，必须熔断该账号并告警。
    return new GatewayError(429, 'insufficient_quota', '上游账号额度耗尽', {
      retryable: false,
    });
  }
  return null;
}

export const openaiAdaptor: ProviderAdaptor = createAdaptor({
  id: 'openai',
  label: 'OpenAI',
  protocol: 'openai-chat',
  capabilities: {
    operations: [
      'embeddings',
      'images.generations',
      'images.edits',
      'audio.speech',
      'audio.transcriptions',
      'audio.translations',
      'moderations',
      'files.list',
      'files.create',
      'files.delete',
      'batches.create',
      'batches.get',
      'fine_tuning.create',
      'fine_tuning.get',
    ],
    streaming: true,
    websocket: true,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  extractUsage: openaiExtractUsage,
  classifyError: openaiClassify,
  preservedFields: [
    'service_tier',
    'store',
    'metadata',
    'user',
    'reasoning_effort',
    'parallel_tool_calls',
  ],
});

/**
 * OpenAI Responses 原生通道（C7）。
 *
 * 为什么需要单独一个 adaptor：`openai` 号是 `openai-chat` 方言，同一家上游的
 * Responses 请求会被**转换**成 chat completions——于是 `web_search_preview`
 * 这类服务端工具、`previous_response_id`、`include`、`store` 全部丢失（IR 里
 * 没有这些概念，chat 协议也表达不了）。挂这个 provider 的账号与客户端**协议相同**，
 * 走原样直通：这些字段原封不动到上游，`sequence_number` 也由上游生成。
 *
 * `streamUsage` 必须为 false：Responses 不认 chat 的 `stream_options`，
 * 注入一次就是 400。
 */
export const openaiResponsesAdaptor: ProviderAdaptor = createAdaptor({
  id: 'openai-responses',
  label: 'OpenAI Responses（原生）',
  protocol: 'openai-responses',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
    streamUsage: false,
  },
  extractUsage: openaiExtractUsage,
  classifyError: openaiClassify,
  preservedFields: [],
});

/**
 * Azure OpenAI。
 *
 * 与 OpenAI 的差异全在端点与鉴权：
 * - 路径是 `/openai/deployments/{deployment}/chat/completions`（deployment 而非 model）；
 * - `api-version` 必须出现在 query；
 * - 鉴权头是 `api-key`，不是 Bearer；
 * - deployment 名与模型名可能不同，账号 options 里带 `deployment`。
 */
export const azureAdaptor: ProviderAdaptor = createAdaptor({
  id: 'azure-openai',
  label: 'Azure OpenAI',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'images.generations', 'audio.speech', 'audio.transcriptions'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: (account) => ({ 'api-key': account.apiKey }),
  buildRequest: (input, fallback) => {
    const deployment =
      typeof input.account.options['deployment'] === 'string' &&
      input.account.options['deployment'].length > 0
        ? input.account.options['deployment']
        : input.ir.model;
    const apiVersion =
      typeof input.account.options['apiVersion'] === 'string' &&
      input.account.options['apiVersion'].length > 0
        ? input.account.options['apiVersion']
        : '2024-10-21';
    // 把 codec 的 `/v1/chat/completions` 形态改写为 Azure 的 deployment 路径。
    const tail = input.subPath
      .replace(/^\/+/, '')
      .replace(/^v1\//, '')
      .replace(/^openai\//, '');
    const base = input.account.baseUrl.replace(/\/+$/, '');
    const query = new URLSearchParams(input.query);
    query.set('api-version', apiVersion);
    return {
      ...fallback,
      method: 'POST',
      url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/${tail}?${query.toString()}`,
    };
  },
  extractUsage: openaiExtractUsage,
  preservedFields: ['data_sources', 'enhancements', 'max_tokens', 'temperature'],
});
