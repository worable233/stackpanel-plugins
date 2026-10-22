/**
 * 协议中立中间表示（IR）。
 *
 * 所有入口协议先 decode 成 IR，再 encode 成上游协议；上游响应反过来走一遍。
 * 目前覆盖：文本、多模态图片、工具调用、思考块、用量。
 */

export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

export const PROTOCOLS: readonly Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
];

export function isProtocol(value: unknown): value is Protocol {
  return typeof value === 'string' && (PROTOCOLS as readonly string[]).includes(value);
}

/** 人类可读的协议名（用于错误信息 / 管理端展示）。 */
export function protocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case 'openai-chat':
      return 'OpenAI Chat Completions';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'anthropic':
      return 'Anthropic Messages';
    case 'gemini':
      return 'Google Gemini';
  }
}

export type IRPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; data?: string; mediaType?: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; id: string; content: string; isError?: boolean }
  | { type: 'thinking'; text: string; signature?: string };

export type IRRole = 'system' | 'user' | 'assistant' | 'tool';

export interface IRMessage {
  role: IRRole;
  parts: IRPart[];
  /** role='tool' 时对应的工具调用 id；assistant 多轮时也可带。 */
  toolCallId?: string | undefined;
  /** role='tool' 时的工具名。 */
  name?: string | undefined;
}

export interface IRTool {
  name: string;
  description?: string | undefined;
  /** JSON Schema。 */
  parameters: unknown;
}

export type IRToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface IRRequest {
  model: string;
  messages: IRMessage[];
  /** Anthropic / Gemini 顶层 system 指令（已从 messages 抽出）。 */
  system?: string | undefined;
  tools?: IRTool[] | undefined;
  toolChoice?: IRToolChoice | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string[] | undefined;
  stream: boolean;
  /** 原样请求体，用于同协议直通与未识别字段的兜底。 */
  raw: unknown;
}

export interface IRUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * 缓存读 / 写 token 数。是 `inputTokens` 的**子集**（`inputTokens` 仍=全部输入，
   * 含缓存），仅用于计费拆分（缓存读通常更便宜、缓存写更贵）。
   * 上游未返回时为 0。
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export const ZERO_USAGE: IRUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function totalOf(input: number, output: number, total?: number): IRUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total && total > 0 ? total : input + output,
  };
}

export interface IRResponse {
  id: string;
  model: string;
  parts: IRPart[];
  stopReason: IRStopReason;
  usage: IRUsage;
  raw: unknown;
}

/** 流式增量：文本 / 思考 / 工具调用片段。 */
export type IRStreamEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-start'; index: number; id: string; name: string }
  | { type: 'tool-args'; index: number; delta: string }
  | { type: 'stop'; reason: IRStopReason }
  | { type: 'usage'; usage: IRUsage };

export type IRStopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

/* ------------------------------ 通用小工具 ------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function textOf(parts: IRPart[]): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** JSON.stringify，失败时回退为空对象字面量。 */
export function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

/** 解析工具参数（可能是 object 或 JSON 字符串）。 */
export function parseToolArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  return safeJsonStringify(value ?? {});
}
