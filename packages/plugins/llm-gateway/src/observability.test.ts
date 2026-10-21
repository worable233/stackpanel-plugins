/**
 * 可观测性契约测试（目标九）。
 *
 * 验证分钟桶、只增不减、以及 `observe()` 把请求结果正确映射到各维度计数。
 * 用内存 `StateService`，不依赖 Redis。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryState } from './state-stub.test-util.js';
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
