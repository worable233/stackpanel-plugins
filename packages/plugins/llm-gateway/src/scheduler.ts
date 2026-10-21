/**
 * 调度与并发控制（目标六）。
 *
 * 全部计数与准入都走 `StateService`（内核契约，Redis 实现），**绝不**用进程内
 * 变量：多实例部署下进程内计数会让实际限流值变成「配置值 × 实例数」。
 *
 * 提供的维度：
 * - RPM：key / 用户 / 模型 / provider 四级固定窗口；
 * - 并发：key / 账号 / provider / 全局四级，用内核 `acquireLease` 原子取位；
 * - 优先级与加权随机：账号池排序（复用旧 `weightedOrder` 语义）；
 * - 健康：连续失败记分、429/5xx 冷却、熔断开路与半开探针；
 * - 长流租约续期：`LeaseKeeper` 按 TTL/2 周期续约，续约失败说明位子已丢。
 *
 * 失败策略一律「失败开放还是失败关闭」要显式选：限流计数读不到时**放行**
 * （宁可少限一次，也不要因为 Redis 抖动把全站请求 429 掉）；并发租约拿不到时
 * **拒绝**（位子是资源，拿不到就是拿不到）。
 */

import type { StateLease, StateService } from '@stackpanel/sdk';

/** 一次准入请求涉及的所有维度。 */
export interface AdmissionRequest {
  keyId: string;
  userId: string;
  model: string;
  provider: string | null;
  /** 每 key 每分钟请求上限；0 = 不限。 */
  keyRpm: number;
  /** 该 key 的并发上限；0 = 不限。 */
  keyConcurrency: number;
  /** 站点级用户 RPM；0 = 不限。 */
  userRpm: number;
  /** 站点级模型 RPM；0 = 不限。 */
  modelRpm: number;
  /** 站点级 provider RPM；0 = 不限。 */
  providerRpm: number;
  /** 全局并发上限；0 = 不限。 */
  globalConcurrency: number;
}

/** 准入结果：允许时带上需要释放/续期的租约。 */
export type AdmissionResult =
  | { ok: true; leases: StateLease[] }
  | { ok: false; status: number; code: string; message: string; retryAfterSeconds?: number };

/** 一个限流窗口。 */
export interface RateWindow {
  /** 状态键前缀（已含实体 id）。 */
  key: string;
  limit: number;
  /** 窗口毫秒数。 */
  windowMs: number;
}

/** 默认租约 TTL（并发位）。 */
export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;

/** 冷却的默认时长：上游没给 Retry-After 时用它。 */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** 熔断器参数。 */
export interface BreakerConfig {
  /** 连续失败多少次开路。 */
  failureThreshold: number;
  /** 开路时长（此后进入半开，放一个探针）。 */
  openMs: number;
  /** 成功多少次从半开恢复闭合。 */
  successThreshold: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 5,
  openMs: 30_000,
  successThreshold: 1,
};

/** 账号健康快照（管理端展示 + 选号过滤）。 */
export interface AccountHealth {
  /** 连续失败次数。 */
  failures: number;
  /** 熔断开路截止时间戳（ms）；0 表示闭合。 */
  openUntil: number;
  /** 429/错误冷却截止时间戳（ms）；0 表示无冷却。 */
  cooldownUntil: number;
  /** 最近一次成功时间戳。 */
  lastSuccessAt: number;
  /** 最近一次失败原因（脱敏后）。 */
  lastError: string | null;
}

const EMPTY_HEALTH: AccountHealth = {
  failures: 0,
  openUntil: 0,
  cooldownUntil: 0,
  lastSuccessAt: 0,
  lastError: null,
};

/**
 * 调度器。无状态（所有状态在后端），可安全地为每个请求构造或全局共享。
 */
export class Scheduler {
  constructor(
    private readonly state: StateService,
    private readonly breaker: BreakerConfig = DEFAULT_BREAKER,
  ) {}

