/**
 * 测试用内存版 `StateService`。
 *
 * 语义与内核实现保持一致，尤其是租约：
 * - `acquireLease` 按候选顺序取第一个有空位的池，满载池**不被触碰**；
 * - `renewLease` / `releaseLease` 只认自己的 `token`；
 * - `incr` 只在首次自增时设 TTL。
 *
 * 仅供 `*.test.ts` 使用（文件名不含 `.test.ts`，不会被 vitest 当作用例收集，
 * 也不会被打进 `dist`——构建只从 `index.ts` 入口打包）。
 */
import type { StateCandidate, StateLease, StateService } from '@stackpanel/sdk';

interface Entry {
  value: string;
  expiresAt: number;
}

export class InMemoryState implements StateService {
  private readonly store = new Map<string, Entry>();
  /** lease token -> { key, expiresAt } */
  private readonly leases = new Map<string, { key: string; expiresAt: number }>();
  /** 让某个 key 的 `incr` 抛错，用来验证「失败开放」。 */
  public failIncrFor: string | null = null;

  private now(): number {
    return Date.now();
  }

  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async consume(key: string): Promise<string | null> {
    const entry = this.live(key);
    this.store.delete(key);
    return entry?.value ?? null;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlMs && ttlMs > 0 ? this.now() + ttlMs : 0,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (this.failIncrFor === key) throw new Error('boom');
    const entry = this.live(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    this.store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? (ttlMs && ttlMs > 0 ? this.now() + ttlMs : 0),
    });
    return next;
  }

  async decr(key: string): Promise<number> {
    const entry = this.live(key);
    const next = Math.max(0, (entry ? Number(entry.value) : 0) - 1);
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? 0 });
    return next;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (this.live(key)) return null;
    const token = `lock-${Math.random().toString(36).slice(2)}`;
    this.store.set(key, { value: token, expiresAt: this.now() + ttlMs });
    return token;
  }

  async release(key: string, token: string): Promise<boolean> {
    const entry = this.live(key);
    if (!entry || entry.value !== token) return false;
    this.store.delete(key);
    return true;
  }

  async withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    const token = await this.acquire(key, ttlMs);
    if (!token) return false;
    try {
      await fn();
      return true;
    } finally {
      await this.release(key, token);
    }
  }

  private leaseCount(key: string): number {
    let count = 0;
    const now = this.now();
    for (const [token, info] of this.leases) {
      if (info.expiresAt !== 0 && info.expiresAt <= now) {
        this.leases.delete(token);
        continue;
      }
      if (info.key === key) count += 1;
    }
    return count;
  }

  async acquireLease(
    candidates: ReadonlyArray<StateCandidate>,
    ttlMs = 0,
  ): Promise<StateLease | null> {
    for (const candidate of candidates) {
      if (candidate.limit > 0 && this.leaseCount(candidate.key) >= candidate.limit) {
        continue; // 满载池不触碰
      }
      const token = `lease-${Math.random().toString(36).slice(2)}`;
      this.leases.set(token, {
        key: candidate.key,
        expiresAt: ttlMs > 0 ? this.now() + ttlMs : 0,
      });
      return { key: candidate.key, token };
    }
    return null;
  }

  async renewLease(lease: StateLease, ttlMs = 0): Promise<boolean> {
    const info = this.leases.get(lease.token);
    if (!info || info.key !== lease.key) return false;
    info.expiresAt = ttlMs > 0 ? this.now() + ttlMs : 0;
    return true;
  }

  async releaseLease(lease: StateLease): Promise<boolean> {
    const info = this.leases.get(lease.token);
    if (!info || info.key !== lease.key) return false;
    this.leases.delete(lease.token);
    return true;
  }

  /** 测试辅助：当前某池占用数。 */
  leaseCountFor(key: string): number {
    return this.leaseCount(key);
  }
}
