import { describe, expect, it } from 'vitest';
import {
  MAX_SENSITIVE_WORDS,
  MAX_SENSITIVE_WORD_LENGTH,
  normalizeForScan,
  normalizeWordlist,
  requestText,
  scanRequest,
  scanText,
} from './sensitive.js';
import type { IRMessage } from '@stackpanel/llm-protocol';

describe('normalizeForScan', () => {
  it('全角转半角、小写、去零宽字符', () => {
    expect(normalizeForScan('ＶＩＰ')).toBe('vip');
    expect(normalizeForScan('A\u200bB')).toBe('ab');
    // 空白保留（带空格的英文短语还能命中）
    expect(normalizeForScan('Bad Word')).toBe('bad word');
  });
});

describe('scanText', () => {
  it('大小写与全角都不影响命中', () => {
    expect(scanText('this is SECRET stuff', ['secret'])).toEqual(['secret']);
    expect(scanText('这是ＳＥＣＲＥＴ', ['secret'])).toEqual(['secret']);
  });

  it('拦得住拆字规避（中间插入空白）', () => {
    expect(scanText('敏 感 词 在 这', ['敏感词'])).toEqual(['敏感词']);
  });

  it('拉丁词按词边界匹配，不做去空白匹配', () => {
    // 「ass」不该命中「class」，「ab」不该命中「a bc」。
    expect(scanText('class is over', ['ass'])).toEqual([]);
    expect(scanText('a bc', ['ab'])).toEqual([]);
    // 词边界上的命中要成立（含标点分隔与大小写）。
    expect(scanText('he is an Ass.', ['ass'])).toEqual(['ass']);
    expect(scanText('ass', ['ass'])).toEqual(['ass']);
  });

  it('中文按子串匹配（没有词边界概念）', () => {
    expect(scanText('这里有一段很敏感的内容', ['敏感'])).toEqual(['敏感']);
  });

  it('去重并按长度降序返回', () => {
    expect(scanText('badword 与 bad', ['bad', 'badword', 'badword'])).toEqual(['badword', 'bad']);
  });

  it('空文本 / 空词表不产生命中', () => {
    expect(scanText('', ['x'])).toEqual([]);
    expect(scanText('abc', [])).toEqual([]);
    expect(scanText('abc', ['   '])).toEqual([]);
  });
});

describe('requestText / scanRequest', () => {
  const messages: IRMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: '' }] },
    {
      role: 'user',
      parts: [
        { type: 'text', text: '请帮我' },
        { type: 'image', url: 'https://example.com/a.png' },
        { type: 'text', text: '写一段敏感文案' },
      ],
    },
  ];

  it('只拼文本片段，忽略图片', () => {
    const text = requestText({ messages, system: '系统提示' });
    expect(text).toContain('系统提示');
    expect(text).toContain('写一段敏感文案');
    expect(text).not.toContain('example.com');
  });

  it('词表为空时返回 null（调用方据此跳过整段逻辑）', () => {
    expect(scanRequest({ messages }, [])).toBeNull();
  });

  it('返回命中词与扫描字符数', () => {
    const result = scanRequest({ messages }, ['敏感']);
    expect(result?.hits).toEqual(['敏感']);
    expect(result?.scannedChars).toBeGreaterThan(0);
  });
});

describe('normalizeWordlist', () => {
  it('去空白项、去重、计数被丢弃的项', () => {
    // 重复项静默去重（不算「被丢弃」），空白项与非字符串才算。
    const result = normalizeWordlist([' 法轮功 ', '法轮功', '', 42, 'x']);
    expect(result.words).toEqual(['法轮功', 'x']);
    expect(result.dropped).toBe(2);
  });

  it('超长词被丢弃而不是整份失败', () => {
    const long = 'a'.repeat(MAX_SENSITIVE_WORD_LENGTH + 1);
    const result = normalizeWordlist([long, 'ok']);
    expect(result.words).toEqual(['ok']);
    expect(result.dropped).toBe(1);
  });

  it('超过上限后截断并计数', () => {
    const raw = Array.from({ length: MAX_SENSITIVE_WORDS + 5 }, (_unused, index) => `w${index}`);
    const result = normalizeWordlist(raw);
    expect(result.words).toHaveLength(MAX_SENSITIVE_WORDS);
    expect(result.dropped).toBe(5);
  });
});