  /**
   * 四级 RPM 检查。任一超限即拒绝，并给出 `Retry-After`。
   *
   * 用固定窗口（`incr` + TTL）：实现简单、对 Redis 只一次往返、与内核既有的
   * `state.incr` 契约一致。滑动窗口精度更高但对每个维度要两次往返，收益不抵成本。
   */
  async checkRpm(request: AdmissionRequest): Promise<AdmissionResult> {
    const windows: RateWindow[] = [
      { key: `gw:rpm:key:${request.keyId}`, limit: request.keyRpm, windowMs: 60_000 },
      { key: `gw:rpm:user:${request.userId}`, limit: request.userRpm, windowMs: 60_000 },
      { key: `gw:rpm:model:${request.model}`, limit: request.modelRpm, windowMs: 60_000 },
    ];
    if (request.provider) {
      windows.push({
        key: `gw:rpm:provider:${request.provider}`,
        limit: request.providerRpm,
        windowMs: 60_000,
      });
    }

    for (const window of windows) {
      if (window.limit <= 0) continue;
      const hits = await this.state.incr(window.key, window.windowMs).catch(() => null);
      // 读不到计数时放行（失败开放）：Redis 抖动不应导致全站 429。
      if (hits === null) continue;
      if (hits > window.limit) {
        const retryAfter = Math.max(1, Math.ceil(window.windowMs / 1000));
        return {
          ok: false,
          status: 429,
          code: 'rate_limited',
          message: `请求过于频繁（${window.limit} 次/分钟）`,
          retryAfterSeconds: retryAfter,
        };
      }
    }
    return { ok: true, leases: [] };
  }

  /**
   * provider 维度的固定窗口 RPM（**仅此一维**）。
   *
   * 为什么单独拆出来：provider 只有在**选完账号**之后才知道（账号行携带
   * provider），而 `checkRpm` 发生在选号之前——那时 `request.provider` 恒为 null，
   * provider 窗口永远不生效。这里在选中账号后补一次，且**只**累加 provider 计数，
   * 不复用 `checkRpm`（否则 key/user/model 会被重复 +1）。
   *
   * 失败开放与 `checkRpm` 一致：读不到计数就放行。
   */
  async checkProviderRpm(provider: string | null, limit: number): Promise<AdmissionResult> {
    return this.checkNamedWindow(
      provider ? `gw:rpm:provider:${provider}` : null,
      limit,
      '该渠道',
    );
  }

  /**
   * 账号自身的 RPM（账号行 `rpmLimit`）。同样只能在选号之后检查。
   * 过去该字段在管理端可配、却从不生效——这里补上，避免「配了没用」。
   */
  async checkAccountRpm(accountId: string | null, limit: number): Promise<AdmissionResult> {
    return this.checkNamedWindow(
      accountId ? `gw:rpm:account:${accountId}` : null,
      limit,
      '该上游账号',
    );
  }

