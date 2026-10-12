import {
  asArray,
  asNumber,
  asString,
  isRecord,
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
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from './types.js';

/**
 * Google Gemini 原生协议编解码。
 *
 * - 输入侧：入口 `/v1beta/models/{model}:generateContent|streamGenerateContent`
 *   （也容错接受 JSON body 里带 model 的情形）。
 * - 输出侧：上游 `POST {base}/v1beta/models/{model}:generateContent`。
 */
export const geminiCodec: ProtocolCodec = {
  protocol: 'gemini',
  streamContentType: 'text/event-stream',

  decodeRequest(body) {
    const b = isRecord(body) ? body : {};
    const messages: IRMessage[] = [];
    const system = systemText(b['systemInstruction'] ?? b['system_instruction']);
    const tools = decodeTools(b['tools']);
    for (const raw of asArray(b['contents'])) {
      if (!isRecord(raw)) continue;
      const role = asString(raw['role']) === 'model' ? 'assistant' : 'user';
      const parts: IRPart[] = [];
      for (const part of asArray(raw['parts'])) {
        if (!isRecord(part)) continue;
        if (typeof part['text'] === 'string') {
          parts.push({ type: 'text', text: part['text'] });
        } else if (isRecord(part['inlineData']) || isRecord(part['inline_data'])) {
          const inline = isRecord(part['inlineData']) ? part['inlineData'] : part['inline_data'];
          if (isRecord(inline)) {
            parts.push({
              type: 'image',
              data: asString(inline['data']) ?? '',
              mediaType: asString(inline['mimeType']) ?? asString(inline['mime_type']) ?? 'image/png',
            });
          }
        } else if (isRecord(part['functionCall']) || isRecord(part['function_call'])) {
          const call = isRecord(part['functionCall']) ? part['functionCall'] : part['function_call'];
          if (isRecord(call)) {
            const name = asString(call['name']) ?? '';
            parts.push({
              type: 'tool-call',
              id: name,
              name,
              arguments: JSON.stringify(call['args'] ?? {}),
            });
          }
        } else if (isRecord(part['functionResponse']) || isRecord(part['function_response'])) {
          const resp = isRecord(part['functionResponse']) ? part['functionResponse'] : part['function_response'];
          if (isRecord(resp)) {
            const name = asString(resp['name']) ?? '';
            parts.push({ type: 'tool-result', id: name, content: JSON.stringify(resp['response'] ?? {}) });
          }
        }
      }
      messages.push({ role, parts });
    }

    const generationConfig = isRecord(b['generationConfig'])
      ? b['generationConfig']
      : isRecord(b['generation_config'])
        ? b['generation_config']
        : {};

    return {
      model: asString(b['model']) ?? '',
      messages,
      ...(system !== undefined ? { system } : {}),
      tools,
      toolChoice: undefined,
      maxTokens: asNumber(generationConfig['maxOutputTokens']) ?? asNumber(generationConfig['max_output_tokens']),
      temperature: asNumber(generationConfig['temperature']),
      topP: asNumber(generationConfig['topP']) ?? asNumber(generationConfig['top_p']),
      stop: stopSequences(generationConfig),
      stream: false,
      raw: body,
    };
  },

  encodeRequest(request) {
    const contents: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      contents.push(encodeMessage(message));
    }
    const systemText = [
      request.system,
      ...request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.parts)),
    ]
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('\n\n');

    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.topP !== undefined) generationConfig['topP'] = request.topP;
    if (request.stop && request.stop.length > 0) generationConfig['stopSequences'] = request.stop;

    const body: Record<string, unknown> = { contents };
    if (systemText) body['systemInstruction'] = { parts: [{ text: systemText }] };
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
    if (request.tools && request.tools.length > 0) {
      body['tools'] = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            parameters: tool.parameters,
          })),
        },
      ];
    }
    return body;
  },

  requestPath(request, stream) {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return `v1beta/models/${encodeURIComponent(request.model)}:${action}`;
  },

  authHeaders(apiKey) {
    return { 'x-goog-api-key': apiKey };
  },

  decodeResponse(body) {
    const b = isRecord(body) ? body : {};
    return {
      id: asString(b['responseId']) ?? '',
      model: asString(b['modelVersion']) ?? '',
      parts: decodeCandidate(b),
      stopReason: decodeStopReason(b),
      usage: decodeUsage(b['usageMetadata'] ?? b['usage_metadata']),
      raw: body,
    };
  },

  createStreamDecoder(): StreamDecoder {
    // Gemini 流式返回 JSON 数组分片（`[{...},{...}]`）或 SSE data 帧；两者都兼容。
    let buffer = '';
    let started = false;
    let stopped = false;
    let lastUsage: IRUsage = { ...ZERO_USAGE };
    let model = '';
    let id = '';

    const handleObject = (obj: Record<string, unknown>): IRStreamEvent[] => {
      const events: IRStreamEvent[] = [];
      if (!started) {
        started = true;
        id = asString(obj['responseId']) ?? '';
        model = asString(obj['modelVersion']) ?? '';
        events.push({ type: 'start', id, model });
      }
      const parts = decodeCandidate(obj);
      for (const part of parts) {
        if (part.type === 'text') events.push({ type: 'text', text: part.text });
        else if (part.type === 'thinking') events.push({ type: 'thinking', text: part.text });
        else if (part.type === 'tool-call') {
          events.push({ type: 'tool-start', index: 0, id: part.id, name: part.name });
          events.push({ type: 'tool-args', index: 0, delta: part.arguments });
        }
      }
      const usage = decodeUsage(obj['usageMetadata'] ?? obj['usage_metadata']);
      if (usage.totalTokens > 0) lastUsage = usage;
      // 出现 finishReason 即为终止帧（STOP/MAX_TOKENS/SAFETY…）。
      const candidate = asArray(obj['candidates']).find(isRecord);
      const finish = candidate ? asString(candidate['finishReason']) : undefined;
      if (finish && !stopped) {
        stopped = true;
        events.push({ type: 'stop', reason: decodeStopReason(obj) });
      }
      return events;
    };

    return {
      push(chunk) {
        buffer += chunk;
        const events: IRStreamEvent[] = [];
        // 逐字符扫描顶层对象边界，容忍数组包裹与 SSE 前缀。
        let depth = 0;
        let start = -1;
        for (let i = 0; i < buffer.length; i += 1) {
          const char = buffer[i];
          if (char === '{') {
            if (depth === 0) start = i;
            depth += 1;
          } else if (char === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
              const slice = buffer.slice(start, i + 1);
              start = -1;
              try {
                const parsed = JSON.parse(slice) as unknown;
                if (isRecord(parsed)) events.push(...handleObject(parsed));
              } catch {
                // 不完整的对象，等更多数据。
              }
            }
          }
        }
        if (start >= 0) buffer = buffer.slice(start);
        else buffer = '';
        if (lastUsage.totalTokens > 0) {
          events.push({ type: 'usage', usage: lastUsage });
          lastUsage = { ...ZERO_USAGE };
        }
        return events;
      },
      end() {
        buffer = '';
        return [];
      },
    };
  },

  encodeResponse(response, model) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of response.parts) {
      if (part.type === 'text') parts.push({ text: part.text });
      else if (part.type === 'tool-call') {
        parts.push({ functionCall: { name: part.name, args: safeParse(part.arguments) } });
      }
    }
    return {
      candidates: [
        {
          content: { role: 'model', parts },
          finishReason: encodeStopReason(response.stopReason),
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: response.usage.inputTokens,
        candidatesTokenCount: response.usage.outputTokens,
        totalTokenCount: response.usage.totalTokens,
      },
      modelVersion: response.model || model,
      responseId: response.id || `gemini_${Date.now().toString(36)}`,
    };
  },

  createStreamEncoder(model): StreamEncoder {
    const id = `gemini_${Date.now().toString(36)}`;
    let completed = false;
    let stopReason: IRStopReason = 'stop';
    let usage: IRUsage | null = null;
    const tools = new Map<number, { name: string; args: string }>();

    const frame = (payload: Record<string, unknown>): string =>
      `data: ${JSON.stringify(payload)}\n\n`;

    return {
      encode(event) {
        switch (event.type) {
          case 'start':
            return null;
          case 'text':
            return frame({
              candidates: [{ content: { role: 'model', parts: [{ text: event.text }] }, index: 0 }],
            });
          case 'thinking':
            return frame({
              candidates: [
                { content: { role: 'model', parts: [{ text: event.text, thought: true }] }, index: 0 },
              ],
            });
          case 'tool-start': {
            const current = tools.get(event.index) ?? { name: '', args: '' };
            current.name = event.name;
            tools.set(event.index, current);
            return null;
          }
          case 'tool-args': {
            const current = tools.get(event.index) ?? { name: '', args: '' };
            current.args += event.delta;
            tools.set(event.index, current);
            return null;
          }
          case 'usage':
            usage = event.usage;
            return null;
          case 'stop': {
            stopReason = event.reason;
            const parts = [...tools.values()].map((tool) => ({
              functionCall: { name: tool.name, args: safeParse(tool.args) },
            }));
            if (parts.length > 0) {
              return frame({ candidates: [{ content: { role: 'model', parts }, index: 0 }] });
            }
            return null;
          }
        }
      },
      end() {
        if (completed) return null;
        completed = true;
        const final: Record<string, unknown> = {
          candidates: [
            {
              content: { role: 'model', parts: [] },
              finishReason: encodeStopReason(stopReason),
              index: 0,
            },
          ],
          modelVersion: model,
          responseId: id,
        };
        if (usage) {
          final['usageMetadata'] = {
            promptTokenCount: usage.inputTokens,
            candidatesTokenCount: usage.outputTokens,
            totalTokenCount: usage.totalTokens,
          };
        }
        return frame(final);
      },
    };
  },

  extractUsage(body) {
    if (!isRecord(body)) return null;
    const usage = body['usageMetadata'] ?? body['usage_metadata'];
    if (isRecord(usage)) return decodeUsage(usage);
    return null;
  },
};

