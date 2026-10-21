/**
 * 计费状态机契约测试（目标五）。
 *
 * 用内存版 `ExtensionClient` 与钱包 fake 驱动 `reserve → settle → release →
 * runCompensation` 全生命周期。锁死的纪律：
 * - 先建 usage log 再动钱包（否则会「扣了钱没账单」）；
 * - 结算失败**绝不静默吞**：台账转 COMPENSATING 且 `settled=false`，由补偿重试；
 * - 只有补偿超过上限才进 FAILED（唯一允许的明确欠费态）；
 * - usage 为 0 时全额释放预留（不是留一个 HELD 残影）；
 * - 台账写不进去时把已冻结的钱还回去。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  ExtensionClient,
  ExtensionInstance,
  ExtensionListResult,
  PluginContext,
  PluginLogger,
  StateService,
  WalletHold,
  WalletService,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context.js';
import {
  compensationDelay,
  estimateReserve,
  MAX_COMPENSATION_ATTEMPTS,
  release,
  reserve,
  runCompensation,
  settle,
  type BillingContext,
} from './billing.js';
import type { ModelPrice } from './pricing.js';
import { resolveServedPrice } from './pricing.js';

const silentLogger: PluginLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* ------------------------------ in-memory extension client ------------------------------ */

class FakeExtensions {
  private readonly rows = new Map<string, ExtensionInstance<Record<string, unknown>>>();
  private seq = 0;
  public failCreate = false;

  async create<T>(_model: unknown, spec: T): Promise<ExtensionInstance<T>> {
    if (this.failCreate) throw new Error('extension create failed');
    this.seq += 1;
    const name = `row-${this.seq}`;
    const now = new Date();
    const instance: ExtensionInstance<T> = {
      name,
      spec,
      status: null,
      ownerId: null,
      version: 1,
      labels: {},
      annotations: {},
      finalizers: [],
      createdAt: now,
      updatedAt: now,
      deletionTimestamp: null,
    };
    this.rows.set(name, instance as ExtensionInstance<Record<string, unknown>>);
    return instance;
  }

  async get<T>(_model: unknown, name: string): Promise<ExtensionInstance<T> | null> {
    return (this.rows.get(name) as ExtensionInstance<T> | undefined) ?? null;
  }

  async update<T>(_model: unknown, name: string, spec: T): Promise<ExtensionInstance<T>> {
    const current = this.rows.get(name);
    if (!current) throw new Error(`missing ${name}`);
    const next: ExtensionInstance<T> = {
      ...(current as unknown as ExtensionInstance<T>),
      spec,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.rows.set(name, next as unknown as ExtensionInstance<Record<string, unknown>>);
    return next;
  }

  async list<T>(
    _model: unknown,
    query: { where?: Record<string, { eq?: unknown }> },
  ): Promise<ExtensionListResult<T>> {
    let items = [...this.rows.values()] as unknown as ExtensionInstance<T>[];
    const where = query.where ?? {};
    for (const [field, condition] of Object.entries(where)) {
      if (condition && 'eq' in condition) {
        const wanted = condition.eq;
        items = items.filter(
          (item) => (item.spec as Record<string, unknown>)[field] === wanted,
        );
      }
    }
    return { items, total: items.length, page: 1, pageSize: items.length || 1 };
  }

  all(): Array<ExtensionInstance<Record<string, unknown>>> {
    return [...this.rows.values()];
  }
}

/* ------------------------------ fake wallet ------------------------------ */

class FakeWallet {
  balance = 1_000_000;
  held = 0;
  private seq = 0;
  private readonly holds = new Map<string, WalletHold>();
  /** (referenceType, referenceId) already applied → idempotency. */
  private readonly ledger = new Set<string>();
  public failNextDebit = false;

  private key(ref?: { referenceType: string; referenceId: string }): string {
    return ref ? `${ref.referenceType}:${ref.referenceId}` : `anon:${this.seq}`;
  }