  /** 单个固定窗口的通用检查（失败开放）。 */
  private async checkNamedWindow(
    key: string | null,
    limit: number,
    label: string,
  ): Promise<AdmissionResult> {
    if (!key || limit <= 0) return { ok: true, leases: [] };
    const hits = await this.state.incr(key, 60_000).catch(() => null);
    if (hits === null) return { ok: true, leases: [] };
    if (hits > limit) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        message: `${label}请求过于频繁（${limit} 次/分钟）`,
        retryAfterSeconds: 60,
      };
    }
    return { ok: true, leases: [] };
  }

  /**
   * 并发准入：key / 全局一次取位（账号位由选号逻辑单独取，因为它要按优先级
   * 在候选池里挑）。拿不到就拒绝——位子是资源，失败必须关闭。
   */
  async checkConcurrency(request: AdmissionRequest): Promise<AdmissionResult> {
    const candidates: Array<{ key: string; limit: number }> = [];
    if (request.keyConcurrency > 0) {
      candidates.push({ key: `gw:key:${request.keyId}:inflight`, limit: request.keyConcurrency });
    }
    if (request.globalConcurrency > 0) {
      candidates.push({ key: 'gw:global:inflight', limit: request.globalConcurrency });
    }
    if (candidates.length === 0) return { ok: true, leases: [] };

    const lease = await this.state.acquireLease(candidates, DEFAULT_LEASE_TTL_MS).catch(() => null);
    if (!lease) {
      return {
        ok: false,
        status: 429,
        code: 'concurrency_limited',
        message: '并发超出限制',
        retryAfterSeconds: 5,
      };
    }
    return { ok: true, leases: [lease] };
  }

  /**
   * 账号池并发取位：按给定顺序（优先级 + 加权随机已展开）整批一次往返，
   * 内核挑第一个有空位的池。满载池不会被触碰。
   */
  async acquireAccountLease(
    ordered: ReadonlyArray<{ id: string; maxConcurrency: number }>,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): Promise<{ accountId: string; lease: StateLease } | null> {
    if (ordered.length === 0) return null;
    const lease = await this.state
      .acquireLease(
        ordered.map((account) => ({
          key: `gw:acct:${account.id}:inflight`,
          limit: account.maxConcurrency,
        })),
        ttlMs,
      )
      .catch(() => null);
    if (!lease) return null;
    const match = ordered.find((account) => `gw:acct:${account.id}:inflight` === lease.key);
    if (!match) {
      await this.state.releaseLease(lease).catch(() => false);
      return null;
    }
    return { accountId: match.id, lease };
  }

  /**
   * 归还账号并发位。
   *
   * 只在本请求**确实没把请求发出去**时调用；正常的成功/失败路径由 relay 的
   * finally 统一释放。这里单独暴露是为了让选号失败后的清理不必接触 state。
   */
  async releaseAccountLease(lease: StateLease): Promise<boolean> {
    return this.state.releaseLease(lease).catch(() => false);
  }

  /* ------------------------------ 健康 / 冷却 / 熔断 ------------------------------ */

  private healthKey(accountId: string): string {
    return `gw:health:${accountId}`;
  }

  /** 读账号健康快照（读不到返回全零，视为健康）。 */
  async getHealth(accountId: string): Promise<AccountHealth> {
    const raw = await this.state.get(this.healthKey(accountId)).catch(() => null);
    if (!raw) return { ...EMPTY_HEALTH };
    try {
      const parsed = JSON.parse(raw) as Partial<AccountHealth>;
      return {
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
        openUntil: typeof parsed.openUntil === 'number' ? parsed.openUntil : 0,
        cooldownUntil: typeof parsed.cooldownUntil === 'number' ? parsed.cooldownUntil : 0,
        lastSuccessAt: typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : 0,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      return { ...EMPTY_HEALTH };
    }
  }

  private async writeHealth(
    accountId: string,
    health: AccountHealth,
    ttlMs = 24 * 60 * 60 * 1000,
  ): Promise<void> {
    await this.state.set(this.healthKey(accountId), JSON.stringify(health), ttlMs).catch(() => undefined);
  }

  /** 账号当前是否可服务（冷却与熔断都在未到时不可用）。 */
  async isServable(accountId: string): Promise<boolean> {
    const health = await this.getHealth(accountId);
    const now = Date.now();
    if (health.openUntil > now) {
      // 熔断到点后进入半开：放行一个探针。这里靠「谁先读到就谁先探」，
      // 不做严格单探针（严格化要额外一次锁，收益不抵成本）。
      return false;
    }
    if (health.cooldownUntil > now) return false;
    return true;
  }

  /** 记录一次成功：清零失败计数、闭合熔断。 */
  async recordSuccess(accountId: string): Promise<void> {
    await this.writeHealth(accountId, {
      failures: 0,
      openUntil: 0,
      cooldownUntil: 0,
      lastSuccessAt: Date.now(),
      lastError: null,
    });
  }

  /**
   * 记录一次失败。
   *
   * @param retryable 是否属于「上游自身故障」（5xx / 网络 / 超时）。只有这种才
   *   记入熔断计数：用户把 max_tokens 写超了导致的 400 不该把账号打熔断。
   * @param retryAfterSeconds 上游给的 Retry-After，优先于默认冷却。
   */
  async recordFailure(
    accountId: string,
    error: string,
    options: { retryable: boolean; retryAfterSeconds?: number | null } = { retryable: true },
  ): Promise<void> {
    const health = await this.getHealth(accountId);
    const now = Date.now();
    const cooldownMs =
      options.retryAfterSeconds && options.retryAfterSeconds > 0
        ? options.retryAfterSeconds * 1000
        : DEFAULT_COOLDOWN_MS;

    if (!options.retryable) {
      // 非上游故障：不动熔断计数，但仍记最后错误供运维排查。
      await this.writeHealth(accountId, {
        ...health,
        lastError: error.slice(0, 200),
      });
      return;
    }

    const failures = health.failures + 1;
    const openUntil =
      failures >= this.breaker.failureThreshold ? now + this.breaker.openMs : health.openUntil;
    await this.writeHealth(accountId, {
      failures,
      openUntil,
      cooldownUntil: Math.max(health.cooldownUntil, now + cooldownMs),
      lastSuccessAt: health.lastSuccessAt,
      lastError: error.slice(0, 200),
    });
  }

  /** 运维手动禁用/启用（管理端用）。禁用表现为一个很长的冷却。 */
  async setManualDisabled(accountId: string, disabled: boolean): Promise<void> {
    const health = await this.getHealth(accountId);
    await this.writeHealth(accountId, {
      ...health,
      cooldownUntil: disabled ? Date.now() + 10 * 60 * 1000 * 1000 : 0,
    });
  }
}

