/**
 * 可观测性（目标一 observability 模块；目标九的指标口径）。
 *
 * 纪律：指标**只增不减**，且一律走 `StateService`（Redis）——多实例部署时
 * 进程内计数器只能看到本实例的部分流量，运维看板会得出错误结论。
 *
 * 计数器按「分钟桶」切分：键形如 `gw:metric:{name}:{bucket}`，TTL 覆盖两个桶，
 * 这样管理端既能读「本分钟」（瞬时），也能读「上一分钟」（已封口的完整窗口），
 * 而不需要任何后台聚合任务。
 *
 * 指标本身**不参与计费与限流**：计费在 `billing.ts`、限流在 `scheduler.ts`。
 * 这里是纯粹的观测面，失败一律吞掉（`catch(() => null)`）——观测系统抖动绝不
 * 能把业务请求打挂。
 */

import type { PluginLogger, StateService } from '@stackpanel/sdk';

/** 我们关心的计数维度（封闭集合，避免拼写漂移把看板打散）。 */
export type MetricName =
  | 'request.total'
  | 'request.error'
  | 'request.retry'
  | 'request.client_abort'
  | 'upstream.error'
  | 'upstream.429'
  | 'upstream.5xx'
  | 'upstream.timeout'
  | 'upstream.key_rotate'
  | 'upstream.status_mapped'
  | 'breaker.open'
  | 'account.failover'
  | 'account.auto_disabled'
  | 'account.key_exhausted'
  | 'billing.settle_failed'
  | 'billing.compensation_settled'
  | 'billing.compensation_failed'
  | 'stream.total'
  | 'stream.lease_lost'
  | 'stream.slow_client';

/** 分钟桶宽度。 */
const BUCKET_MS = 60_000;

/** 计数器保留两个桶，保证「上一分钟」可读。 */
const TTL_MS = 2 * BUCKET_MS;

/** 一次请求结束时上报的观测数据。 */
export interface RequestObservation {
  endpoint: string;
  protocol: string;
  model: string;
  /** 入口到响应结束的总耗时。 */
  latencyMs: number;
  /** 首 token 耗时（非流式为 null）。 */
  firstTokenMs: number | null;
  status: number;
  retries: number;
  /** 实际服务的账号；一次请求中途 failover 时是最终那个。 */
  accountId: string | null;
  /** 是否流式。 */
  stream: boolean;
  /** 是否客户端主动断开。 */
  clientAborted: boolean;
  /** 结算是否成功落到钱包（false = 已进补偿队列）。 */
  settled: boolean;
}

/** 指标收集器。无状态，每个请求短暂持有即可。 */
export class Metrics {
  constructor(
    private readonly state: StateService,
    private readonly logger: PluginLogger,
  ) {}

  private bucketKey(name: MetricName, now = Date.now()): string {
    return `gw:metric:${name}:${Math.floor(now / BUCKET_MS)}`;
  }

  /** 单个计数器 +1（失败静默：观测永远不能拖垮业务）。 */
  async bump(name: MetricName, amount = 1, now = Date.now()): Promise<void> {
    if (amount <= 0) return;
    const key = this.bucketKey(name, now);
    // `incr` 只在首次自增时设 TTL，故只需传窗口长度。
    await this.state.incr(key, TTL_MS).catch(() => null);
  }

  /** 计数器 +N（用于重试次数这类批量累加）。 */
  async bumpBy(name: MetricName, amount: number, now = Date.now()): Promise<void> {
    if (amount <= 0) return;
    const key = this.bucketKey(name, now);
    for (let i = 0; i < amount; i += 1) {
      await this.state.incr(key, TTL_MS).catch(() => null);
    }
  }

  /**
   * 读一个指标最近两个桶的值。
   *
   * @returns `current` 是当前分钟累计（仍在增长），`previous` 是上一分钟的封口值。
   */
  async read(name: MetricName, now = Date.now()): Promise<{ current: number; previous: number }> {
    const currentKey = this.bucketKey(name, now);
    const previousKey = this.bucketKey(name, now - BUCKET_MS);
    const [current, previous] = await Promise.all([
      this.state.get(currentKey).catch(() => null),
      this.state.get(previousKey).catch(() => null),
    ]);
    return {
      current: Number(current ?? 0) || 0,
      previous: Number(previous ?? 0) || 0,
    };
  }

  /** 记一次延迟样本（D5）。 */
  private async recordLatency(kind: HistogramKind, ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = histogramKey(kind, bucketIndexOf(ms), Date.now());
    await this.state.incr(key, HISTOGRAM_WINDOW_MS).catch(() => null);
  }

