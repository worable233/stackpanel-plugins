/**
 * adaptor 注册表。
 *
 * `resolveAdaptor(provider)` 把账号行的 `provider` 字段解析成 adaptor。
 * 解析失败**不回落**到 OpenAI：账号 `provider` 写错时必须显式失败，
 * 否则一个笔误会把请求发到错误的上游并产生难以定位的账单。
 * 只有 `openai-compatible` 是刻意开放的兜底，供管理员自定义上游。
 */

import type { ProviderAdaptor } from './types.js';
import { customAdaptor, OPENAI_COMPATIBLE_ADAPTORS } from './compatible.js';
import { customRouteAdaptor } from './custom-route.js';
import { anthropicAdaptor, bedrockAnthropicAdaptor } from './anthropic.js';
import { geminiAdaptor, vertexAdaptor } from './gemini.js';
import { azureAdaptor, openaiAdaptor, openaiResponsesAdaptor } from './openai.js';
// 副作用导入：加载时向 anthropic adaptor 注册 SigV4 签名器。
import './aws.js';

const REGISTRY = new Map<string, ProviderAdaptor>();

/** 内置厂商 id 列表（账号 provider 字段的合法取值）。 */
export const BUILTIN_PROVIDERS: readonly string[] = [
  'openai',
  'openai-responses',
  'azure-openai',
  'anthropic',
  'gemini',
  'vertex',
  'bedrock',
  'deepseek',
  'mistral',
  'cohere',
  'ollama',
  'openrouter',
  'siliconflow',
  // C5：国内/边缘厂商预设
  'volcengine',
  'dashscope',
  'zhipu',
  'moonshot',
  'minimax',
  'xunfei',
  'cloudflare',
  'ai302',
  // C3：声明式自定义路由（URL 模板 + 鉴权方式，不含可执行转换器）
  'custom',
  'openai-compatible',
];

/** 注册（或覆盖）一个 adaptor。扩展点可用它注入自定义 provider。 */
export function registerAdaptor(adaptor: ProviderAdaptor): void {
  REGISTRY.set(adaptor.id, adaptor);
}

/** 已注册的全部 adaptor（管理端下拉与文档矩阵用）。 */
export function listAdaptors(): readonly ProviderAdaptor[] {
  return [...REGISTRY.values()];
}

/**
 * 解析账号 provider → adaptor。
 *
 * - 未注册的 id：返回 null（调用方给出「未知 provider」的明确错误）。
 * - 空串 / `openai-compatible` / 历史值 `openai-chat`：回落到自定义兼容 adaptor
 *   （历史数据里 provider 存的是**协议名**而非厂商名，必须继续能跑）。
 */
export function resolveAdaptor(provider: string): ProviderAdaptor | null {
  const id = provider.trim();
  if (id.length === 0 || id === 'openai-chat' || id === 'openai-compatible') {
    return customAdaptor;
  }
  return REGISTRY.get(id) ?? null;
}

/** 注册内置厂商。在插件激活时调用一次（幂等）。 */
export function registerBuiltinAdaptors(): void {
  for (const adaptor of [
    openaiAdaptor,
    openaiResponsesAdaptor,
    azureAdaptor,
    anthropicAdaptor,
    bedrockAnthropicAdaptor,
    geminiAdaptor,
    vertexAdaptor,
    customRouteAdaptor,
    ...OPENAI_COMPATIBLE_ADAPTORS,
  ]) {
    REGISTRY.set(adaptor.id, adaptor);
  }
}

/** 该账号 provider 是否合法（管理端校验用）。 */
export function isKnownProvider(provider: string): boolean {
  return resolveAdaptor(provider) !== null;
}
