/**
 * 可观测性契约测试（目标九）。
 *
 * 验证分钟桶、只增不减、以及 `observe()` 把请求结果正确映射到各维度计数。
 * 用内存 `StateService`，不依赖 Redis。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryState } from './state-stub.test-util.js';
import {
  bucketIndexOf,
  LATENCY_BOUNDS_MS,
  percentileOfBuckets,
  readLatencyStats,
} from './observability.js';
import { Metrics, readAllMetrics, type RequestObservation } from './observability.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function observation(overrides: Partial<RequestObservation> = {}): RequestObservation {
  return {
    endpoint: 'chat.completions',
    protocol: 'openai-chat',
    model: 'test-model',
    latencyMs: 10,
    firstTokenMs: null,
    status: 200,
    retries: 0,
    accountId: 'acct-1',
    stream: false,
    clientAborted: false,
    settled: true,
    ...overrides,
  };
}

describe('Metrics', () => {
  it('bumps request.total for every observed request', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    await metrics.observe(observation());
    await metrics.observe(observation());
    const read = await metrics.read('request.total');
    expect(read.current).toBe(2);
  });

  it('maps error / stream / retry / settle-failure dimensions', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);

    await metrics.observe(
      observation({
        status: 502,
        stream: true,
        retries: 2,
        settled: false,
      }),
    );

    expect((await metrics.read('request.total')).current).toBe(1);
    expect((await metrics.read('request.error')).current).toBe(1);
    expect((await metrics.read('stream.total')).current).toBe(1);
    expect((await metrics.read('request.retry')).current).toBe(2);
    expect((await metrics.read('billing.settle_failed')).current).toBe(1);
    expect((await metrics.read('upstream.5xx')).current).toBe(1);
  });

  it('counts 429 as an upstream rate-limit', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    await metrics.observe(observation({ status: 429 }));
    expect((await metrics.read('upstream.429')).current).toBe(1);
    expect((await metrics.read('upstream.5xx')).current).toBe(0);
  });

  it('separates current and previous minute buckets', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    const minute = 60_000;
    const base = 1_000_000_000_000 - (1_000_000_000_000 % minute);

    await metrics.bumpBy('request.total', 1, base - minute); // 上一分钟
    await metrics.bumpBy('request.total', 3, base); // 本分钟

    const read = await metrics.read('request.total', base + 1);
    expect(read.current).toBe(3);
    expect(read.previous).toBe(1);
  });

  it('ignores non-positive amounts', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    await metrics.bump('request.total', 0);
    await metrics.bumpBy('request.retry', 0);
    expect((await metrics.read('request.total')).current).toBe(0);
  });

  it('never throws when the state backend fails', async () => {
    const state = new InMemoryState();
    state.failIncrFor = `gw:metric:request.total:${Math.floor(Date.now() / 60_000)}`;
    const metrics = new Metrics(state, silentLogger);
    await expect(metrics.observe(observation())).resolves.toBeUndefined();
  });
});

describe('readAllMetrics', () => {
  it('reads every requested name in one pass', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    await metrics.bumpBy('request.total', 2);
    await metrics.bumpBy('request.error', 1);

    const all = await readAllMetrics(state, ['request.total', 'request.error', 'upstream.5xx']);
    expect(all['request.total']?.current).toBe(2);
    expect(all['request.error']?.current).toBe(1);
    expect(all['upstream.5xx']?.current).toBe(0);
  });
});

describe('延迟分布（D5）', () => {
  it('bucketIndexOf 按档位上界落桶，超大值进溢出桶', () => {
    expect(bucketIndexOf(1)).toBe(0);
    expect(bucketIndexOf(50)).toBe(0);
    expect(bucketIndexOf(51)).toBe(1);
    expect(bucketIndexOf(1000)).toBe(6);
    expect(bucketIndexOf(120_000)).toBe(LATENCY_BOUNDS_MS.length);
  });

  it('percentileOfBuckets 返回命中档位上界，空样本返回 null', () => {
    // 100 个样本全落在 <=200ms 桶（index 2）。
    const counts = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
    counts[2] = 100;
    expect(percentileOfBuckets(counts, 50)).toBe(200);
    expect(percentileOfBuckets(counts, 95)).toBe(200);
    expect(percentileOfBuckets(new Array(LATENCY_BOUNDS_MS.length + 1).fill(0), 95)).toBeNull();
  });

  it('percentileOfBuckets 跨桶累计后取正确档位', () => {
    const counts = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
    counts[3] = 90; // <=300ms
    counts[8] = 10; // <=3000ms
    expect(percentileOfBuckets(counts, 50)).toBe(300);
    // 95% 落在第二个桶 → 3000ms
    expect(percentileOfBuckets(counts, 95)).toBe(3000);
  });

  it('observe 写入直方图，readLatencyStats 能读回样本数', async () => {
    const state = new InMemoryState();
    const metrics = new Metrics(state, silentLogger);
    await metrics.observe(observation({ latencyMs: 120, firstTokenMs: 80 }));
    await metrics.observe(observation({ latencyMs: 400, firstTokenMs: null }));

    const total = await readLatencyStats(state, 'latency');
    expect(total.count).toBe(2);
    expect(total.p50).not.toBeNull();
    const first = await readLatencyStats(state, 'first_token');
    expect(first.count).toBe(1);
  });

  it('readLatencyStats 在 state 读失败时降级为空样本', async () => {
    const state = new InMemoryState();
    state.failGet = true;
    const stats = await readLatencyStats(state, 'latency');
    expect(stats).toEqual({ p50: null, p95: null, count: 0 });
  });
});
