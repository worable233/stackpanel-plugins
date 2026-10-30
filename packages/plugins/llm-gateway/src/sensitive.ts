/**
 * 敏感词过滤（D2）。
 *
 * 定位很明确：**合规兜底**，不是内容审核系统。真正的审核应该交给上游的
 * moderation 端点或专门的审核插件；这里要解决的是「监管要求我们在网关层
 * 至少拦住一组明确违规词」这种硬性规定。
 *
 * 三条设计纪律：
 * 1. **在预留资金之前拦截**：命中即拒的请求不冻结、不扣费、不写用量流水。
 * 2. **词表是配置，不是正则**：只做子串匹配（`indexOf`），不让管理员写正则——
 *    正则是 ReDoS 入口，而且网关是最不该出现「一个配置让全部请求卡住」的地方。
 * 3. **不把命中内容回给用户**：错误信息只说「命中 N 条策略词」，命中详情进审计
 *    日志。把词表内容回显给调用方，等于把规避规则也一起送出去了。
 */

import type { IRMessage, IRRequest } from '@stackpanel/llm-protocol';
import { textOf } from '@stackpanel/llm-protocol';

/** 命中后的动作：`block` 拒绝，`log` 放行但留审计。 */
export type SensitiveAction = 'block' | 'log';

/** 词表与单条长度上限（防止一份配置把每次请求变成百万次比较）。 */
export const MAX_SENSITIVE_WORDS = 200;
export const MAX_SENSITIVE_WORD_LENGTH = 64;

/**
 * 归一化：NFKC（全角→半角、兼容字符折叠）+ 小写 + 去掉零宽字符。
 *
 * 不去空白：词表里带空格的词（如英文短语）必须还能匹配。
 */
export function normalizeForScan(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
}

/** 再去掉全部空白后的形态：用于拦「坏 词」「坏\n词」这类拆字规避。 */
function stripSpaces(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 拉丁词按**词边界**匹配：`ass` 不应该命中 `class`。
 *
 * 子串匹配对中文是对的（中文没有词边界，`敏感` 命中 `很敏感的内容` 正是想要
 * 的行为），但对英文是灾难：`ass` → `class`、`sex` → `sussex`。所以 ASCII 词
 * 要求左右不是字母/数字。
 */
function containsAsciiWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    const before = index === 0 ? '' : (haystack[index - 1] as string);
    const after = haystack[index + needle.length] ?? '';
    const boundary = (char: string): boolean => !/[a-z0-9]/.test(char);
    if (boundary(before) && boundary(after)) return true;
    from = index + 1;
  }
}

/**
 * 在文本中扫描词表，返回命中的词（去重、按长度降序便于阅读）。
 *
 * 匹配规则按词的内容分两类：
 * - **含拉丁字母**：按词边界匹配（`class` 不算命中 `ass`），不做去空白匹配。
 * - **纯 CJK / 其它**：子串匹配，并额外用「去掉空白」的形态兜住
 *   「敏 感 词」这类拆字规避（中文没有词边界，这是它真正需要的能力）。
 */
export function scanText(text: string, words: readonly string[]): string[] {
  if (!text || words.length === 0) return [];
  const normalized = normalizeForScan(text);
  const compact = stripSpaces(normalized);
  const hits: string[] = [];
  for (const word of words) {
    const needle = normalizeForScan(word);
    if (needle === '') continue;
    const compactNeedle = stripSpaces(needle);
    const hasAscii = /[a-z]/.test(compactNeedle);
    if (hasAscii) {
      if (containsAsciiWord(normalized, needle)) hits.push(word);
      continue;
    }
    if (normalized.includes(needle) || (compactNeedle !== '' && compact.includes(compactNeedle))) {
      hits.push(word);
    }
  }
  return [...new Set(hits)].sort((a, b) => b.length - a.length);
}

/** 拼接一次请求里「用户可写的文本」：system + 所有消息的 text 片段。 */
export function requestText(ir: Pick<IRRequest, 'messages' | 'system'>): string {
  const chunks: string[] = [];
  if (ir.system) chunks.push(ir.system);
  for (const message of ir.messages as IRMessage[]) {
    const text = textOf(message.parts);
    if (text) chunks.push(text);
  }
  return chunks.join('\n');
}

export interface SensitiveScanResult {
  /** 命中的词（原样，未归一化）。 */
  hits: string[];
  /** 扫描覆盖的字符数（用于审计「扫了多大的请求」）。 */
  scannedChars: number;
}

/** 扫描一次 IR 请求。词表为空时返回 null（调用方据此跳过整段逻辑）。 */
export function scanRequest(
  ir: Pick<IRRequest, 'messages' | 'system'>,
  words: readonly string[],
): SensitiveScanResult | null {
  if (words.length === 0) return null;
  const text = requestText(ir);
  const hits = scanText(text, words);
  return { hits, scannedChars: text.length };
}

/**
 * 归一化管理员提交的词表：去空白项、去重、截断超长项并限制条数。
 *
 * 超限**不报错而是截断**：词表是运维随时会调的东西，因为第 201 个词让整份
 * 配置存不进去，比丢掉一个词更糟。被丢弃的项会在管理端返回里可见。
 */
export function normalizeWordlist(raw: readonly unknown[]): {
  words: string[];
  dropped: number;
} {
  const words: string[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (typeof item !== 'string') {
      dropped += 1;
      continue;
    }
    const word = item.trim();
    if (word === '' || word.length > MAX_SENSITIVE_WORD_LENGTH) {
      dropped += 1;
      continue;
    }
    if (words.includes(word)) continue;
    if (words.length >= MAX_SENSITIVE_WORDS) {
      dropped += 1;
      continue;
    }
    words.push(word);
  }
  return { words, dropped };
}
