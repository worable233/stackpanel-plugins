/**
 * OpenAI-compatible 厂商家族。
 *
 * 这些厂商说的是 OpenAI Chat 方言，但各有必须处理的差异：
 * - **DeepSeek**：`reasoning_content` 字段（不是 `reasoning`）、cache 命中走
 *   `prompt_cache_hit_tokens`；错误体是 OpenAI 形状但欠费码不同。
 * - **Mistral**：路径是 `/v1/chat/completions`（同 OpenAI），但**不支持**
 *   `stream_options`；工具调用字段名一致。
 * - **Cohere**：有 OpenAI 兼容层（`/compatibility/v1`），但原生 rerank 在
 *   `/v2/rerank`；这是我们 rerank operation 的落地厂商。
 * - **Ollama**：本地推理，baseUrl 通常是 `http://127.0.0.1:11434/v1`，
 *   无鉴权（apiKey 可为占位），无 batch/files。
 * - **OpenRouter**：`HTTP-Referer`/`X-Title` 头用于排行，`provider` 顶层字段
 *   控制路由偏好，必须保留。
 * - **SiliconFlow**：OpenAI 形状，rerank 在 `/v1/rerank`。
 *
 * 设计取向：**默认走通用实现**，只在有真实差异的地方覆写。这样新增一个
 * 「也说 OpenAI Chat」的厂商是加十来行而不是两百行。
 */

import { createAdaptor, genericExtractUsage } from './base.js';
import type { IRUsage } from '@stackpanel/llm-protocol';
import type { AdaptorErrorInput, ProviderAdaptor } from './types.js';
import { GatewayError } from '../errors.js';
import { parseUpstreamError } from './types.js';

/* ------------------------------ OpenAI 兼容家族 ------------------------------ */

/** 组合：通用分类 → 各家特殊码。 */
function deepseekClassify(input: AdaptorErrorInput): GatewayError | null {
  const parsed = parseUpstreamError(input.bodyText);
  if (input.status === 402 || /insufficient|balance/i.test(`${parsed.code ?? ''}`)) {
    return new GatewayError(429, 'insufficient_quota', '上游账号余额不足', { retryable: false });
  }
  return null;
}

/** DeepSeek 的缓存命中字段是 `prompt_cache_hit_tokens`（不在 prompt_tokens_details 下）。 */
function deepseekExtractUsage(body: unknown): IRUsage | null {
  const base = genericExtractUsage(body);
  if (!base) return null;
  if (typeof body !== 'object' || body === null) return base;
  const usage = (body as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null) return base;
  const cacheHit = (usage as Record<string, unknown>)['prompt_cache_hit_tokens'];
  if (typeof cacheHit !== 'number' || cacheHit <= 0) return base;
  return { ...base, cacheReadTokens: cacheHit };
}

export const deepseekAdaptor: ProviderAdaptor = createAdaptor({
  id: 'deepseek',
  label: 'DeepSeek',
  protocol: 'openai-chat',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: true,
  },
  extractUsage: deepseekExtractUsage,
  classifyError: deepseekClassify,
  preservedFields: ['reasoning_effort', 'top_p', 'frequency_penalty'],
});

export const mistralAdaptor: ProviderAdaptor = createAdaptor({
  id: 'mistral',
  label: 'Mistral',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'moderations'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: false,
    // Mistral 会对未知的 stream_options 报 400。
    streamUsage: false,
  },
  // Mistral 会对未知的 stream_options 报 400；转发器按能力位跳过注入。
  preservedFields: ['safe_prompt', 'random_seed', 'response_format'],
});

/** Cohere：OpenAI 兼容层 + 原生 rerank（`/v2/rerank`）。 */
export const cohereAdaptor: ProviderAdaptor = createAdaptor({
  id: 'cohere',
  label: 'Cohere',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'rerank'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: false,
  },
  authHeaders: (account) => ({ authorization: `Bearer ${account.apiKey}` }),
  preservedFields: ['documents', 'connectors', 'citation_quality'],
});

/** Ollama：本地部署，通常无鉴权。 */
export const ollamaAdaptor: ProviderAdaptor = createAdaptor({
  id: 'ollama',
  label: 'Ollama',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: false,
  },
  // 本地 Ollama 不校验 key；有配置时仍带上（兼容带反向代理鉴权的部署）。
  authHeaders: (account) => (account.apiKey ? { authorization: `Bearer ${account.apiKey}` } : {}),
  preservedFields: ['options', 'keep_alive'],
});