/* --------------------------------- 细节 --------------------------------- */

function decodeCandidate(obj: Record<string, unknown>): IRPart[] {
  const parts: IRPart[] = [];
  const candidate = asArray(obj['candidates']).find(isRecord);
  const content = candidate && isRecord(candidate['content']) ? candidate['content'] : null;
  if (!content) return parts;
  for (const part of asArray(content['parts'])) {
    if (!isRecord(part)) continue;
    if (typeof part['text'] === 'string') {
      if (part['thought'] === true) parts.push({ type: 'thinking', text: part['text'] });
      else parts.push({ type: 'text', text: part['text'] });
    } else if (isRecord(part['functionCall']) || isRecord(part['function_call'])) {
      const call = isRecord(part['functionCall']) ? part['functionCall'] : part['function_call'];
      if (isRecord(call)) {
        const name = asString(call['name']) ?? '';
        parts.push({ type: 'tool-call', id: name, name, arguments: JSON.stringify(call['args'] ?? {}) });
      }
    }
  }
  return parts;
}

function systemText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const text = asArray(value['parts'])
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .join('');
  return text || undefined;
}

function decodeTools(value: unknown): IRTool[] | undefined {
  const tools: IRTool[] = [];
  for (const group of asArray(value)) {
    if (!isRecord(group)) continue;
    const declarations = asArray(group['functionDeclarations'] ?? group['function_declarations']);
    for (const decl of declarations) {
      if (!isRecord(decl)) continue;
      const name = asString(decl['name']);
      if (!name) continue;
      const description = asString(decl['description']);
      tools.push({
        name,
        parameters: decl['parameters'] ?? { type: 'object', properties: {} },
        ...(description !== undefined ? { description } : {}),
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

function stopSequences(config: Record<string, unknown>): string[] | undefined {
  const value = config['stopSequences'] ?? config['stop_sequences'];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function encodeMessage(message: IRMessage): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.type === 'text') parts.push({ text: part.text });
    else if (part.type === 'image') {
      parts.push({
        inlineData: { mimeType: part.mediaType ?? 'image/png', data: part.data ?? '' },
      });
    } else if (part.type === 'tool-call') {
      parts.push({ functionCall: { name: part.name, args: safeParse(part.arguments) } });
    } else if (part.type === 'tool-result') {
      parts.push({ functionResponse: { name: part.id, response: { result: part.content } } });
    }
  }
  return { role: message.role === 'assistant' ? 'model' : 'user', parts };
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
  const input = asNumber(value['promptTokenCount']) ?? 0;
  const output = asNumber(value['candidatesTokenCount']) ?? 0;
  const cached = asNumber(value['cachedContentTokenCount']);
  return {
    ...totalOf(input, output, asNumber(value['totalTokenCount'])),
    ...(cached && cached > 0 ? { cacheReadTokens: cached } : {}),
  };
}

function decodeStopReason(obj: Record<string, unknown>): IRStopReason {
  const candidate = asArray(obj['candidates']).find(isRecord);
  const reason = candidate ? asString(candidate['finishReason']) : undefined;
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function encodeStopReason(reason: IRStopReason): string {
  switch (reason) {
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

// 保留接口一致性（tool_choice 在 Gemini 无原生对应，忽略）。
export type { IRToolChoice };