  /**
   * 汇总一次请求。所有子计数都在这里统一落库，调用点不必重复。
   *
   * @param observation 请求结束时的观测数据
   */
  async observe(observation: RequestObservation): Promise<void> {
    const failed = observation.status >= 400;
    await this.bump('request.total');
    if (failed) await this.bump('request.error');
    if (observation.stream) await this.bump('stream.total');
    if (observation.clientAborted) await this.bump('request.client_abort');
    if (observation.retries > 0) await this.bumpBy('request.retry', observation.retries);
    if (failed && observation.accountId) await this.bump('upstream.error');
    if (observation.status === 429) await this.bump('upstream.429');
    if (observation.status >= 500) await this.bump('upstream.5xx');
    if (!observation.settled) await this.bump('billing.settle_failed');

    // 延迟分布（D5）：分桶计数，1 小时窗口。失败静默。
    await this.recordLatency('latency', observation.latencyMs);
    if (observation.firstTokenMs !== null) {
      await this.recordLatency('first_token', observation.firstTokenMs);
    }

    // 慢请求与首 token 时间进日志：指标只能给数量，分布要靠日志侧聚合。
    // 注意：日志里**绝不含** API key（只记账号 id 与 endpoint）。
    if (observation.latencyMs > 60_000 || (observation.firstTokenMs ?? 0) > 30_000) {
      this.logger.warn(
        `llm-gateway: slow request endpoint=${observation.endpoint} model=${observation.model} ` +
          `latencyMs=${observation.latencyMs} firstTokenMs=${observation.firstTokenMs ?? -1} ` +
          `account=${observation.accountId ?? 'none'} stream=${observation.stream}`,
      );
    }
  }
}

/* ------------------------------ 延迟分布（D5） ------------------------------ */

/**
 * 延迟直方图的分桶上界（毫秒）。
 *
 * 为什么用直方图而不是存原始样本：state 里只有字符串计数（没有 list/zset），
 * 存样本等于在 Redis 里堆几十万条键。分桶的上界按「用户能感知的档位」选
 * （100ms 内很快、300ms 可接受、1s 开始不耐烦、5s 以上是故障），
 * 算出的 p50/p95 是**该档位的上界**，用于看趋势和告警足够，不用于 SLA 台账。
 */
export const LATENCY_BOUNDS_MS: readonly number[] = [
  50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000, 8000, 12_000, 20_000, 30_000, 60_000,
];

/** 直方图保留 1 小时（按小时分键，最多 16 个键/类，读取代价可控）。 */
const HISTOGRAM_WINDOW_MS = 60 * 60 * 1000;

export type HistogramKind = 'latency' | 'first_token';

export interface PercentileStats {
  /** 该分位对应的档位上界（ms）；样本为空时为 null。 */
  p50: number | null;
  p95: number | null;
  count: number;
}

function histogramKey(kind: HistogramKind, index: number, now: number): string {
  return `gw:hist:${kind}:${index}:${Math.floor(now / HISTOGRAM_WINDOW_MS)}`;
}

/** 延迟 → 分桶下标（大于最后一个上界时落到「溢出桶」）。 */
export function bucketIndexOf(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  for (let index = 0; index < LATENCY_BOUNDS_MS.length; index += 1) {
    if (ms <= (LATENCY_BOUNDS_MS[index] as number)) return index;
  }
  return LATENCY_BOUNDS_MS.length;
}

/**
 * 从分桶计数估算分位数。
 *
 * 返回命中档位的**上界**（不做桶内插值）：插值会造出「p95 = 733ms」这种
 * 比真实精度更细的假象，而我们的桶宽本来就不支持这个精度。
 */
export function percentileOfBuckets(counts: readonly number[], percentile: number): number | null {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const target = Math.max(1, Math.ceil((percentile / 100) * total));
  let cumulative = 0;
  for (let index = 0; index < counts.length; index += 1) {
    cumulative += counts[index] ?? 0;
    if (cumulative >= target) {
      // 溢出桶：返回最后一个上界（代表「≥ 60s」）。
      if (index >= LATENCY_BOUNDS_MS.length)
        return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1] as number;
      return LATENCY_BOUNDS_MS[index] as number;
    }
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1] as number;
}

/**
 * 读某类延迟的分位数（p50/p95 + 样本数）。
 *
 * 读 16 个键（并行），保留 1 小时。观测失败一律静默降级为「无样本」——
 * 看板不能因为 Redis 抖动而 500。
 */
export async function readLatencyStats(
  state: StateService,
  kind: HistogramKind,
  now = Date.now(),
): Promise<PercentileStats> {
  const counts = await Promise.all(
    Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, (_unused, index) =>
      state
        .get(histogramKey(kind, index, now))
        .then((value) => Number(value ?? 0) || 0)
        .catch(() => 0),
    ),
  );
  const total = counts.reduce((sum, value) => sum + value, 0);
  return {
    p50: percentileOfBuckets(counts, 50),
    p95: percentileOfBuckets(counts, 95),
    count: total,
  };
}

/** 供管理端一次性读全部指标（避免逐个 await 产生的 N 次往返）。 */
export async function readAllMetrics(
  state: StateService,
  names: readonly MetricName[],
  now = Date.now(),
): Promise<Record<string, { current: number; previous: number }>> {
  const metrics = new Metrics(state, {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  const out: Record<string, { current: number; previous: number }> = {};
  for (const name of names) {
    out[name] = await metrics.read(name, now);
  }
  return out;
}
