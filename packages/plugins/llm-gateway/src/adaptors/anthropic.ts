/**
 * Anthropic 官方 adaptor 与 Bedrock 上的 Anthropic。
 *
 * Anthropic 原生：`POST /v1/messages`，`x-api-key` + `anthropic-version`，
 * usage 用 `input_tokens` / `output_tokens` + `cache_read_input_tokens` /
 * `cache_creation_input_tokens`（缓存计费是三家里最显式的）。
 *
 * AWS Bedrock 上的 Anthropic 是**同一套 body**，但整体信封不同：
 * `{ anthropic_version: 'bedrock-2023-05-31', ...body }`，路径
 * `/model/{modelId}/invoke`（非流式）或 `/model/{modelId}/invoke-with-response-stream`
 * （流式），签名必须 SigV4。这里只做信封与路径；签名由 `bedrockSign` 注入。
 */

import { createAdaptor, genericExtractUsage } from './base.js';
import type { IRUsage } from '@stackpanel/llm-protocol';
import type { AdaptorErrorInput, AdaptorAccount, ProviderAdaptor } from './types.js';
import { GatewayError } from '../errors.js';
import { parseRetryAfter, parseUpstreamError } from './types.js';

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic usage：input/output 外加缓存读写。 */
export function anthropicExtractUsage(body: unknown): IRUsage | null {
  const base = genericExtractUsage(body);
  if (!base) return null;
  // genericExtractUsage 已覆盖 cache_read_input_tokens / cache_creation_input_tokens。
  return base;
}

function anthropicClassify(input: AdaptorErrorInput): GatewayError | null {
  const parsed = parseUpstreamError(input.bodyText);
  if (input.status === 400 && /prompt is too long|too many tokens/i.test(parsed.message ?? '')) {
    return new GatewayError(400, 'invalid_request', '请求超出模型上下文长度', {
      param: 'messages',
      retryable: false,
    });
  }
  if (input.status === 529 || input.status === 503) {
    // Anthropic 的 overloaded_error 是明确的过载信号，值得立即冷却该账号。
    return new GatewayError(503, 'upstream_unavailable', '上游过载', {
      retryAfterSeconds: parseRetryAfter(input.headers),
      retryable: true,
    });
  }
  return null;
}

export const anthropicAdaptor: ProviderAdaptor = createAdaptor({
  id: 'anthropic',
  label: 'Anthropic',
  protocol: 'anthropic',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: (account) => ({
    'x-api-key': account.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }),
  extractUsage: anthropicExtractUsage,
  classifyError: anthropicClassify,
  preservedFields: ['thinking', 'metadata', 'top_k', 'stop_sequences'],
});

/** AWS SigV4 签名函数（由 bedrock 模块注入，避免 adaptor 依赖具体签名实现）。 */
export type BedrockSigner = (
  account: AdaptorAccount,
  call: { url: string; method: string; headers: Record<string, string>; body: string },
) => Promise<Record<string, string>>;

let bedrockSigner: BedrockSigner | null = null;

/** 注册 Bedrock 签名器（由 aws.ts 在加载时调用）。 */
export function registerBedrockSigner(signer: BedrockSigner): void {
  bedrockSigner = signer;
}

/**
 * Bedrock 上的 Anthropic。路径用 `modelId`；信封加 `anthropic_version`。
 *
 * 注意：签名是**异步**的，而 `buildRequest` 是同步接口。所以这里只构造未签名的
 * 调用；`signBedrockCall` 作为额外的异步步骤由转发器在发起前调用。
 */
export const bedrockAnthropicAdaptor: ProviderAdaptor = createAdaptor({
  id: 'bedrock',
  label: 'AWS Bedrock (Anthropic)',
  protocol: 'anthropic',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: true,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: () => ({}),
  buildRequest: (input) => {
    const base = input.account.baseUrl.replace(/\/+$/, '');
    const modelId = encodeURIComponent(input.ir.model);
    const suffix = input.stream ? 'invoke-with-response-stream' : 'invoke';
    const body = { anthropic_version: 'bedrock-2023-05-31', ...(input.body as object) };
    return {
      url: `${base}/model/${modelId}/${suffix}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  },
  extractUsage: anthropicExtractUsage,
  preservedFields: ['anthropic_version'],
});

/** 对 Bedrock 调用做 SigV4 签名；未注册签名器时抛明确错误而不是发未签名请求。 */
export async function signBedrockCall(
  account: AdaptorAccount,
  call: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
  },
): Promise<Record<string, string>> {
  if (!bedrockSigner) {
    throw new GatewayError(
      502,
      'upstream_credential_missing',
      'Bedrock 签名器未就绪（账号配置缺失）',
    );
  }
  return bedrockSigner(account, {
    url: call.url,
    method: call.method,
    headers: call.headers,
    body: typeof call.body === 'string' ? call.body : '',
  });
}
