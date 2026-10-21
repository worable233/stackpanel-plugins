import {
  asArray,
  asNumber,
  asString,
  isRecord,
  parseToolArguments,
  safeJsonStringify,
  textOf,
  totalOf,
  ZERO_USAGE,
  type IRMessage,
  type IRPart,
  type IRStopReason,
  type IRStreamEvent,
  type IRTool,
  type IRToolChoice,
  type IRUsage,
} from '../protocol.js';
import { SseParser, type ProtocolCodec, type StreamDecoder, type StreamEncoder } from './types.js';

/** OpenAI Chat Completions 编解码。 */
export const openaiChatCodec: ProtocolCodec = {
  protocol: 'openai-chat',
  streamContentType: 'text/event-stream',

  decodeRequest(body) {
    const b = isRecord(body) ? body : {};
    const messages: IRMessage[] = [];
    for (const raw of asArray(b['messages'])) {
      if (!isRecord(raw)) continue;
      const role = asString(raw['role']) ?? 'user';
      if (role === 'system') {
        messages.push({
          role: 'system',
          parts: [{ type: 'text', text: textFromContent(raw['content']) }],
        });
        continue;
      }
      if (role === 'tool') {
        const toolCallId = asString(raw['tool_call_id']) ?? '';
        messages.push({
          role: 'tool',
          parts: [
            { type: 'tool-result', id: toolCallId, content: textFromContent(raw['content']) },
          ],
          toolCallId,
        });
        continue;
      }
      const parts: IRPart[] = [];
      const text = textFromContent(raw['content']);
      if (text) parts.push({ type: 'text', text });
      for (const image of imagesFromContent(raw['content'])) parts.push(image);
      for (const call of asArray(raw['tool_calls'])) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call['function']) ? call['function'] : {};
        parts.push({
          type: 'tool-call',
          id: asString(call['id']) ?? '',
          name: asString(fn['name']) ?? '',
          arguments: parseToolArguments(fn['arguments']),
        });
      }
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', parts });
    }

    return {
      model: asString(b['model']) ?? '',
      messages,
      tools: decodeTools(b['tools']),
      toolChoice: decodeToolChoice(b['tool_choice']),
      maxTokens: asNumber(b['max_tokens']) ?? asNumber(b['max_completion_tokens']),
      temperature: asNumber(b['temperature']),
      topP: asNumber(b['top_p']),
      stop: decodeStop(b['stop']),
      stream: b['stream'] === true,
      raw: body,
    };
  },

  encodeRequest(request) {
    const messages = request.messages.map((message) => encodeMessage(message));
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: request.stream,
    };
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.stop && request.stop.length > 0) body['stop'] = request.stop;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters,
        },
      }));
      if (request.toolChoice !== undefined)
        body['tool_choice'] = encodeToolChoice(request.toolChoice);
    }
    if (request.stream) body['stream_options'] = { include_usage: true };
    return body;
  },

  requestPath() {
    return 'v1/chat/completions';
  },

  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` };
  },

  decodeResponse(body) {
    const b = isRecord(body) ? body : {};
    const choice = asArray(b['choices']).find(isRecord);
    const message = choice && isRecord(choice['message']) ? choice['message'] : {};
    const parts: IRPart[] = [];
    const text = textFromContent(message['content']);
    if (text) parts.push({ type: 'text', text });
    for (const call of asArray(message['tool_calls'])) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call['function']) ? call['function'] : {};
      parts.push({
        type: 'tool-call',
        id: asString(call['id']) ?? '',
        name: asString(fn['name']) ?? '',
        arguments: parseToolArguments(fn['arguments']),
      });
    }
    return {
      id: asString(b['id']) ?? '',
      model: asString(b['model']) ?? '',
      parts,
      stopReason: decodeStopReason(choice ? asString(choice['finish_reason']) : undefined),
      usage: decodeUsage(b['usage']),
      raw: body,
    };
  },

  createStreamDecoder(): StreamDecoder {
    const parser = new SseParser();
    const toolIndex = new Map<number, number>();
    let started = false;
    let model = '';
    let id = '';
    let done = false;

    const toEvents = (frames: Array<{ data: string }>): IRStreamEvent[] => {
      const events: IRStreamEvent[] = [];
      for (const frame of frames) {
        if (frame.data === '[DONE]') {
          if (!done) {
            done = true;
            events.push({ type: 'stop', reason: 'stop' });
          }
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;
        if (!started) {
          started = true;
          id = asString(json['id']) ?? '';
          model = asString(json['model']) ?? '';
          events.push({ type: 'start', id, model });
        }
        const usage = json['usage'];
        if (isRecord(usage)) {
          const decoded = decodeUsage(usage);
          if (decoded.totalTokens > 0) events.push({ type: 'usage', usage: decoded });
        }
        const choice = asArray(json['choices']).find(isRecord);
        if (!choice) continue;
        const delta = isRecord(choice['delta']) ? choice['delta'] : {};
        const content = delta['content'];
        if (typeof content === 'string' && content.length > 0) {
          events.push({ type: 'text', text: content });
        }
        const reasoning = delta['reasoning_content'] ?? delta['reasoning'];
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          events.push({ type: 'thinking', text: reasoning });
        }
        for (const call of asArray(delta['tool_calls'])) {
          if (!isRecord(call)) continue;
          const idx = asNumber(call['index']) ?? 0;
          const fn = isRecord(call['function']) ? call['function'] : {};
          if (!toolIndex.has(idx)) {
            toolIndex.set(idx, idx);
            events.push({
              type: 'tool-start',
              index: idx,
              id: asString(call['id']) ?? '',
              name: asString(fn['name']) ?? '',
            });
          }
          const args = asString(fn['arguments']);
          if (args) events.push({ type: 'tool-args', index: idx, delta: args });
        }
        const reason = asString(choice['finish_reason']);
        if (reason) {
          done = true;
          events.push({ type: 'stop', reason: decodeStopReason(reason) });
        }
      }
      return events;
    };

    return {
      push: (chunk) => toEvents(parser.push(chunk)),
      end: () => toEvents(parser.end()),
    };
  },

  encodeResponse(response, model) {
    const text = textOf(response.parts);
    const toolCalls = response.parts
      .filter((part): part is Extract<IRPart, { type: 'tool-call' }> => part.type === 'tool-call')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      }));
    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text.length > 0 ? text : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: encodeStopReason(response.stopReason),
        },
      ],
      usage: encodeUsage(response.usage),
    };
  },

  createStreamEncoder(model): StreamEncoder {
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    let sentStart = false;
    let toolIndex = 0;

    const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
      frame({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

    return {
      encode(event) {
        switch (event.type) {
          case 'start': {
            sentStart = true;
            return chunk({ role: 'assistant', content: '' }, null);
          }
          case 'text':
            return chunk({ content: event.text }, null);
          case 'thinking':
            return chunk({ reasoning_content: event.text }, null);
          case 'tool-start':
            return chunk(
              {
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: event.id,
                    type: 'function',
                    function: { name: event.name, arguments: '' },
                  },
                ],
              },
              null,
            );
          case 'tool-args':
            return chunk(
              { tool_calls: [{ index: event.index, function: { arguments: event.delta } }] },
              null,
            );
          case 'usage':
            return frame({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              usage: encodeUsage(event.usage),
            });
          case 'stop':
            return chunk({}, encodeStopReason(event.reason));
        }
      },
      end() {
        if (!sentStart) sentStart = true;
        return 'data: [DONE]\n\n';
      },
    };
  },

  extractUsage(body) {
    if (!isRecord(body)) return null;
    const usage = body['usage'];
    if (
      isRecord(usage) &&
      (usage['total_tokens'] !== undefined || usage['prompt_tokens'] !== undefined)
    ) {
      return decodeUsage(usage);
    }
    return null;
  },
};

/* --------------------------------- 细节 --------------------------------- */

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
          ? part['text']
          : '',
      )
      .join('');
  }
  return '';
}

function imagesFromContent(content: unknown): IRPart[] {
  if (!Array.isArray(content)) return [];
  const parts: IRPart[] = [];
  for (const item of content) {
    if (!isRecord(item) || item['type'] !== 'image_url') continue;
    const url = isRecord(item['image_url']) ? asString(item['image_url']['url']) : undefined;
    if (!url) continue;
    if (url.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match && match[1] && match[2])
        parts.push({ type: 'image', data: match[2], mediaType: match[1] });
    } else {
      parts.push({ type: 'image', url });
    }
  }
  return parts;
}

function decodeTools(value: unknown): IRTool[] | undefined {
  const tools: IRTool[] = [];
  for (const item of asArray(value)) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item['function']) ? item['function'] : item;
    const name = asString(fn['name']);
    if (!name) continue;
    const description = asString(fn['description']);
    tools.push({
      name,
      parameters: fn['parameters'] ?? { type: 'object', properties: {} },
      ...(description !== undefined ? { description } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function decodeToolChoice(value: unknown): IRToolChoice | undefined {
  if (typeof value === 'string') {
    if (value === 'auto' || value === 'none' || value === 'required') return value;
    return undefined;
  }
  if (isRecord(value)) {
    const fn = isRecord(value['function']) ? value['function'] : {};
    const name = asString(fn['name']);
    if (name) return { name };
  }
  return undefined;
}

function encodeToolChoice(choice: IRToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function decodeStop(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}

function encodeMessage(message: IRMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    const result = message.parts.find((part) => part.type === 'tool-result');
    return {
      role: 'tool',
      tool_call_id:
        result && result.type === 'tool-result' ? result.id : (message.toolCallId ?? ''),
      content: result && result.type === 'tool-result' ? result.content : '',
    };
  }
  const content: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      const url =
        part.url ?? (part.data ? `data:${part.mediaType ?? 'image/png'};base64,${part.data}` : '');
      if (url) content.push({ type: 'image_url', image_url: { url } });
    } else if (part.type === 'tool-call') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      });
    }
  }
  const hasImage = content.some((item) => item['type'] === 'image_url');
  const body: Record<string, unknown> = { role: message.role };
  body['content'] = hasImage ? content : textOf(message.parts);
  if (toolCalls.length > 0) body['tool_calls'] = toolCalls;
  return body;
}

function decodeUsage(value: unknown): IRUsage {
  if (!isRecord(value)) return { ...ZERO_USAGE };
  const input =
    asNumber(value['prompt_tokens']) ??
    asNumber(value['input_tokens']) ??
    asNumber(value['input']) ??
    0;
  const output =
    asNumber(value['completion_tokens']) ??
    asNumber(value['output_tokens']) ??
    asNumber(value['output']) ??
    0;
  const details = isRecord(value['prompt_tokens_details']) ? value['prompt_tokens_details'] : null;
  const cached = details ? asNumber(details['cached_tokens']) : undefined;
  return {
    ...totalOf(input, output, asNumber(value['total_tokens']) ?? asNumber(value['total'])),
    ...(cached && cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function encodeUsage(usage: IRUsage): Record<string, number> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

function decodeStopReason(reason: string | undefined): IRStopReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function encodeStopReason(reason: IRStopReason): string {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** 供其它 codec 复用：把工具参数对象转字符串。 */
export { safeJsonStringify };