  async hold(
    userId: string,
    amount: number,
    currency: string,
    ref: { referenceType: string; referenceId: string },
    options?: { ttlMs?: number },
  ): Promise<WalletHold> {
    const key = this.key(ref);
    const existing = [...this.holds.values()].find(
      (h) => `${h.referenceType}:${h.referenceId}` === key,
    );
    if (existing) return existing;
    if (amount > this.balance) throw new Error('钱包余额不足');
    this.seq += 1;
    const hold: WalletHold = {
      id: `hold-${this.seq}`,
      userId,
      currency,
      amount,
      status: 'HELD',
      settledAmount: null,
      referenceType: ref.referenceType,
      referenceId: ref.referenceId,
      note: null,
      expiresAt: new Date(Date.now() + (options?.ttlMs ?? 60_000)),
      settledAt: null,
      createdAt: new Date(),
    };
    this.holds.set(hold.id, hold);
    this.balance -= amount;
    this.held += amount;
    return hold;
  }

  async settleHold(
    holdId: string,
    settledAmount: number,
    ref?: { referenceType: string; referenceId: string },
  ): Promise<WalletHold | null> {
    const hold = this.holds.get(holdId);
    if (!hold || hold.status !== 'HELD') return hold ?? null;
    hold.status = 'SETTLED';
    hold.settledAmount = settledAmount;
    hold.settledAt = new Date();
    this.held -= hold.amount;
    this.balance += hold.amount - settledAmount;
    if (ref) this.ledger.add(this.key(ref));
    return hold;
  }

  async releaseHold(holdId: string): Promise<WalletHold | null> {
    const hold = this.holds.get(holdId);
    if (!hold || hold.status !== 'HELD') return hold ?? null;
    hold.status = 'RELEASED';
    this.held -= hold.amount;
    this.balance += hold.amount;
    return hold;
  }

  async debit(
    _userId: string,
    amount: number,
    _currency: string,
    ref: { referenceType: string; referenceId: string },
  ): Promise<{ balance: number }> {
    const key = this.key(ref);
    if (this.ledger.has(key)) return { balance: this.balance };
    if (this.failNextDebit) {
      this.failNextDebit = false;
      throw new Error('debit boom');
    }
    if (amount > this.balance) throw new Error('钱包余额不足');
    this.balance -= amount;
    this.ledger.add(key);
    return { balance: this.balance };
  }

