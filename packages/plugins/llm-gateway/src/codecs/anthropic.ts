import {
  asArray,
  asNumber,
  asString,
  isRecord,
  parseToolArguments,
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

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic Messages 编解码。 */
export const anthropicCodec: ProtocolCodec = {
  protocol: 'anthropic',
  streamContentType: 'text/event-stream',

  decodeRequest(body) {
    const b = isRecord(body) ? body : {};
    const messages: IRMessage[] = [];
    for (const raw of asArray(b['messages'])) {
      if (!isRecord(raw)) continue;
      const role = asString(raw['role']) === 'assistant' ? 'assistant' : 'user';
      const parts: IRPart[] = [];
      for (const block of asArray(raw['content'])) {
        if (!isRecord(block)) {
          if (typeof block === 'string') parts.push({ type: 'text', text: block });
          continue;
        }
        const type = asString(block['type']);
        if (type === 'text') {
          parts.push({ type: 'text', text: asString(block['text']) ?? '' });
        } else if (type === 'image') {
          const source = isRecord(block['source']) ? block['source'] : {};
          if (asString(source['type']) === 'base64') {
            parts.push({
              type: 'image',
              data: asString(source['data']) ?? '',
              mediaType: asString(source['media_type']) ?? 'image/png',
            });
          } else {
            parts.push({ type: 'image', url: asString(source['url']) ?? '' });
          }
        } else if (type === 'tool_use') {
          parts.push({
            type: 'tool-call',
            id: asString(block['id']) ?? '',
            name: asString(block['name']) ?? '',
            arguments: parseToolArguments(block['input']),
          });
        } else if (type === 'tool_result') {
          const id = asString(block['tool_use_id']) ?? '';
          parts.push({
            type: 'tool-result',
            id,
            content: toolResultText(block['content']),
            ...(block['is_error'] === true ? { isError: true } : {}),
          });
        } else if (type === 'thinking') {
          parts.push({
            type: 'thinking',
            text: asString(block['thinking']) ?? '',
            ...(asString(block['signature']) !== undefined
              ? { signature: asString(block['signature']) as string }
              : {}),
          });
        }
      }
      messages.push({ role, parts });
    }

    const system = decodeSystem(b['system']);
    return {
      model: asString(b['model']) ?? '',
      messages,
      ...(system !== undefined ? { system } : {}),
      tools: decodeTools(b['tools']),
      toolChoice: decodeToolChoice(b['tool_choice']),
      maxTokens: asNumber(b['max_tokens']),
      temperature: asNumber(b['temperature']),
      topP: asNumber(b['top_p']),
      stop: Array.isArray(b['stop_sequences'])
        ? b['stop_sequences'].filter((item): item is string => typeof item === 'string')
        : undefined,
      stream: b['stream'] === true,
      raw: body,
    };
  },

  encodeRequest(request) {
    const messages: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      messages.push(encodeMessage(message));
    }
    // Anthropic 要求 system 在顶层：把 IR 的 system 与 messages 里的 system 合并。
    const systemText = [request.system, ...request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.parts))]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('\n\n');
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: request.stream,
    };
    if (systemText) body['system'] = systemText;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.stop && request.stop.length > 0) body['stop_sequences'] = request.stop;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.parameters,
      }));
      if (request.toolChoice !== undefined) body['tool_choice'] = encodeToolChoice(request.toolChoice);
    }
    return body;
  },

  requestPath() {
    return 'v1/messages';
  },

  authHeaders(apiKey) {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  },

  decodeResponse(body) {
    const b = isRecord(body) ? body : {};
    const parts: IRPart[] = [];
    for (const block of asArray(b['content'])) {
      if (!isRecord(block)) continue;
      const type = asString(block['type']);
      if (type === 'text') {
        parts.push({ type: 'text', text: asString(block['text']) ?? '' });
      } else if (type === 'tool_use') {
        parts.push({
          type: 'tool-call',
          id: asString(block['id']) ?? '',
          name: asString(block['name']) ?? '',
          arguments: parseToolArguments(block['input']),
        });
      } else if (type === 'thinking') {
        parts.push({ type: 'thinking', text: asString(block['thinking']) ?? '' });
      }
    }
    return {
      id: asString(b['id']) ?? '',
      model: asString(b['model']) ?? '',
      parts,
      stopReason: decodeStopReason(asString(b['stop_reason'])),
      usage: decodeUsage(b['usage']),
      raw: body,
    };
  },

  createStreamDecoder(): StreamDecoder {
    const parser = new SseParser();
    const blockType = new Map<number, 'text' | 'tool' | 'thinking'>();
    let started = false;
    let stopped = false;
    let usage: IRUsage = { ...ZERO_USAGE };

    const toEvents = (frames: Array<{ event?: string; data: string }>): IRStreamEvent[] => {
      const events: IRStreamEvent[] = [];
      for (const frame of frames) {
        if (frame.data === '[DONE]') continue;
        let json: unknown;
        try {
          json = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;
        const type = frame.event ?? asString(json['type']) ?? '';
        switch (type) {
          case 'message_start': {
            const message = isRecord(json['message']) ? json['message'] : {};
            usage = mergeUsage(usage, decodeUsage(message['usage']));
            started = true;
            events.push({
              type: 'start',
              id: asString(message['id']) ?? '',
              model: asString(message['model']) ?? '',
            });
            break;
          }
          case 'content_block_start': {
            const index = asNumber(json['index']) ?? 0;
            const block = isRecord(json['content_block']) ? json['content_block'] : {};
            const blockKind = asString(block['type']);
            if (blockKind === 'tool_use') {
              blockType.set(index, 'tool');
              events.push({
                type: 'tool-start',
                index,
                id: asString(block['id']) ?? '',
                name: asString(block['name']) ?? '',
              });
              if (isRecord(block['input']) && Object.keys(block['input']).length > 0) {
                events.push({ type: 'tool-args', index, delta: JSON.stringify(block['input']) });
              }
            } else if (blockKind === 'thinking') {
              blockType.set(index, 'thinking');
            } else {
              blockType.set(index, 'text');
              const initial = asString(block['text']);
              if (initial) events.push({ type: 'text', text: initial });
            }
            break;
          }
          case 'content_block_delta': {
            const index = asNumber(json['index']) ?? 0;
            const delta = isRecord(json['delta']) ? json['delta'] : {};
            const kind = asString(delta['type']);
            if (kind === 'text_delta') {
              const text = asString(delta['text']) ?? '';
              if (text) events.push({ type: 'text', text });
            } else if (kind === 'thinking_delta') {
              const text = asString(delta['thinking']) ?? '';
              if (text) events.push({ type: 'thinking', text });
            } else if (kind === 'input_json_delta') {
              const partial = asString(delta['partial_json']) ?? '';
              if (partial) events.push({ type: 'tool-args', index, delta: partial });
            }
            break;
          }
          case 'message_delta': {
            usage = mergeUsage(usage, decodeUsage(json['usage']));
            const delta = isRecord(json['delta']) ? json['delta'] : {};
            const reason = asString(delta['stop_reason']);
            if (reason && !stopped) {
              stopped = true;
              events.push({ type: 'stop', reason: decodeStopReason(reason) });
            }
            break;
          }
          case 'message_stop': {
            if (!stopped) {
              stopped = true;
              events.push({ type: 'stop', reason: 'stop' });
            }
            break;
          }
          case 'error': {
            stopped = true;
            events.push({ type: 'stop', reason: 'error' });
            break;
          }
          default:
            break;
        }
      }
      return events;
    };
    void started;
    return {
      push: (chunk) => toEvents(parser.push(chunk)),
      end: () => toEvents(parser.end()),
    };
  },

  encodeResponse(response, model) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of response.parts) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'thinking') content.push({ type: 'thinking', thinking: part.text });
      else if (part.type === 'tool-call') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: safeParse(part.arguments) });
      }
    }
    return {
      id: response.id || `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model: response.model || model,
      content,
      stop_reason: encodeStopReason(response.stopReason),
      stop_sequence: null,
      usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens },
    };
  },

  createStreamEncoder(model): StreamEncoder {
    const id = `msg_${Date.now().toString(36)}`;
    let index = 0;
    let toolIndex = -1;
    let started = false;
    let stopped = false;
    // 当前打开的内容块（一段连续文本/思考/工具调用只开一个块）。
    let open: 'text' | 'thinking' | 'tool' | null = null;

    const frame = (event: string, payload: unknown): string =>
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

    const closeBlock = (): string => {
      if (open === null) return '';
      const out = frame('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
      open = null;
      return out;
    };

    const openBlock = (kind: 'text' | 'thinking', delta: Record<string, unknown>): string => {
      if (open !== kind) {
        const head = closeBlock();
        open = kind;
        return (
          head +
          frame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
          }) +
          frame('content_block_delta', { type: 'content_block_delta', index, delta })
        );
      }
      return frame('content_block_delta', { type: 'content_block_delta', index, delta });
    };

    return {
      encode(event) {
        switch (event.type) {
          case 'start': {
            started = true;
            return frame('message_start', {
              type: 'message_start',
              message: {
                id: event.id || id,
                type: 'message',
                role: 'assistant',
                model: event.model || model,
                content: [],
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            });
          }
          case 'text':
            return openBlock('text', { type: 'text_delta', text: event.text });
          case 'thinking':
            return openBlock('thinking', { type: 'thinking_delta', thinking: event.text });
          case 'tool-start': {
            const head = closeBlock();
            toolIndex = index;
            open = 'tool';
            return (
              head +
              frame('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
              })
            );
          }
          case 'tool-args':
            return frame('content_block_delta', {
              type: 'content_block_delta',
              index: toolIndex >= 0 ? toolIndex : index,
              delta: { type: 'input_json_delta', partial_json: event.delta },
            });
          case 'usage':
            return frame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: null, stop_sequence: null },
              usage: { output_tokens: event.usage.outputTokens },
            });
          case 'stop': {
            let out = closeBlock();
            toolIndex = -1;
            stopped = true;
            out += frame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: encodeStopReason(event.reason), stop_sequence: null },
              usage: { output_tokens: 0 },
            });
            out += frame('message_stop', { type: 'message_stop' });
            return out;
          }
        }
      },
      end() {
        if (!started) return null;
        if (stopped) return null;
        return frame('message_stop', { type: 'message_stop' });
      },
    };
  },

  extractUsage(body) {
    if (!isRecord(body)) return null;
    const usage = body['usage'];
    if (isRecord(usage)) return decodeUsage(usage);
    return null;
  },
};

/* --------------------------------- 细节 --------------------------------- */

function decodeSystem(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => (isRecord(item) && typeof item['text'] === 'string' ? item['text'] : ''))
      .join('');
    return text || undefined;
  }
  return undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && typeof item['text'] === 'string') return item['text'];
        return '';
      })
      .join('');
  }
  return '';
}

function decodeTools(value: unknown): IRTool[] | undefined {
  const tools: IRTool[] = [];
  for (const item of asArray(value)) {
    if (!isRecord(item)) continue;
    const name = asString(item['name']);
    if (!name) continue;
    const description = asString(item['description']);
    tools.push({
      name,
      parameters: item['input_schema'] ?? { type: 'object', properties: {} },
      ...(description !== undefined ? { description } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function decodeToolChoice(value: unknown): IRToolChoice | undefined {
  if (!isRecord(value)) return undefined;
  const type = asString(value['type']);
  if (type === 'any') return 'required';
  if (type === 'auto') return 'auto';
  if (type === 'tool') {
    const name = asString(value['name']);
    return name ? { name } : 'auto';
  }
  return undefined;
}

function encodeToolChoice(choice: IRToolChoice): unknown {
  if (choice === 'required') return { type: 'any' };
  if (choice === 'auto' || choice === 'none') return { type: 'auto' };
  return { type: 'tool', name: choice.name };
}

function encodeMessage(message: IRMessage): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) content.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      content.push({
        type: 'image',
        source: part.url
          ? { type: 'url', url: part.url }
          : { type: 'base64', media_type: part.mediaType ?? 'image/png', data: part.data ?? '' },
      });
    } else if (part.type === 'tool-call') {
      content.push({ type: 'tool_use', id: part.id, name: part.name, input: safeParse(part.arguments) });
    } else if (part.type === 'tool-result') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: part.id,
        content: part.content,
        ...(part.isError ? { is_error: true } : {}),
      });
    } else if (part.type === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: part.text,
        ...(part.signature ? { signature: part.signature } : {}),
      });
    }
  }
  // tool_result 必须放在 user 消息的最前面。
  if (toolResults.length > 0) return { role: message.role, content: [...toolResults, ...content] };
  return { role: message.role, content };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function decodeUsage(value: unknown): IRUsage {
  if (!isRecord(value)) return { ...ZERO_USAGE };
  const input = asNumber(value['input_tokens']) ?? asNumber(value['prompt_tokens']) ?? 0;
  const output = asNumber(value['output_tokens']) ?? asNumber(value['completion_tokens']) ?? 0;
  const cacheRead = asNumber(value['cache_read_input_tokens']) ?? 0;
  const cacheWrite = asNumber(value['cache_creation_input_tokens']) ?? 0;
  return {
    ...totalOf(input + cacheRead + cacheWrite, output),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function mergeUsage(base: IRUsage, next: IRUsage): IRUsage {
  const pick = (a: number | undefined, b: number | undefined): number | undefined =>
    Math.max(a ?? 0, b ?? 0) || undefined;
  const cacheRead = pick(base.cacheReadTokens, next.cacheReadTokens);
  const cacheWrite = pick(base.cacheWriteTokens, next.cacheWriteTokens);
  return {
    inputTokens: Math.max(base.inputTokens, next.inputTokens),
    outputTokens: Math.max(base.outputTokens, next.outputTokens),
    totalTokens: Math.max(base.totalTokens, next.totalTokens),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function decodeStopReason(reason: string | undefined): IRStopReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
    case 'end_turn':
      return 'stop';
    default:
      return 'stop';
  }
}

function encodeStopReason(reason: IRStopReason): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}
