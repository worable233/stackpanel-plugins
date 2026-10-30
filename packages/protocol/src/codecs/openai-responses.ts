import {
  asArray,
  asNumber,
  asString,
  isRecord,
  safeJsonStringify,
  textOf,
  totalOf,
  ZERO_USAGE,
  type IRMessage,
  type IRPart,
  type IRStreamEvent,
  type IRTool,
  type IRToolChoice,
  type IRUsage,
} from '../protocol.js';
import { SseParser, type ProtocolCodec, type StreamDecoder, type StreamEncoder } from './types.js';

/** OpenAI Responses API 编解码。 */
export const openaiResponsesCodec: ProtocolCodec = {
  protocol: 'openai-responses',
  streamContentType: 'text/event-stream',

  decodeRequest(body) {
    const b = isRecord(body) ? body : {};
    const messages: IRMessage[] = [];
    const instructions = typeof b['instructions'] === 'string' ? b['instructions'] : undefined;
    if (instructions)
      messages.push({ role: 'system', parts: [{ type: 'text', text: instructions }] });

    // Responses 的 input 既可以是字符串，也可以是消息数组。
    const rawInput = b['input'];
    const inputItems = typeof rawInput === 'string' ? [rawInput] : asArray(rawInput);
    for (const raw of inputItems) {
      if (typeof raw === 'string') {
        messages.push({ role: 'user', parts: [{ type: 'text', text: raw }] });
        continue;
      }
      if (!isRecord(raw)) continue;
      const type = asString(raw['type']);
      if (type === 'function_call') {
        messages.push({
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              id: asString(raw['call_id']) ?? '',
              name: asString(raw['name']) ?? '',
              arguments: asString(raw['arguments']) ?? '{}',
            },
          ],
        });
        continue;
      }
      if (type === 'function_call_output') {
        const id = asString(raw['call_id']) ?? '';
        messages.push({
          role: 'tool',
          toolCallId: id,
          parts: [{ type: 'tool-result', id, content: asString(raw['output']) ?? '' }],
        });
        continue;
      }
      const role =
        asString(raw['role']) === 'assistant'
          ? 'assistant'
          : asString(raw['role']) === 'system'
            ? 'system'
            : 'user';
      const parts: IRPart[] = [];
      for (const part of asArray(raw['content'])) {
        if (!isRecord(part)) {
          if (typeof part === 'string') parts.push({ type: 'text', text: part });
          continue;
        }
        const partType = asString(part['type']);
        if (partType === 'input_text' || partType === 'output_text' || partType === 'text') {
          parts.push({ type: 'text', text: asString(part['text']) ?? '' });
        } else if (partType === 'input_image') {
          const url = asString(part['image_url']) ?? '';
          if (url.startsWith('data:')) {
            const match = /^data:([^;]+);base64,(.*)$/.exec(url);
            if (match && match[1] && match[2]) {
              parts.push({ type: 'image', data: match[2], mediaType: match[1] });
            }
          } else if (url) {
            parts.push({ type: 'image', url });
          }
        }
      }
      messages.push({ role, parts });
    }

    return {
      model: asString(b['model']) ?? '',
      messages,
      tools: decodeTools(b['tools']),
      toolChoice: decodeToolChoice(b['tool_choice']),
      maxTokens: asNumber(b['max_output_tokens']),
      temperature: asNumber(b['temperature']),
      topP: asNumber(b['top_p']),
      stream: b['stream'] === true,
      raw: body,
    };
  },

  encodeRequest(request) {
    const input: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        const result = message.parts.find((part) => part.type === 'tool-result');
        input.push({
          type: 'function_call_output',
          call_id: result && result.type === 'tool-result' ? result.id : (message.toolCallId ?? ''),
          output: result && result.type === 'tool-result' ? result.content : '',
        });
        continue;
      }
      const call = message.parts.find((part) => part.type === 'tool-call');
      if (call && call.type === 'tool-call' && message.parts.length === 1) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        continue;
      }
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: 'input_text', text: part.text });
        else if (part.type === 'image') {
          const url =
            part.url ??
            (part.data ? `data:${part.mediaType ?? 'image/png'};base64,${part.data}` : '');
          if (url) content.push({ type: 'input_image', image_url: url });
        }
      }
      input.push({ role: message.role, content });
    }

    const systemText = [
      request.system,
      ...request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.parts)),
    ]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('\n\n');

    const body: Record<string, unknown> = { model: request.model, input, stream: request.stream };
    if (systemText) body['instructions'] = systemText;
    if (request.maxTokens !== undefined) body['max_output_tokens'] = request.maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.topP !== undefined) body['top_p'] = request.topP;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.parameters,
      }));
      if (request.toolChoice !== undefined)
        body['tool_choice'] = encodeToolChoice(request.toolChoice);
    }
    return body;
  },

  requestPath() {
    return 'v1/responses';
  },

  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` };
  },

  decodeResponse(body) {
    const b = isRecord(body) ? body : {};
    const parts: IRPart[] = [];
    for (const item of asArray(b['output'])) {
      if (!isRecord(item)) continue;
      const type = asString(item['type']);
      if (type === 'message') {
        for (const part of asArray(item['content'])) {
          if (isRecord(part) && (part['type'] === 'output_text' || part['type'] === 'text')) {
            parts.push({ type: 'text', text: asString(part['text']) ?? '' });
          }
        }
      } else if (type === 'function_call') {
        parts.push({
          type: 'tool-call',
          id: asString(item['call_id']) ?? asString(item['id']) ?? '',
          name: asString(item['name']) ?? '',
          arguments: asString(item['arguments']) ?? '{}',
        });
      } else if (type === 'reasoning') {
        const summary = asArray(item['summary'])
          .map((s) => (isRecord(s) ? (asString(s['text']) ?? '') : ''))
          .join('');
        if (summary) parts.push({ type: 'thinking', text: summary });
      }
    }
    const incomplete = isRecord(b['incomplete_details']) ? b['incomplete_details'] : null;
    const hasToolCall = parts.some((part) => part.type === 'tool-call');
    return {
      id: asString(b['id']) ?? '',
      model: asString(b['model']) ?? '',
      parts,
      stopReason: incomplete ? 'length' : hasToolCall ? 'tool_calls' : 'stop',
      usage: decodeUsage(b['usage']),
      raw: body,
    };
  },

  createStreamDecoder(): StreamDecoder {
    const parser = new SseParser();
    const toolByItem = new Map<string, number>();
    const pendingArgs = new Map<number, string>();
    const emitted = new Set<number>();
    let nextIndex = 0;
    let usage: IRUsage = { ...ZERO_USAGE };
    let started = false;
    let stopped = false;

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
          case 'response.created': {
            const response = isRecord(json['response']) ? json['response'] : {};
            started = true;
            events.push({
              type: 'start',
              id: asString(response['id']) ?? '',
              model: asString(response['model']) ?? '',
            });
            break;
          }
          case 'response.output_item.added': {
            const item = isRecord(json['item']) ? json['item'] : {};
            const itemId = asString(item['id']) ?? '';
            const index = assignIndex(itemId, toolByItem, () => nextIndex++);
            if (asString(item['type']) === 'function_call') {
              events.push({
                type: 'tool-start',
                index,
                id: asString(item['call_id']) ?? itemId,
                name: asString(item['name']) ?? '',
              });
            }
            break;
          }
          case 'response.output_text.delta': {
            const text = asString(json['delta']) ?? '';
            if (text) events.push({ type: 'text', text });
            break;
          }
          case 'response.reasoning_summary_text.delta':
          case 'response.reasoning_text.delta': {
            const text = asString(json['delta']) ?? '';
            if (text) events.push({ type: 'thinking', text });
            break;
          }
          case 'response.function_call_arguments.delta': {
            const itemId = asString(json['item_id']) ?? '';
            const index = assignIndex(itemId, toolByItem, () => nextIndex++);
            pendingArgs.set(
              index,
              (pendingArgs.get(index) ?? '') + (asString(json['delta']) ?? ''),
            );
            if (!emitted.has(index)) {
              emitted.add(index);
              events.push({
                type: 'tool-start',
                index,
                id: asString(json['call_id']) ?? itemId,
                name: '',
              });
            }
            events.push({ type: 'tool-args', index, delta: asString(json['delta']) ?? '' });
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            const response = isRecord(json['response']) ? json['response'] : {};
            usage = decodeUsage(response['usage']);
            if (!stopped) {
              stopped = true;
              events.push({
                type: 'stop',
                reason: type === 'response.incomplete' ? 'length' : 'stop',
              });
            }
            break;
          }
          case 'response.failed':
          case 'response.error': {
            if (!stopped) {
              stopped = true;
              events.push({ type: 'stop', reason: 'error' });
            }
            break;
          }
          default:
            break;
        }
      }
      if (usage.totalTokens > 0) {
        events.push({ type: 'usage', usage });
        usage = { ...ZERO_USAGE };
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
    const output: Array<Record<string, unknown>> = [];
    const text = textOf(response.parts);
    if (text.length > 0) {
      output.push({
        id: `msg_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const part of response.parts) {
      if (part.type === 'tool-call') {
        output.push({
          type: 'function_call',
          id: `fc_${Date.now().toString(36)}`,
          call_id: part.id,
          name: part.name,
          arguments: part.arguments,
        });
      }
    }
    return {
      id: response.id || `resp_${Date.now().toString(36)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: response.model || model,
      status: response.stopReason === 'error' ? 'failed' : 'completed',
      output,
      usage: {
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
      },
    };
  },

  createStreamEncoder(model): StreamEncoder {
    const id = `resp_${Date.now().toString(36)}`;
    const msgId = `msg_${Date.now().toString(36)}`;
    let seq = 0;
    let toolIndex = -1;
    let toolId = '';
    let completed = false;

    const frame = (event: string, payload: Record<string, unknown>): string =>
      `event: ${event}\ndata: ${JSON.stringify({ ...payload, sequence_number: seq++ })}\n\n`;

    return {
      encode(event) {
        switch (event.type) {
          case 'start':
            return frame('response.created', {
              type: 'response.created',
              response: { id, model: event.model || model, status: 'in_progress', output: [] },
            });
          case 'text':
          case 'thinking':
            return frame('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: msgId,
              output_index: 0,
              content_index: 0,
              delta: event.text,
            });
          case 'tool-start':
            toolIndex = event.index;
            toolId = event.id;
            return frame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: event.index + 1,
              item: {
                type: 'function_call',
                id: toolId,
                call_id: toolId,
                name: event.name,
                arguments: '',
              },
            });
          case 'tool-args':
            return frame('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: toolId,
              output_index: Math.max(0, toolIndex) + 1,
              delta: event.delta,
            });
          case 'usage':
            return frame('response.usage', {
              type: 'response.usage',
              usage: {
                input_tokens: event.usage.inputTokens,
                output_tokens: event.usage.outputTokens,
                total_tokens: event.usage.totalTokens,
              },
            });
          case 'stop': {
            completed = true;
            return frame('response.completed', {
              type: 'response.completed',
              response: { id, model, status: 'completed', output: [] },
            });
          }
        }
      },
      end() {
        if (completed) return null;
        completed = true;
        return 'data: [DONE]\n\n';
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

function assignIndex(key: string, map: Map<string, number>, next: () => number): number {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = next();
  map.set(key, value);
  return value;
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
      parameters: item['parameters'] ?? { type: 'object', properties: {} },
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
    const name = asString(value['name']);
    if (name) return { name };
  }
  return undefined;
}

function encodeToolChoice(choice: IRToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}

function decodeUsage(value: unknown): IRUsage {
  if (!isRecord(value)) return { ...ZERO_USAGE };
  const input = asNumber(value['input_tokens']) ?? asNumber(value['prompt_tokens']) ?? 0;
  const output = asNumber(value['output_tokens']) ?? asNumber(value['completion_tokens']) ?? 0;
  const details = isRecord(value['input_tokens_details']) ? value['input_tokens_details'] : null;
  const cached = details ? asNumber(details['cached_tokens']) : undefined;
  return {
    ...totalOf(input, output, asNumber(value['total_tokens'])),
    ...(cached && cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

export { safeJsonStringify };