  holdStatus(id: string): string | undefined {
    return this.holds.get(id)?.status;
  }
}

function makeContext(extensions: FakeExtensions, wallet: FakeWallet): void {
  bindContext({
    extensions: extensions as unknown as ExtensionClient,
    wallet: wallet as unknown as WalletService,
    state: {} as StateService,
    tx: (fn: (tx: unknown) => Promise<unknown>) => fn({ extensions, wallet }),
    logger: silentLogger,
    auth: {},
    secrets: {},
  } as unknown as PluginContext);
}

const price: ModelPrice = { inputPrice: 1_000, outputPrice: 2_000, multiplier: 100 };
const served = resolveServedPrice([{ model: 'test-model', ...price }], 'test-model');

function reserveInput(overrides: Partial<Parameters<typeof reserve>[0]> = {}) {
  return {
    wallet: undefined as unknown as WalletService,
    logger: silentLogger,
    userId: 'user-1',
    apiKeyId: 'key-1',
    accountId: null,
    model: 'test-model',
    currency: 'CNY',
    price: served,
    amount: 100,
    ...overrides,
  };
}

let extensions: FakeExtensions;
let wallet: FakeWallet;

beforeEach(() => {
  extensions = new FakeExtensions();
  wallet = new FakeWallet();
  makeContext(extensions, wallet);
});

afterEach(() => {
  resetContext();
});

describe('estimateReserve', () => {
  it('reserves the max_tokens ceiling', () => {
    const amount = estimateReserve({ price, bodyText: 'hi', maxTokens: 10_000 });
    // 10_000 输出 * 2000/1e6 = 20 分（prompt 很小，向上取整后近似）。
    expect(amount).toBeGreaterThanOrEqual(20);
  });

  it('falls back to a default ceiling when max_tokens is absent', () => {
    const amount = estimateReserve({ price, bodyText: 'hi' });
    expect(amount).toBeGreaterThan(0);
  });

  it('folds image count and audio seconds into the reservation (W3)', () => {
    const media: ModelPrice = {
      inputPrice: 0,
      outputPrice: 0,
      multiplier: 100,
      imagePrice: 500,
      audioPrice: 50,
    };
    const amount = estimateReserve({
      price: media,
      bodyText: '',
      maxTokens: 1,
      imageCount: 2,
      audioSeconds: 30,
    });
    // 2*500 + 30*50 = 2500（外加极小 token 部分向上取整）。
    expect(amount).toBe(2500);
  });
});

describe('reserve', () => {
  it('freezes the amount and records a RESERVED ledger entry', async () => {
    const input = reserveInput();
    const context = await reserve({ ...input, wallet: wallet as unknown as WalletService });

    expect(context.hold?.status).toBe('HELD');
    expect(wallet.held).toBe(100);
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('RESERVED');
  });

  it('skips the hold when the estimated amount is zero but still records an entry', async () => {
    const input = reserveInput();
    const context = await reserve({
      ...input,
      wallet: wallet as unknown as WalletService,
      amount: 0,
    });
    expect(context.hold).toBeNull();
    expect(wallet.held).toBe(0);
    expect(context.entryId).not.toBeNull();
  });

  it('passes the configured hold TTL through to the wallet', async () => {
    const input = reserveInput();
    const context = await reserve({
      ...input,
      wallet: wallet as unknown as WalletService,
      ttlMs: 123_000,
    });
    const remaining = (context.hold!.expiresAt.getTime() - Date.now()) / 1000;
    // 应接近 123s，而不是内核默认的 60s（fake 默认）。
    expect(remaining).toBeGreaterThan(100);
  });

  it('releases the hold when the ledger entry cannot be written', async () => {
    extensions.failCreate = true;
    const input = reserveInput();
    await expect(
      reserve({ ...input, wallet: wallet as unknown as WalletService }),
    ).rejects.toThrow();
    // 冻结已归还，没有留下 HELD 残影。
    expect(wallet.held).toBe(0);
  });
});

describe('settle', () => {
  async function reserved(amount = 100): Promise<BillingContext> {
    const input = reserveInput();
    return reserve({ ...input, wallet: wallet as unknown as WalletService, amount });
  }

  it('settles the hold and marks the entry SETTLED', async () => {
    const context = await reserved();
    const result = await settle({
      wallet: wallet as unknown as WalletService,
      logger: silentLogger,
      context,
      usage: { promptTokens: 0, completionTokens: 100, totalTokens: 100 },
      estimated: false,
      protocol: 'openai-chat',
      endpoint: 'chat.completions',
      status: 'SUCCESS',
    });

    expect(result.settled).toBe(true);
    expect(result.amount).toBeGreaterThan(0);
    expect(wallet.holdStatus(context.hold!.id)).toBe('SETTLED');
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('SETTLED');
    // 预留 100，实际结算 = amount；差额已退回。
    expect(wallet.held).toBe(0);
  });

  it('releases the full hold and marks RELEASED when usage is zero', async () => {
    const context = await reserved();
    const result = await settle({
      wallet: wallet as unknown as WalletService,
      logger: silentLogger,
      context,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      estimated: false,
      protocol: 'openai-chat',
      endpoint: 'chat.completions',
      status: 'ERROR',
    });

    expect(result.amount).toBe(0);
    expect(wallet.holdStatus(context.hold!.id)).toBe('SETTLED'); // settleHold(0)
    expect(wallet.held).toBe(0);
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('RELEASED');
  });

  it('never silently swallows a settlement failure: entry becomes COMPENSATING', async () => {
    const context = await reserved();
    // 让钱包结算抛错：holdId 指向一个不存在/非 HELD 的 hold 不会抛，改用 debit 路径。
    const failing = {
      ...(wallet as unknown as WalletService),
      settleHold: () => Promise.reject(new Error('wallet down')),
    } as unknown as WalletService;

    const result = await settle({
      wallet: failing,
      logger: silentLogger,
      context,
      usage: { promptTokens: 0, completionTokens: 100, totalTokens: 100 },
      estimated: false,
      protocol: 'openai-chat',
      endpoint: 'chat.completions',
      status: 'SUCCESS',
    });

    expect(result.settled).toBe(false);
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('COMPENSATING');
    expect(Number(entry?.spec['attempt'])).toBe(1);
    expect(Number(entry?.spec['nextAttemptAt'])).toBeGreaterThan(Date.now());
    // hold 未被结算，仍是 HELD（等待补偿）。
    expect(wallet.holdStatus(context.hold!.id)).toBe('HELD');
  });

  it('records the true amount (not 0) on a failed settle so compensation never overcharges', async () => {
    // 预扣上限 100，但真实用量只值 1 分。若结算失败时把 settledAmount 写成 0，
    // 补偿会回退到整笔 reservedAmount(100) 重扣——这就是超额扣费。
    const context = await reserved(100);
    const failing = {
      ...(wallet as unknown as WalletService),
      settleHold: () => Promise.reject(new Error('wallet down')),
    } as unknown as WalletService;

    const result = await settle({
      wallet: failing,
      logger: silentLogger,
      context,
      usage: { promptTokens: 0, completionTokens: 100, totalTokens: 100 },
      estimated: false,
      protocol: 'openai-chat',
      endpoint: 'chat.completions',
      status: 'SUCCESS',
    });

    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('COMPENSATING');
    expect(Number(entry?.spec['settledAmount'])).toBe(result.amount);
    expect(Number(entry?.spec['settledAmount'])).toBeLessThan(100);

    // 补偿成功后，实际扣款必须是真实金额而非预留上限。
    // 初始余额 1_000_000：预留后为 -100，补偿 settleHold(amount) 退还 (100-amount)，
    // 净扣款 == amount。
    await runCompensation(wallet as unknown as WalletService, silentLogger, Date.now() + 10_000);
    expect(1_000_000 - wallet.balance).toBe(result.amount);
    expect(wallet.held).toBe(0);
  });
});

describe('release', () => {
  it('releases the hold without writing a usage log', async () => {
    const input = reserveInput();
    const context = await reserve({ ...input, wallet: wallet as unknown as WalletService });
    await release(wallet as unknown as WalletService, silentLogger, context);

    expect(wallet.holdStatus(context.hold!.id)).toBe('RELEASED');
    expect(wallet.held).toBe(0);
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('RELEASED');
  });
});

describe('runCompensation', () => {
  async function pending(): Promise<BillingContext> {
    const input = reserveInput();
    const context = await reserve({ ...input, wallet: wallet as unknown as WalletService });
    // 制造一条 COMPENSATING 台账（结算失败路径）。
    await settle({
      wallet: {
        ...(wallet as unknown as WalletService),
        settleHold: () => Promise.reject(new Error('wallet down')),
      } as unknown as WalletService,
      logger: silentLogger,
      context,
      usage: { promptTokens: 0, completionTokens: 100, totalTokens: 100 },
      estimated: false,
      protocol: 'openai-chat',
      endpoint: 'chat.completions',
      status: 'SUCCESS',
    });
    return context;
  }

  it('settles a pending compensation and marks it COMPENSATED', async () => {
    const context = await pending();
    const result = await runCompensation(
      wallet as unknown as WalletService,
      silentLogger,
      Date.now() + 10_000,
    );

    expect(result.processed).toBe(1);
    expect(result.settled).toBe(1);
    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('COMPENSATED');
  });

  it('advances the attempt on failure and eventually marks FAILED (explicit debt state)', async () => {
    const context = await pending();
    const broken = {
      ...(wallet as unknown as WalletService),
      hold: () => Promise.reject(new Error('still down')),
      settleHold: () => Promise.reject(new Error('still down')),
      debit: () => Promise.reject(new Error('still down')),
    } as unknown as WalletService;

    // 反复重试直到超过上限。每次推进时钟，跨过刚写入的 nextAttemptAt。
    let clock = Date.now();
    for (let i = 0; i < MAX_COMPENSATION_ATTEMPTS + 2; i += 1) {
      clock += 10 * 60 * 1000;
      await runCompensation(broken, silentLogger, clock);
    }

    const entry = extensions.all().find((row) => row.spec['referenceId'] === context.referenceId);
    expect(entry?.spec['status']).toBe('FAILED');
    expect(Number(entry?.spec['attempt'])).toBeGreaterThanOrEqual(MAX_COMPENSATION_ATTEMPTS);
  });

  it('skips entries whose retry time has not arrived', async () => {
    await pending();
    const result = await runCompensation(wallet as unknown as WalletService, silentLogger, 0);
    expect(result.processed).toBe(0);
  });
});

describe('compensationDelay', () => {
  it('backs off exponentially and is capped at five minutes', () => {
    expect(compensationDelay(1)).toBe(1_000);
    expect(compensationDelay(2)).toBe(2_000);
    expect(compensationDelay(3)).toBe(4_000);
    expect(compensationDelay(20)).toBe(5 * 60 * 1000);
  });
});
