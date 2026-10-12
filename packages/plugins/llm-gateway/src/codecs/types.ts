import type {
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRUsage,
  Protocol,
} from '../protocol.js';

/** 增量式 SSE 解析器（按空行分帧，兼容 \r\n）。 */
export class SseParser {
  private buffer = '';

  push(chunk: string): Array<{ event?: string; data: string }> {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: Array<{ event?: string; data: string }> = [];
    for (;;) {
      const index = this.buffer.indexOf('\n\n');
      if (index === -1) break;
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const parsed = parseBlock(block);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  end(): Array<{ event?: string; data: string }> {
    const block = this.buffer.trim();
    this.buffer = '';
    const parsed = block ? parseBlock(block) : null;
    return parsed ? [parsed] : [];
  }
}

function parseBlock(block: string): { event?: string; data: string } | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length === 0 && event === undefined) return null;
  return { ...(event !== undefined ? { event } : {}), data: data.join('\n') };
}

/** 增量解析器：喂入 chunk，产出 IR 流事件。 */
export interface StreamDecoder {
  push(chunk: string): IRStreamEvent[];
  end(): IRStreamEvent[];
}

/** 把 IR 流事件编码为上游/入口协议的 SSE 文本。 */
export interface StreamEncoder {
  encode(event: IRStreamEvent): string | null;
  end(): string | null;
}

/** 一种协议的编解码器。 */
export interface ProtocolCodec {
  protocol: Protocol;
  /** 入口请求体 → IR。 */
  decodeRequest(body: unknown): IRRequest;
  /** IR → 上游请求体。 */
  encodeRequest(request: IRRequest): unknown;
  /** 上游路径（相对 baseUrl）；Gemini 需要把模型名放进路径。 */
  requestPath(request: IRRequest, stream: boolean): string;
  /** 认证头。 */
  authHeaders(apiKey: string): Record<string, string>;
  /** 上游非流式响应 → IR。 */
  decodeResponse(body: unknown): IRResponse;
  /** 上游流式解码器。 */
  createStreamDecoder(): StreamDecoder;
  /** IR → 入口非流式响应体。 */
  encodeResponse(response: IRResponse, model: string): unknown;
  /** 入口流式编码器。 */
  createStreamEncoder(model: string): StreamEncoder;
  /** 从原始响应体提取用量（无 usage 时兜底）。 */
  extractUsage(body: unknown): IRUsage | null;
  /** SSE 响应的 content-type。 */
  readonly streamContentType: string;
}
