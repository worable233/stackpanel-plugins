import { describe, expect, it } from 'vitest';
import { codecFor, matchIngress } from './index.js';
import { SseParser } from './types.js';
import {
  asString,
  parseToolArguments,
  protocolLabel,
  textOf,
  totalOf,
  ZERO_USAGE,
} from '../protocol.js';

describe('SseParser', () => {
  it('按空行分帧，跨 chunk 的残帧留到下次', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('兼容 CRLF、注释行与多行 data', () => {
    const parser = new SseParser();
    const frames = parser.push(': keep-alive\r\nevent: delta\r\ndata: one\r\ndata: two\r\n\r\n');
    expect(frames).toEqual([{ event: 'delta', data: 'one\ntwo' }]);
  });

  it('end() 冲掉没有结尾空行的最后一帧', () => {
    const parser = new SseParser();
    parser.push('data: [DONE]');
    expect(parser.end()).toEqual([{ data: '[DONE]' }]);
    expect(parser.end()).toEqual([]);
  });
});

describe('matchIngress', () => {
  const query = new URLSearchParams();

  it('识别四种入口路径', () => {
    expect(matchIngress('v1/chat/completions', query)?.protocol).toBe('openai-chat');
    expect(matchIngress('v1/responses', query)?.protocol).toBe('openai-responses');
    expect(matchIngress('v1/messages', query)?.protocol).toBe('anthropic');
    expect(matchIngress('v1beta/models/gemini-2.5-pro:streamGenerateContent', query)).toMatchObject(
      { protocol: 'gemini', geminiModel: 'gemini-2.5-pro', streaming: true },
    );
  });

  it('Gemini 的 OpenAI 兼容入口剥掉前缀后归一化', () => {
    // 客户端把 baseUrl 配成 `<网关>/v1beta/openai`，不能因此 501。
    expect(matchIngress('v1beta/openai/chat/completions', query)).toMatchObject({
      protocol: 'openai-chat',
      subPath: 'v1/chat/completions',
    });
    expect(matchIngress('v1beta/openai/models', query)?.subPath).toBe('v1/models');
    // 原生 Gemini 路径不受影响。
    expect(matchIngress('v1beta/models/gemini-2.0:generateContent', query)?.protocol).toBe(
      'gemini',
    );
  });

  it('未知路径按 OpenAI Chat 原样透传（向后兼容，不在这里拒绝）', () => {
    // 认不出来 ≠ 拒绝：是否支持由 endpoint registry 决定（未知端点返 501）。
    expect(matchIngress('v1/embeddings', query)).toMatchObject({
      protocol: 'openai-chat',
      subPath: 'v1/embeddings',
    });
    expect(matchIngress('/v1/chat/completions/', query)?.subPath).toBe('v1/chat/completions');
  });
});

describe('codecFor', () => {
  it('四种协议都取得到，且 protocol 字段自洽', () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
      expect(codecFor(protocol).protocol).toBe(protocol);
    }
  });
});

describe('openai-chat 编解码', () => {
  const codec = codecFor('openai-chat');

  it('入口请求体 → IR', () => {
    const ir = codec.decodeRequest({
      model: 'gpt-4o',
      stream: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":1}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    expect(ir.model).toBe('gpt-4o');
    expect(ir.stream).toBe(true);
    expect(ir.temperature).toBe(0.2);
    expect(ir.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(ir.messages[2]?.parts[0]).toMatchObject({ type: 'tool-call', name: 'f' });
    expect(ir.messages[3]?.toolCallId).toBe('c1');
  });

  it('IR → 上游请求体保留模型与工具', () => {
    const ir = codec.decodeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    const body = codec.encodeRequest(ir) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(Array.isArray(body['tools'])).toBe(true);
  });

  it('上游响应 → IR 时映射用量与结束原因', () => {
    const response = codec.decodeResponse({
      id: 'r1',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 5, totalTokens: 8 });
    expect(response.stopReason).toBe('stop');
    expect(response.parts[0]).toMatchObject({ type: 'text', text: 'yo' });
  });
});

describe('anthropic / gemini 的方言差异', () => {
  it('Anthropic 顶层 system 抽到 IR 的 system 字段（不占一条 message）', () => {
    const ir = codecFor('anthropic').decodeRequest({
      model: 'claude-x',
      system: 'be nice',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(ir.system).toBe('be nice');
    expect(ir.messages).toHaveLength(1);
    expect(textOf(ir.messages[0]?.parts ?? [])).toBe('hi');
  });

  it('Anthropic 的 content 允许是纯字符串（不能解析成空 parts）', () => {
    // 回归：`asArray('字符串')` 返回空数组，曾导致 content 为字符串的消息
    // 变成 `parts: []`，转给 responses 上游后报「消息内容为空」。
    const ir = codecFor('anthropic').decodeRequest({
      model: 'claude-x',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(ir.messages[0]?.parts).toEqual([{ type: 'text', text: '你好' }]);
    expect(codecFor('openai-responses').encodeRequest(ir)).toMatchObject({
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
    });
  });

  it('Gemini 把模型名与流式动作编进路径', () => {
    const codec = codecFor('gemini');
    const ir = codec.decodeRequest({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(ir.messages.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'hi' });
    expect(codec.requestPath({ ...ir, model: 'gemini-2.5-pro' }, true)).toBe(
      'v1beta/models/gemini-2.5-pro:streamGenerateContent',
    );
    expect(codec.authHeaders('k')).toEqual({ 'x-goog-api-key': 'k' });
  });
});

describe('协议中立助手', () => {
  it('textOf 只取文本片段', () => {
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'image', url: 'u' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('parseToolArguments 原样保留字符串、把对象序列化', () => {
    // 字符串一律原样返回：上游可能给的是「已经损坏的 JSON」，这里不做猜测性修复。
    expect(parseToolArguments('{"a":1}')).toBe('{"a":1}');
    expect(parseToolArguments('')).toBe('');
    expect(parseToolArguments('{oops')).toBe('{oops');
    expect(parseToolArguments({ a: 1 })).toBe('{"a":1}');
    expect(parseToolArguments(undefined)).toBe('{}');
  });

  it('totalOf 缺 total 时自行相加', () => {
    expect(totalOf(2, 3)).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(totalOf(2, 3, 99).totalTokens).toBe(99);
    expect(ZERO_USAGE.totalTokens).toBe(0);
  });

  it('protocolLabel 与 asString 的边界', () => {
    expect(protocolLabel('gemini')).toContain('Gemini');
    expect(asString(1)).toBeUndefined();
    expect(asString('x')).toBe('x');
  });
});