/** OpenRouter：路由偏好字段必须保留，否则用户的 provider 约束会失效。 */
export const openrouterAdaptor: ProviderAdaptor = createAdaptor({
  id: 'openrouter',
  label: 'OpenRouter',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['images.generations'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  authHeaders: (account) => {
    const headers: Record<string, string> = { authorization: `Bearer ${account.apiKey}` };
    // OpenRouter 用它做应用排行；缺失不影响功能，但带上更合规。
    const referer =
      typeof account.options['httpReferer'] === 'string' ? account.options['httpReferer'] : '';
    if (referer) headers['http-referer'] = referer;
    const title = typeof account.options['xTitle'] === 'string' ? account.options['xTitle'] : '';
    headers['x-title'] = title || 'StackPanel';
    return headers;
  },
  preservedFields: ['provider', 'transforms', 'route', 'models', 'usage'],
});

/** SiliconFlow：OpenAI 形状 + `/v1/rerank`。 */
export const siliconflowAdaptor: ProviderAdaptor = createAdaptor({
  id: 'siliconflow',
  label: 'SiliconFlow',
  protocol: 'openai-chat',
  capabilities: {
    operations: [
      'embeddings',
      'images.generations',
      'audio.speech',
      'audio.transcriptions',
      'rerank',
    ],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: false,
  },
  preservedFields: ['enable_thinking', 'thinking_budget'],
});

/**
 * 自定义 OpenAI-compatible provider：管理员自己填 baseUrl，行为完全按 OpenAI。
 * 它是「兜底」——不在已知厂商列表里的上游都用这个 id。
 */
export const customAdaptor: ProviderAdaptor = createAdaptor({
  id: 'openai-compatible',
  label: 'OpenAI 兼容（自定义）',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'images.generations', 'moderations', 'rerank'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  preservedFields: [],
});

/* ------------------------------ C5：国内/边缘厂商预设 ------------------------------ */

/**
 * 火山方舟（Volcengine Ark）：`/api/v3`，模型 id 形如 `doubao-seed-1-6-...`。
 * 推理开关字段名是 `thinking`（不是 OpenAI 的 `reasoning_effort`），必须保留。
 */
export const volcengineAdaptor: ProviderAdaptor = createAdaptor({
  id: 'volcengine',
  label: '火山方舟（豆包）',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'images.generations'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  preservedFields: ['thinking', 'caching', 'seed'],
});

/**
 * 阿里云百炼（DashScope 兼容模式）：`/compatible-mode/v1`。
 * Qwen 系列用 `enable_thinking` 开关思考，`prompt_tokens_details.cached_tokens` 报命中。
 */
export const dashscopeAdaptor: ProviderAdaptor = createAdaptor({
  id: 'dashscope',
  label: '阿里云百炼（通义）',
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
  preservedFields: ['enable_thinking', 'thinking_budget', 'vl_high_resolution_images'],
});

/** 智谱 GLM：OpenAI 兼容，`thinking` 开关；embedding 是 `embedding-3`。 */
export const zhipuAdaptor: ProviderAdaptor = createAdaptor({
  id: 'zhipu',
  label: '智谱 GLM',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'images.generations'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: false,
  },
  preservedFields: ['thinking', 'request_id'],
});

/** Moonshot（Kimi）：`/v1`，长上下文；思考模型用 `thinking` 字段。 */
export const moonshotAdaptor: ProviderAdaptor = createAdaptor({
  id: 'moonshot',
  label: 'Moonshot（Kimi）',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: true,
  },
  preservedFields: ['thinking', 'partial'],
});

/** MiniMax：`/v1`，语音/音乐是它真正的差异点。 */
export const minimaxAdaptor: ProviderAdaptor = createAdaptor({
  id: 'minimax',
  label: 'MiniMax',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['audio.speech', 'images.generations'],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: false,
  },
  preservedFields: ['enable_thinking', 'audio_setting', 'voice_setting'],
});

/**
 * 讯飞星火（Spark）：HTTP 兼容端点是 `/v1`，鉴权仍是 Bearer。
 * 它**没有** embeddings / images，声明能力位可以避免策略把请求路由过来。
 */
export const xunfeiAdaptor: ProviderAdaptor = createAdaptor({
  id: 'xunfei',
  label: '讯飞星火',
  protocol: 'openai-chat',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: false,
  },
  preservedFields: ['search_disable', 'domain'],
});

/**
 * Cloudflare Workers AI：baseUrl 形如
 * `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`。
 * 账户 id 必须写进 baseUrl（适配器不解析它）。
 */
export const cloudflareAdaptor: ProviderAdaptor = createAdaptor({
  id: 'cloudflare',
  label: 'Cloudflare Workers AI',
  protocol: 'openai-chat',
  capabilities: {
    operations: ['embeddings', 'images.generations'],
    streaming: false,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: false,
    // Workers AI 的 stream 与 usage 结构不稳定：不注入 stream_options。
    streamUsage: false,
  },
  preservedFields: [],
});

/** 302.AI：聚合网关，能力最宽（含 rerank / 语音 / 图像）。 */
export const ai302Adaptor: ProviderAdaptor = createAdaptor({
  id: 'ai302',
  label: '302.AI',
  protocol: 'openai-chat',
  capabilities: {
    operations: [
      'embeddings',
      'images.generations',
      'audio.speech',
      'audio.transcriptions',
      'moderations',
      'rerank',
    ],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: true,
    promptCache: true,
  },
  preservedFields: [],
});

/**
 * 所有「也说 OpenAI Chat」的 adaptor。`resolveAdaptor` 在 id 未命中时
 * 会把 `<custom>` 或未知 id 回落到 `customAdaptor`。
 */
export const OPENAI_COMPATIBLE_ADAPTORS: readonly ProviderAdaptor[] = [
  deepseekAdaptor,
  mistralAdaptor,
  cohereAdaptor,
  ollamaAdaptor,
  openrouterAdaptor,
  siliconflowAdaptor,
  volcengineAdaptor,
  dashscopeAdaptor,
  zhipuAdaptor,
  moonshotAdaptor,
  minimaxAdaptor,
  xunfeiAdaptor,
  cloudflareAdaptor,
  ai302Adaptor,
  customAdaptor,
];
