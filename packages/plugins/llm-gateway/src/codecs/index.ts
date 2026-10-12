import type { Protocol } from '../protocol.js';
import type { ProtocolCodec } from './types.js';
import { openaiChatCodec } from './openai-chat.js';
import { openaiResponsesCodec } from './openai-responses.js';
import { anthropicCodec } from './anthropic.js';
import { geminiCodec } from './gemini.js';

const CODECS: Record<Protocol, ProtocolCodec> = {
  'openai-chat': openaiChatCodec,
  'openai-responses': openaiResponsesCodec,
  anthropic: anthropicCodec,
  gemini: geminiCodec,
};

export function codecFor(protocol: Protocol): ProtocolCodec {
  return CODECS[protocol];
}

/** 入口请求路径 → { 协议, 上游子路径, URL query }。 */
export interface IngressMatch {
  protocol: Protocol;
  /** 相对 baseUrl 的子路径（Gemini 会把模型嵌进路径）。 */
  subPath: string;
  /** 上游直通时需要用到的 URL query（去掉 api-version 等）。 */
  query: URLSearchParams;
  /** Gemini 原生入口从路径解析出的模型名。 */
  geminiModel?: string;
  /** 入口路径显式声明了流式（Gemini 的 `:streamGenerateContent`）。 */
  streaming?: boolean;
}

const GEMINI_PATH = /^v1beta\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

/**
 * 根据入口路径判断协议。raw 路由把 `/llm-gateway/*` 的剩余路径放在 `rest`。
 *
 * 支持：
 * - `v1/chat/completions`、`chat/completions` → openai-chat
 * - `v1/responses`、`responses`、`backend-api/codex/responses` → openai-responses
 * - `v1/messages`、`messages` → anthropic
 * - `v1beta/models/{model}:generateContent|streamGenerateContent` → gemini
 * - `v1/models`、`models` → 模型发现（返回 openai-chat 形态）
 */
export function matchIngress(rest: string, query: URLSearchParams): IngressMatch | null {
  const path = rest.replace(/^\/+/, '').replace(/\/+$/, '');

  if (GEMINI_PATH.test(path)) {
    const match = GEMINI_PATH.exec(path);
    if (match && match[1]) {
      return {
        protocol: 'gemini',
        subPath: path,
        query,
        geminiModel: decodeURIComponent(match[1]),
        streaming: match[2] === 'streamGenerateContent',
      };
    }
  }

  if (/^(v1\/)?chat\/completions$/.test(path)) {
    return { protocol: 'openai-chat', subPath: 'v1/chat/completions', query };
  }
  if (/^(v1\/)?responses$/.test(path) || path === 'backend-api/codex/responses') {
    return { protocol: 'openai-responses', subPath: 'v1/responses', query };
  }
  if (/^(v1\/)?messages$/.test(path)) {
    return { protocol: 'anthropic', subPath: 'v1/messages', query };
  }
  if (/^(v1\/)?models$/.test(path)) {
    return { protocol: 'openai-chat', subPath: 'v1/models', query };
  }

  // 未知路径：按 OpenAI Chat 处理，原样透传（保持向后兼容）。
  return { protocol: 'openai-chat', subPath: path, query };
}