/**
 * 长流租约续期器（目标四 3）。
 *
 * 固定 TTL 的问题是：一个 10 分钟以上的流会在中途丢掉并发位，于是实际并发
 * 冲破上限。做法是按 TTL/2 周期 `renewLease`；续约失败说明位子已被别人拿走
 * （或 Redis 清了状态），此时应当让调用方知道——但不能粗暴掐断已经输出一半的
 * 流（那对用户是更坏的体验），所以只上报状态，由调用方决定。
 */
export class LeaseKeeper {
  private timer: NodeJS.Timeout | null = null;
  private lost = false;

  constructor(
    private readonly state: StateService,
    private readonly leases: readonly StateLease[],
    private readonly ttlMs: number,
    private readonly onLost?: (lease: StateLease) => void,
  ) {}

  /** 开始周期续期。 */
  start(): void {
    if (this.timer || this.leases.length === 0 || this.ttlMs <= 0) return;
    const interval = Math.max(1000, Math.floor(this.ttlMs / 2));
    this.timer = setInterval(() => {
      void this.renewAll();
    }, interval);
    // 不要让续期定时器把进程钉在事件循环上（服务端进程由内核托管）。
    this.timer.unref?.();
  }

  private async renewAll(): Promise<void> {
    for (const lease of this.leases) {
      const ok = await this.state.renewLease(lease, this.ttlMs).catch(() => false);
      if (!ok) {
        this.lost = true;
        this.onLost?.(lease);
      }
    }
  }

  /** 是否已经丢失过租约（供计费/审计标注「本次长流的并发位中途失效」）。 */
  get leaseLost(): boolean {
    return this.lost;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** 按 weight 加权随机排序（保留旧实现语义：weight 越大越靠前）。 */
export function weightedOrder<T extends { weight: number }>(items: readonly T[]): T[] {
  const pool = items.map((item) => ({
    item,
    key: Math.random() / Math.max(1, item.weight),
  }));
  pool.sort((a, b) => a.key - b.key);
  return pool.map((entry) => entry.item);
}
