/**
 * 上游调用层（目标三 adaptor 的执行侧 + 目标四 2/9/10）。
 *
 * 这一层只做三件事，把「怎么发、失败怎么办、怎么写出」从 relay 里分出来：
 *
 * 1. **一次尝试的完整生命周期**（`fetchUpstream`）：AbortController、连接超时、
 *    总 deadline、客户端断开传播。旧实现是裸 `fetch(url, {...})`——没有 signal，
 *    客户端断开后上游连接会挂到自然超时，慢上游会一直占着并发位与账上冻结。
 * 2. **重试/降级决策**（`RetryPolicy`、`retryDelayMs`）：区分「换账号重试」
 *    （429 / 5xx / 网络 / 超时）与「直接失败」（4xx 参数错）。已向客户端输出过
 *    字节的请求**绝不**重试（目标四 10）——否则客户端会看到两段拼接的响应。
 * 3. **带背压的写出**（`BackpressureWriter`）：检查 `write()` 返回值，false 时
 *    await `drain()`。这是目标四 1 的核心：不检查返回值时，慢客户端的缓冲无界
 *    增长，最终把插件进程的内存吃掉（isolated 模式下还有 RAW_MAX_QUEUE_BYTES
 *    4MiB 的硬墙，超了直接断流）。
 */

import type { RawHttpReply } from '@stackpanel/sdk';

/* ------------------------------ 带背压的写出 ------------------------------ */

/**
 * 包一层 `reply.write`，把 Node 的背压契约显式化。
 *
 * `reply.write(chunk)` 返回 false 表示内核侧缓冲已满，此时**必须**停止生产并
 * `await drain()`（内核 dispatcher 已把 drain 接到原生 ServerResponse 的
 * 'drain' 事件），否则插件与客户端之间的缓冲无界增长。
 */
export class BackpressureWriter {
  private closed = false;

  constructor(private readonly reply: RawHttpReply) {}

  /**
   * 写一块数据；必要时等待排水。
   *
   * @returns 连接是否仍可用（false 表示客户端已断开，调用方应停止读取上游）
   */
  async write(chunk: string | Uint8Array): Promise<boolean> {
    if (this.closed) return false;
    let ok: boolean;
    try {
      ok = this.reply.write(chunk);
    } catch {
      this.closed = true;
      return false;
    }
    if (ok) return true;
    try {
      await this.reply.drain();
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/* ------------------------------ 上游调用 ------------------------------ */

/** 一次上游调用的描述（由 adaptor 构造）。 */
export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string | Uint8Array | undefined;
}

/** 超时与 deadline 配置。 */
export interface UpstreamTimeouts {
  /** 连接（拿到响应头）超时，默认 30s。 */
  connectMs?: number;
  /** 整个请求（含读完响应体）的硬 deadline；0/省略 = 不限（长流合法）。 */
  deadlineMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** 上游调用失败的原因分类（决定能否重试/降级）。 */
export type UpstreamFailureKind =
  | 'timeout'
  | 'client_aborted'
  | 'network'
  | 'http';

export class UpstreamFailure extends Error {
  readonly kind: UpstreamFailureKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: UpstreamFailureKind,
    message: string,
    options: { status?: number | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'UpstreamFailure';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** 解析 Retry-After 头（秒或 HTTP 日期）。 */
export function parseRetryAfterValue(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return null;
}

export interface FetchUpstreamResult {
  response: Response;
  /** 实际耗时（ms），用于指标。 */
  latencyMs: number;
}

/**
 * 发起一次上游请求。
 *
 * 客户端断开（`clientSignal`）会**立即** abort 上游：这是目标四 2 的
 * 「客户端断开传播」。否则一个断开的浏览器会让我们继续烧上游的钱——账单上
 * 还会记一次完整消费。
 *
 * 注意返回的 `response` 仍可流式消费；其 body 的读取在 deadline 内由 relay 负责，
 * 且会继续受同一个 signal 约束（abort 会中断 body 读取）。
 */
export async function fetchUpstream(
  request: UpstreamRequest,
  options: {
    clientSignal?: AbortSignal | undefined;
    timeouts?: UpstreamTimeouts | undefined;
  } = {},
): Promise<FetchUpstreamResult> {
  const timeouts = options.timeouts ?? {};
  const controller = new AbortController();
  const startedAt = Date.now();

  const onClientAbort = (): void => controller.abort(new Error('client disconnected'));
  if (options.clientSignal) {
    if (options.clientSignal.aborted) {
      throw new UpstreamFailure('client_aborted', '客户端已断开');
    }
    options.clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  const connectMs = timeouts.connectMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connectTimer =
    connectMs > 0
      ? setTimeout(() => controller.abort(new Error('upstream connect timeout')), connectMs)
      : null;

  let deadlineTimer: NodeJS.Timeout | null = null;
  if (timeouts.deadlineMs && timeouts.deadlineMs > 0) {
    deadlineTimer = setTimeout(
      () => controller.abort(new Error('upstream deadline exceeded')),
      timeouts.deadlineMs,
    );
  }

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal,
      ...(request.body !== undefined && request.method !== 'GET' ? { body: request.body } : {}),
    });
    // 拿到响应头即视为连接成功，解除连接超时（响应体的读取交给 deadline 管）。
    if (connectTimer) clearTimeout(connectTimer);
    return { response, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (connectTimer) clearTimeout(connectTimer);
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const reasonText = reason instanceof Error ? reason.message : 'aborted';
      if (reasonText.includes('client')) {
        throw new UpstreamFailure('client_aborted', '客户端已断开');
      }
      throw new UpstreamFailure('timeout', `上游超时：${reasonText}`, { status: 408 });
    }
    throw new UpstreamFailure(
      'network',
      error instanceof Error ? error.message : '上游网络错误',
    );
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.clientSignal?.removeEventListener('abort', onClientAbort);
  }
}

/* ------------------------------ 重试策略 ------------------------------ */

export interface RetryPolicy {
  /** 最多尝试次数（含首次）。 */
  maxAttempts: number;
  /** 首次退避基数（ms）。 */
  baseDelayMs: number;
  /** 退避上限（ms）。 */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

/**
 * 是否值得再试一次。
 *
 * - 客户端断开：不重试（重试没有收件人）。
 * - 网络 / 超时：重试（换账号可能就好了）。
 * - HTTP 429 / 408 / 5xx：重试。
 * - 其它 4xx：不重试（参数错，换账号也一样错，重试只是浪费上游配额）。
 */
export function isRetryableFailure(
  kind: UpstreamFailureKind,
  status: number | null,
): boolean {
  if (kind === 'client_aborted') return false;
  if (kind === 'network' || kind === 'timeout') return true;
  if (status === null) return false;
  return status === 429 || status === 408 || status >= 500;
}

/**
 * 退避时长：指数 + 抖动。
 *
 * 抖动是必要的：几百个并发请求同时被 429 后，若退避时间完全相同，它们会在同一
 * 时刻一起重试，把上游再打一次——这就是「惊群」。
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterSeconds?: number | null,
): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const base = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

/** 可取消的睡眠（客户端断开时立即结束，不必等满退避）。 */
export async function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------ 响应体读取 ------------------------------ */

/** 默认响应体大小上限（目标四 8）：超过即视为异常上游，不再无限读入内存。 */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * 带上限读取响应体。超限抛 `UpstreamFailure('http')`——继续读会让进程 OOM，
 * 而截断会产生一个语义错误的响应体，两者都不可接受，所以显式失败。
 */
export async function readResponseBody(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamFailure('http', `上游响应超过 ${maxBytes} 字节上限`, {
        status: response.status,
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
