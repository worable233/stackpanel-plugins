/**
 * 计量（usage）模块：把上游返回的用量、或缺失时的估算，归一成稳定形态。
 *
 * 目标四（11/12）的两条硬纪律在这里落地：
 * - 上游没给 usage 时必须**估算**，并把 `estimated` 标出来；
 * - 估算**必须包含 prompt**。旧实现在流式 fallback 用 `Buffer.alloc(0)` 当请求体，
 *   把 prompt token 记成 0 —— 那是白送输入量，长 prompt 的流式请求会大面积漏计。
 *
 * 这里的估算刻意做成「口径一致」而不是「尽量准」：字符级估算是可复现的
 * （同一输入永远同一结果），所以账单可在事后复算；接入真 tokenizer 属于
 * 精度提升，不改变本模块的接口。
 */

import type { IRUsage } from './protocol.js';
import type { TokenUsage } from './pricing.js';
import { estimateTokens } from './pricing.js';

/** IR 用量 → 计费用量。 */
export function toTokenUsage(usage: IRUsage): TokenUsage {
  const total = usage.totalTokens || usage.inputTokens + usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: total,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

/** 由请求体估算 prompt token（统一入口，避免各处重复实现）。 */
export function estimatePromptTokens(body: string | Uint8Array): number {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return estimateTokens(text);
}

/**
 * 无 usage 时的估算兜底。
 *
 * @param outputText 上游输出原文（流式时是 SSE 原文，会被 stripSse 还原）
 * @param requestBodyText 请求体原文 —— **必须传**，否则 prompt 会记成 0（目标四 12）
 */
export function estimateUsage(
  outputText: string,
  requestBodyText: string,
): TokenUsage {
  const prompt = estimateTokens(requestBodyText);
  const completion = estimateTokens(stripSse(outputText));
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
  };
}

/**
 * 流式用量兜底：上游给了 usage 就用；没给就按字符估算。
 *
 * @returns usage 与是否为估算值
 */
export function resolveStreamUsage(
  usage: IRUsage | null,
  outputText: string,
  requestBodyText: string,
): { usage: TokenUsage; estimated: boolean } {
  if (usage && (usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)) {
    return { usage: toTokenUsage(usage), estimated: usage.estimated === true };
  }
  return { usage: estimateUsage(outputText, requestBodyText), estimated: true };
}

/** 从 SSE 文本里剥离 `data:` 前缀，粗略还原输出文本以估算 token。 */
export function stripSse(text: string): string {
  if (!text.includes('data:')) return text;
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
}

/**
 * 累积输出文本，带上限。
 *
 * 目标四（8）：不允许因为客户端发了个超长 prompt 就把整个响应留内存。这里
 * 只保留尾巴（足够估算 completion token 与抽取 usage），头部丢弃。上限与
 * 旧实现一致：超过 256KiB 时只留最后 128KiB。
 */
export class OutputAccumulator {
  private text = '';
  private static readonly MAX = 262_144;
  private static readonly KEEP = 131_072;

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > OutputAccumulator.MAX) {
      this.text = this.text.slice(-OutputAccumulator.KEEP);
    }
  }

  get value(): string {
    return this.text;
  }
}
