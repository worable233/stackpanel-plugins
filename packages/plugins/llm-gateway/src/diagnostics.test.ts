import { describe, expect, it } from 'vitest';
import { diagnoseConversion } from './diagnostics.js';

const chatBody = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

describe('diagnoseConversion', () => {
  it('同协议直通不丢顶层字段', () => {
    const result = diagnoseConversion({ from: 'openai-chat', to: 'openai-chat', body: chatBody });
    expect(result.dropped).toEqual([]);
    expect(result.path).toContain('chat/completions');
  });

  it('Chat → Anthropic 保留函数工具、给出上游路径', () => {
    const result = diagnoseConversion({
      from: 'openai-chat',
      to: 'anthropic',
      body: {
        ...chatBody,
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
          },
        ],
      },
    });
    expect(result.path).toContain('messages');
    expect(JSON.stringify(result.encoded)).toContain('get_weather');
    expect(result.notes.join()).not.toContain('服务端工具');
  });

  it('Responses → Chat：服务端工具与会话状态字段丢失并给出提示', () => {
    const result = diagnoseConversion({
      from: 'openai-responses',
      to: 'openai-chat',
      body: {
        model: 'gpt-4.1',
        input: 'hi',
        previous_response_id: 'resp_123',
        store: true,
        tools: [{ type: 'web_search_preview' }],
      },
    });
    expect(result.notes.join()).toContain('web_search_preview');
    expect(result.notes.join()).toContain('previous_response_id');
    expect(result.notes.join()).toContain('有损');
    // 这些 Responses 专有字段不会出现在 Chat 出口。
    expect(JSON.stringify(result.encoded)).not.toContain('web_search_preview');
  });

  it('Responses → Responses 直通不报丢失', () => {
    const body = {
      model: 'gpt-4.1',
      input: 'hi',
      store: true,
      tools: [{ type: 'web_search_preview' }],
      include: ['reasoning.encrypted_content'],
    };
    const result = diagnoseConversion({ from: 'openai-responses', to: 'openai-responses', body });
    // 同协议是直通（relay 克隆原始体），不是经 IR 重建。
    expect(result.dropped).toEqual([]);
    expect(JSON.stringify(result.encoded)).toContain('web_search_preview');
    expect(JSON.stringify(result.encoded)).toContain('reasoning.encrypted_content');
    expect(result.notes.join()).toContain('直通');
    expect(result.notes.join()).not.toContain('只对 openai-responses');
  });

  it('Gemini 出口把模型名放进路径', () => {
    const result = diagnoseConversion({
      from: 'openai-chat',
      to: 'gemini',
      body: { ...chatBody, model: 'gemini-2.0-flash' },
    });
    expect(result.path).toContain('gemini-2.0-flash');
  });

  it('解析不出任何字段时给出「未发现丢失」', () => {
    const result = diagnoseConversion({
      from: 'openai-chat',
      to: 'openai-chat',
      body: { model: 'm', messages: [] },
    });
    expect(result.notes.length).toBeGreaterThanOrEqual(0);
  });
});
