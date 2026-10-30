/**
 * 转换诊断（D4）。
 *
 * 「我明明发的是 Responses 请求，为什么 web_search 没生效？」——这类问题以前只能
 * 靠读代码或抓包。这里把「入口协议 → 目标协议」的一次转换完整跑一遍，返回
 * 编码后的请求体、**丢掉了哪些顶层字段**、以及语义级提示（服务端工具、
 * `previous_response_id` 之类跨协议表达不了的东西）。
 *
 * 纯函数，不发任何上游请求，也不接触凭证：管理端可以放心对真实请求体做体检。
 */

import type { IRUsage, Protocol } from '@stackpanel/llm-protocol';
import { codecFor } from '@stackpanel/llm-protocol';

export interface ConversionDiagnostics {
  from: Protocol;
  to: Protocol;
  /** 转换后的上游请求体。 */
  encoded: unknown;
  /** 入口有、出口没有的顶层字段（字段级丢失）。 */
  dropped: string[];
  /** 出口新加的顶层字段（如 adaptor 注入的 stream_options）。 */
  added: string[];
  /** 语义级提示：能转换但含义可能变了，或根本转换不过去。 */
  notes: string[];
  /** 转换后的上游路径（Gemini 会把模型名放进路径）。 */
  path: string;
  /** 从入口请求体能否解出 usage（通常为 null，仅作参考）。 */
  usage: IRUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/** 服务端工具（`web_search_preview` 等）不是 function 形状，IR 里没有对应概念。 */
function serverToolTypes(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  const types: string[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const type = tool['type'];
    if (typeof type === 'string' && type !== 'function') types.push(type);
  }
  return types;
}

/**
 * 跑一次「入口协议 → 目标协议」的转换并给出诊断。
 *
 * 只做请求侧：响应侧的转换在返回时才发生，且依赖真实上游返回，不适合静态诊断。
 */
export function diagnoseConversion(input: {
  from: Protocol;
  to: Protocol;
  body: unknown;
  model?: string | undefined;
}): ConversionDiagnostics {
  const { from, to } = input;
  const source = codecFor(from);
  const target = codecFor(to);
  const body = input.body;
  const notes: string[] = [];

  const ir = source.decodeRequest(body);
  if (input.model) ir.model = input.model;
  /**
   * 同协议是**直通**语义：`relay` 在同协议时直接克隆原始请求体（只覆盖 model），
   * 不经过 IR 重建——否则 Responses 的 `store`/`include`/服务端工具、Chat 的
   * 未知扩展字段都会被"转换"掉。诊断必须照抄真实链路，否则会给出错误结论。
   */
  const passthrough = from === to;
  const encoded = passthrough
    ? isRecord(body)
      ? { ...body, ...(input.model ? { model: input.model } : {}) }
      : target.encodeRequest(ir)
    : target.encodeRequest(ir);
  const path = target.requestPath(ir, ir.stream);
  if (passthrough) {
    notes.push('同协议直通：请求体原样转发（仅覆盖 model），未知字段与服务端工具都会保留。');
  }

  const sourceKeys = keysOf(body);
  const targetKeys = keysOf(encoded);
  const dropped = sourceKeys.filter((key) => !targetKeys.includes(key));
  const added = targetKeys.filter((key) => !sourceKeys.includes(key));

  const serverTools = serverToolTypes(body);
  if (serverTools.length > 0 && from !== to) {
    notes.push(
      `服务端工具（${serverTools.join(', ')}）在 IR 里没有对应表示，跨协议转换会丢弃；` +
        '需要这些能力时请让账号与客户端同协议（例如 provider = openai-responses）。',
    );
  }

  // Responses 的会话状态字段：只有 Responses 出口才表达得了。
  for (const field of ['previous_response_id', 'store', 'include', 'context_management']) {
    if (isRecord(body) && body[field] !== undefined && to !== 'openai-responses') {
      notes.push(`\`${field}\` 只对 openai-responses 出口有意义，转换到 ${to} 会被丢弃。`);
    }
  }

  if (from === 'openai-responses' && to === 'openai-chat') {
    notes.push(
      'Responses → Chat 是**有损**转换：推理项（reasoning items）、内容分块顺序、' +
        '服务端工具都会丢失；流式事件的 `sequence_number` 也不再存在。',
    );
  }
  if (from === 'openai-chat' && to === 'openai-responses') {
    notes.push('Chat → Responses 会重建 `input` 数组，`n`/`logprobs` 等 Chat 专有字段无法表达。');
  }
  if (!passthrough && dropped.length === 0 && added.length === 0 && notes.length === 0) {
    notes.push('未发现字段级丢失。');
  }

  return {
    from,
    to,
    encoded,
    dropped,
    added,
    notes,
    path,
    usage: null,
  };
}
