import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext, ProviderServiceContext } from '@stackpanel/sdk';
import { ZJMFProvider, normalizeStatus, normalizePowerState } from './provider.js';
import { getUpstream } from './repository.js';
import { provisioningJournalModel, provisioningCartLockModel } from './data.js';

vi.mock('./repository.js', () => ({
  getUpstream: vi.fn(),
  readUpstreamBinding: vi.fn(),
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function minimalCtx(): PluginContext {
  return {
    manifest: { id: 'zjmf-upstream', name: '魔方上游', version: '0.2.0' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    events: {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T, _terminal: (value: T) => T): T => value,
    },
    db: {},
    extensions: {} as never,
    tx: (async () => {
      throw new Error('no tx in this test');
    }) as never,
    secrets: {
      isAvailable: () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    payments: {} as never,
    wallet: {} as never,
    fx: {} as never,
    auth: {} as never,
    notifications: {} as never,
    effect: () => () => {},
    provide: () => () => {},
    getService: () => undefined,
    requireService: () => {
      throw new Error('no service');
    },
    registerExtension: () => () => {},
    getExtensions: () => [],
  };
}

describe('durable upstream provisioning fence', () => {
  function fixture() {
    type Row = { name: string; spec: Record<string, unknown>; version: number };
    const rows = new Map<string, Row>();
    const key = (model: { kind: string }, name: string) => `${model.kind}:${name}`;
    const extensions = {
      get: async (model: { kind: string }, name: string) =>
        structuredClone(rows.get(key(model, name)) ?? null),
      create: async (
        model: { kind: string },
        spec: Record<string, unknown>,
        options: { name: string },
      ) => {
        if (rows.has(key(model, options.name))) throw new Error('unique violation');
        const row = { name: options.name, spec: structuredClone(spec), version: 1 };
        rows.set(key(model, options.name), row);
        return structuredClone(row);
      },
      update: async (
        model: { kind: string },
        name: string,
        spec: Record<string, unknown>,
        options?: { expectedVersion?: number },
      ) => {
        const row = rows.get(key(model, name));
        if (
          !row ||
          (options?.expectedVersion !== undefined && options.expectedVersion !== row.version)
        )
          throw new Error('version conflict');
        row.spec = structuredClone(spec);
        row.version++;
        return structuredClone(row);
      },
      delete: async (model: { kind: string }, name: string) => {
        rows.delete(key(model, name));
      },
    };
    const ctx = minimalCtx();
    ctx.extensions = extensions as never;
    let tail = Promise.resolve();
    ctx.tx = (async (fn: (tx: { extensions: typeof extensions }) => Promise<unknown>) => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await prior;
      const backup = structuredClone(rows);
      try {
        return await fn({ extensions });
      } catch (error) {
        rows.clear();
        for (const [k, v] of backup) rows.set(k, v);
        throw error;
      } finally {
        release();
      }
    }) as never;
    const createService = vi.fn(
      async (
        _id: string,
        options: {
          checkpoint?: (service: {
            providerServiceId: string;
            runtime: Record<string, unknown>;
          }) => Promise<void>;
        },
      ) => {
        const result = {
          providerServiceId: 'remote-42',
          credentials: {},
          runtime: { invoiceId: 'invoice-7', paymentState: 'PAID', paid: true },
        };
        await options.checkpoint?.({
          ...result,
          runtime: { ...result.runtime, paymentState: 'ORDER_CREATED', paid: false },
        });
        return result;
      },
    );
    const payServiceInvoice = vi.fn(async () => ({ paid: true, paymentState: 'PAID' }));
    const verifyCancelledInvoice = vi.fn(async () => {});
    // 默认「账单已付」：让既有用例保持「不重复付款」的语义；需要自动续付的用例单独覆写。
    const listRecentInvoices = vi.fn(async () => null);
    const hostRow = (serviceId: string) => ({
      id: serviceId,
      productId: null,
      name: serviceId,
      productName: null,
      status: 'Active',
      statusLabel: null,
      host: null,
      expiresAt: null,
      openedAt: null,
      amount: null,
      currency: null,
      raw: { id: serviceId, invoice_id: 'invoice-7', regdate: Math.floor(Date.now() / 1000) },
    });
    const findHost = vi.fn(async (serviceId: string) => hostRow(serviceId));
    const resolveHostForAttempt = vi.fn(async () => hostRow('remote-42'));
    const inspectInvoice = vi.fn(async (invoiceId: string) => ({
      invoiceId,
      status: 'Paid',
      paid: true,
      cancelled: false,
      serviceIds: ['remote-42'],
      amount: null,
    }));
    const provider = new ZJMFProvider(ctx);
    vi.spyOn(provider as never, 'resolveForProduct').mockResolvedValue({
      client: {
        createService,
        payServiceInvoice,
        verifyCancelledInvoice,
        listRecentInvoices,
        inspectInvoice,
        findHost,
        findHostForInvoice: vi.fn(async () => hostRow('remote-42')),
        resolveHostForAttempt,
      },
      upstreamId: 'upstream-1',
      sourceFingerprint: 'account-1',
    } as never);
    const input = {
      orderId: 'order-1',
      userId: 'user-1',
      productId: 'local-product',
      product: {
        id: 'local-product',
        name: 'Cloud',
        price: 100,
        currency: 'CNY',
        providerId: 'zjmf',
        providerProductId: '4661',
        metadata: null,
      },
      quantity: 1,
      secrets: ctx.secrets,
      checkpoint: vi.fn(async () => {}),
    };
    return {
      provider,
      input,
      createService,
      payServiceInvoice,
      verifyCancelledInvoice,
      listRecentInvoices,
      inspectInvoice,
      findHost,
      resolveHostForAttempt,
      rows,
      extensions,
    };
  }
  it('never accepts recovery without a durable original invoice, including legacy requests', async () => {
    const { provider, input, createService } = fixture();
    await expect(
      provider.verifyCancelledProvision({ ...input, recoveryGeneration: 1 }),
    ).rejects.toThrow(/缺少原请求/);
    expect(createService).not.toHaveBeenCalled();
  });
  it('rejects a matching invoice number after the upstream account changes', async () => {
    const { provider, input, rows, verifyCancelledInvoice } = fixture();
    await provider.provision(input);
    const original = [...rows.values()].find((row) => row.name !== 'upstream-1')!;
    original.spec.sourceFingerprint = 'another-account';
    await expect(
      provider.verifyCancelledProvision({ ...input, recoveryGeneration: 1 }),
    ).rejects.toThrow(/账号/);
    expect(verifyCancelledInvoice).not.toHaveBeenCalled();
  });
  it('rechecks all previous generations before creating a new request and never deletes old fences', async () => {
    const { provider, input, rows, createService, verifyCancelledInvoice } = fixture();
    await provider.provision(input);
    const original = [...rows.values()].find((row) => row.name !== 'upstream-1')!;
    original.spec.state = 'PAYMENT_REQUIRED';
    original.spec.runtime = { invoiceId: 'invoice-7', paid: false };
    const evidence = await provider.verifyCancelledProvision({ ...input, recoveryGeneration: 1 });
    expect(evidence.requests).toHaveLength(1);
    expect(createService).toHaveBeenCalledTimes(1);
    verifyCancelledInvoice.mockRejectedValueOnce(new Error('original invoice was paid'));
    await expect(provider.provision({ ...input, recoveryGeneration: 1 })).rejects.toThrow(
      'original invoice was paid',
    );
    expect(createService).toHaveBeenCalledTimes(1);
    await provider.provision({ ...input, recoveryGeneration: 1 });
    await provider.provision({ ...input, recoveryGeneration: 1 });
    expect(createService).toHaveBeenCalledTimes(2);
    expect(
      [...rows.keys()].filter((key) => key.startsWith(provisioningJournalModel.kind)),
    ).toHaveLength(2);
    await expect(
      provider.verifyCancelledProvision({ ...input, recoveryGeneration: 2 }),
    ).rejects.toThrow(/曾确认付款/);
  });
  it('creates once across concurrent invocations and restores identity on replay', async () => {
    const { provider, input, createService, rows } = fixture();
    const outcomes = await Promise.allSettled([
      provider.provision(input),
      provider.provision(input),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(createService).toHaveBeenCalledTimes(1);
    const restored = await provider.provision(input);
    expect(restored.providerServiceId).toBe('remote-42');
    expect(createService).toHaveBeenCalledTimes(1);
    expect(
      [...rows.keys()].filter((key) => key.startsWith(provisioningCartLockModel.kind)),
    ).toHaveLength(0);
  });
  it('uses independent durable fences for every unit, preserving the legacy first-unit fence', async () => {
    const { provider, input, createService } = fixture();
    await provider.provision(input);
    await provider.provision({
      ...input,
      fulfillmentId: `delivery-${input.orderId}-${input.productId}`,
    });
    await provider.provision({
      ...input,
      fulfillmentId: `delivery-${input.orderId}-${input.productId}-unit-2`,
    });
    await provider.provision({
      ...input,
      fulfillmentId: `delivery-${input.orderId}-${input.productId}-unit-2`,
    });
    expect(createService).toHaveBeenCalledTimes(2);
  });

  it('releases a settled cart even if the caller checkpoint fails, without releasing another order lock', async () => {
    const { provider, input, createService, rows, extensions } = fixture();
    input.checkpoint.mockImplementationOnce(async () => {
      throw new Error('caller unavailable');
    });
    await expect(provider.provision(input)).rejects.toThrow('caller unavailable');
    expect(
      [...rows.keys()].filter((key) => key.startsWith(provisioningCartLockModel.kind)),
    ).toHaveLength(0);
    await extensions.create(
      provisioningCartLockModel,
      { reference: 'another-order' },
      { name: 'upstream-1' },
    );
    await provider.provision(input);
    expect([...rows.values()].find((row) => row.name === 'upstream-1')?.spec.reference).toBe(
      'another-order',
    );
    expect(createService).toHaveBeenCalledTimes(1);
  });
  it('retains an uncertain request across a new provider process and blocks replay', async () => {
    const { provider, input, createService, rows } = fixture();
    createService.mockRejectedValueOnce(new Error('settle response lost'));
    await expect(provider.provision(input)).rejects.toThrow('settle response lost');
    // 同一订单的账本钉子必须还在：结果未知就不允许重复下单。
    await expect(provider.provision(input)).rejects.toThrow(/禁止重复下单/);
    expect(createService).toHaveBeenCalledTimes(1);
    // 但购物车锁必须释放。锁只保护「清车 → 加购 → 结算」这段窗口；
    // 泄漏一次就把整个上游账户永久锁死（真实事故：一次失败导致后续所有订单都报
    // 「上游购物车正在处理其他订单」）。
    expect(
      [...rows.keys()].filter((key) => key.startsWith(provisioningCartLockModel.kind)),
    ).toHaveLength(0);
    // 其他订单不受牵连：可以正常继续下单。
    const other = await provider.provision({
      ...input,
      orderId: 'other-order',
      fulfillmentId: `delivery-other-order-${input.productId}`,
    });
    expect(other.providerServiceId).toBe('remote-42');
    expect(createService).toHaveBeenCalledTimes(2);
  });
  it('keeps invoice identity when persistence after settlement fails and never recreates it', async () => {
    const { provider, input, createService } = fixture();
    input.checkpoint.mockRejectedValueOnce(new Error('store checkpoint failed'));
    await expect(provider.provision(input)).rejects.toThrow('store checkpoint failed');
    const restored = await provider.provision(input);
    expect(restored.providerServiceId).toBe('remote-42');
    expect(restored.runtime?.invoiceId).toBe('invoice-7');
    expect(createService).toHaveBeenCalledTimes(1);
  });
  it('auto-resumes payment when the recorded invoice is still unpaid', async () => {
    const { provider, input, createService, payServiceInvoice, inspectInvoice } = fixture();
    input.checkpoint.mockRejectedValueOnce(new Error('store checkpoint failed'));
    await expect(provider.provision(input)).rejects.toThrow('store checkpoint failed');
    // 账单仍未付：应该自己续付一次，而不是停在「请人工点继续付款」。
    inspectInvoice.mockResolvedValueOnce({
      invoiceId: 'invoice-7',
      status: 'Unpaid',
      paid: false,
      cancelled: false,
      serviceIds: ['remote-42'],
      amount: null,
    });
    await provider.provision(input);
    expect(payServiceInvoice).toHaveBeenCalledTimes(1);
    expect(payServiceInvoice).toHaveBeenCalledWith('invoice-7');
    // 续付绝不允许重新下单。
    expect(createService).toHaveBeenCalledTimes(1);
  });
  it('refuses to pay an invoice the upstream already cancelled', async () => {
    const { provider, input, payServiceInvoice, inspectInvoice } = fixture();
    input.checkpoint.mockRejectedValueOnce(new Error('store checkpoint failed'));
    await expect(provider.provision(input)).rejects.toThrow('store checkpoint failed');
    inspectInvoice.mockResolvedValueOnce({
      invoiceId: 'invoice-7',
      status: 'Cancelled',
      paid: false,
      cancelled: true,
      serviceIds: [],
      amount: null,
    });
    await expect(provider.provision(input)).rejects.toThrow(/已取消，禁止付款/);
    expect(payServiceInvoice).not.toHaveBeenCalled();
  });
  it('heals a stale upstream id from the host list instead of re-provisioning', async () => {
    const { provider, input, createService, findHost, resolveHostForAttempt } = fixture();
    input.checkpoint.mockRejectedValueOnce(new Error('store checkpoint failed'));
    await expect(provider.provision(input)).rejects.toThrow('store checkpoint failed');
    // 上游把下单时的占位 id 换成了真实主机：记录里的 remote-42 已不存在。
    findHost.mockResolvedValue(null as never);
    resolveHostForAttempt.mockResolvedValue({
      id: 'real-99',
      productId: null,
      name: 'real-99',
      productName: null,
      status: 'Active',
      statusLabel: null,
      host: null,
      expiresAt: null,
      openedAt: null,
      amount: null,
      currency: null,
      raw: { id: 'real-99', invoice_id: 'invoice-7' },
    } as never);
    const result = await provider.provision(input);
    expect(result.providerServiceId).toBe('real-99');
    // 自愈绝不能变成重新下单。
    expect(createService).toHaveBeenCalledTimes(1);
  });
  it('resumes only the recorded invoice and fences payment timeouts against another debit', async () => {
    const { provider, input, createService, payServiceInvoice, rows } = fixture();
    await provider.provision(input);
    const row = [...rows.values()].find((row) => row.name !== 'upstream-1')!;
    row.spec.state = 'PAYMENT_REQUIRED';
    row.spec.runtime = { invoiceId: 'invoice-7', paymentState: 'PAYMENT_REQUIRED', paid: false };
    payServiceInvoice.mockResolvedValue({ paid: false, paymentState: 'PAYMENT_UNKNOWN' });
    const result = await provider.provision({ ...input, resumePayment: true });
    expect(result.runtime?.paymentState).toBe('PAYMENT_UNKNOWN');
    expect(payServiceInvoice).toHaveBeenCalledWith('invoice-7');
    expect(createService).toHaveBeenCalledTimes(1);
    await expect(provider.provision({ ...input, resumePayment: true })).rejects.toThrow(
      /付款结果未确认/,
    );
    expect(payServiceInvoice).toHaveBeenCalledTimes(1);
  });
  it('never creates an order when payment recovery has no original journal', async () => {
    const { provider, input, createService, payServiceInvoice } = fixture();
    await expect(provider.provision({ ...input, resumePayment: true })).rejects.toThrow(
      /缺少原上游订单记录/,
    );
    expect(createService).not.toHaveBeenCalled();
    expect(payServiceInvoice).not.toHaveBeenCalled();
  });
  it('rejects changed configurations on the same order identity', async () => {
    const { provider, input, createService } = fixture();
    await provider.provision(input);
    await expect(provider.provision({ ...input, quantity: 2 })).rejects.toThrow(/配置已变更/);
    expect(createService).toHaveBeenCalledTimes(1);
  });
});

describe('ZJMFProvider guards', () => {
  it('rejects provisioning products owned by another provider', async () => {
    const provider = new ZJMFProvider(minimalCtx());
    await expect(
      provider.provision({
        orderId: 'o',
        userId: 'u',
        productId: 'p',
        product: {
          id: 'p',
          name: 'x',
          price: 100,
          currency: 'CNY',
          metadata: null,
          providerId: 'other',
          providerProductId: 'pp',
        },
        quantity: 1,
        secrets: minimalCtx().secrets,
      }),
    ).rejects.toThrow(/不属于智简魔方提供方/);
  });

  it('rejects provisioning without an upstream product id', async () => {
    const provider = new ZJMFProvider(minimalCtx());
    await expect(
      provider.provision({
        orderId: 'o',
        userId: 'u',
        productId: 'p',
        product: {
          id: 'p',
          name: 'x',
          price: 100,
          currency: 'CNY',
          metadata: null,
          providerId: 'zjmf',
          providerProductId: null,
        },
        quantity: 1,
        secrets: minimalCtx().secrets,
      }),
    ).rejects.toThrow(/缺少上游商品 ID/);
  });

  it('returns a placeholder detail before the service is provisioned', async () => {
    const provider = new ZJMFProvider(minimalCtx());
    const detail = await provider.getDetail({
      service: {
        id: 's',
        providerId: 'zjmf',
        providerServiceId: null,
        runtime: { host: '203.0.113.10' },
        credentialsRef: null,
        userId: 'u',
        orderId: 'o',
        productId: 'p',
        status: 'PROVISIONING',
      },
      secrets: minimalCtx().secrets,
    });
    expect(detail.status).toBe('PROVISIONING');
    expect(detail.fields).toEqual([]);
  });

  it('rejects unsupported actions', async () => {
    const provider = new ZJMFProvider(minimalCtx());
    await expect(
      provider.executeAction('bogus', {
        service: {
          id: 's',
          providerId: 'zjmf',
          providerServiceId: 'svc-1',
          runtime: null,
          credentialsRef: null,
          userId: 'u',
          orderId: 'o',
          productId: 'p',
          status: 'ACTIVE',
        },
        secrets: minimalCtx().secrets,
      }),
    ).rejects.toThrow(/不支持的运维动作/);
  });

  it('rejects action params that collide with upstream reserved fields', async () => {
    const provider = new ZJMFProvider(minimalCtx());
    const ctx = {
      service: {
        id: 's',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        runtime: null,
        credentialsRef: null,
        userId: 'u',
        orderId: 'o',
        productId: 'p',
        status: 'ACTIVE',
      },
      secrets: minimalCtx().secrets,
    };
    await expect(provider.executeAction('power_off', ctx, { func: 'terminate' })).rejects.toThrow(
      /运维动作参数无效/,
    );
    await expect(provider.executeAction('reinstall', ctx, { 'bad name': 'x' })).rejects.toThrow(
      /运维动作参数无效/,
    );
  });
});

describe('ZJMFProvider resource failure semantics (handoff #2)', () => {
  function ctxWithCredentials(): PluginContext {
    const ctx = minimalCtx();
    (ctx as { secrets: PluginContext['secrets'] }).secrets = {
      isAvailable: () => true,
      get: async () => JSON.stringify({ username: 'u', password: 'p' }),
      set: async () => {},
      remove: async () => {},
    };
    return ctx;
  }

  const service = {
    id: 's',
    providerId: 'zjmf',
    providerServiceId: '42',
    runtime: { upstreamId: 'up-1' },
    credentialsRef: null,
    userId: 'u',
    orderId: 'o',
    productId: 'p',
    status: 'ACTIVE' as const,
  };

  function ctx(): ProviderServiceContext {
    return { service, secrets: minimalCtx().secrets };
  }

  beforeEach(() => {
    vi.mocked(getUpstream).mockResolvedValue({
      id: 'up-1',
      name: 'up',
      baseUrl: 'https://93.184.216.34/',
      protocol: 'finance',
      currency: 'CNY',
      markupBps: 0,
      defaultStock: 100,
      syncIntervalMinutes: 60,
      enabled: true,
      syncState: 'IDLE',
      allowUnverifiedV10Routes: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('V9: listResources propagates an upstream failure instead of returning []', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        return new Response('boom', { status: 500 });
      }),
    );
    const provider = new ZJMFProvider(ctxWithCredentials());
    await expect(provider.listResources(ctx(), 'snapshot')).rejects.toThrow();
  });

  it('V10: listResources returns [] on a successful empty set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        return json({ status: 200, data: { list: [] } });
      }),
    );
    const provider = new ZJMFProvider(ctxWithCredentials());
    await expect(provider.listResources(ctx(), 'snapshot')).resolves.toEqual([]);
  });
});

describe('normalizeStatus', () => {
  it('keeps stopped instances active without conflating suspension and power', () => {
    for (const value of ['off', 'shutoff', 'shutdown', 'stopped', 'powered_off']) {
      expect(normalizeStatus(value)).toBe('ACTIVE');
      expect(normalizePowerState(value)).toBe('OFF');
    }
    expect(normalizeStatus('suspended')).toBe('SUSPENDED');
    expect(normalizePowerState('suspended')).toBe('UNKNOWN');
    expect(normalizePowerState('active')).toBe('UNKNOWN');
    expect(normalizePowerState('running')).toBe('ON');
  });
  it('maps upstream status words to canonical service statuses', () => {
    expect(normalizeStatus('active')).toBe('ACTIVE');
    expect(normalizeStatus('running')).toBe('ACTIVE');
    expect(normalizeStatus('suspended')).toBe('SUSPENDED');
    expect(normalizeStatus('terminated')).toBe('TERMINATED');
    expect(normalizeStatus('Cancelled')).toBe('TERMINATED');
    expect(normalizeStatus('Canceled')).toBe('TERMINATED');
    expect(normalizeStatus('failed')).toBe('FAILED');
    expect(normalizeStatus('provisioning')).toBe('PROVISIONING');
    expect(normalizeStatus('anything')).toBe('PENDING_PROVISION');
    expect(normalizeStatus('AWAITING_UPSTREAM_PAYMENT')).toBe('PENDING_PROVISION');
    expect(normalizeStatus('REQUIRES_RECONCILIATION')).toBe('PENDING_PROVISION');
  });
});

describe('changePackage 只提交差异（上游对未变化项整单拒绝）', () => {
  const baseUpstream = {
    id: 'up-1',
    name: 'up',
    baseUrl: 'https://93.184.216.34/',
    protocol: 'finance' as const,
    currency: 'CNY',
    markupBps: 0,
    defaultStock: 100,
    syncIntervalMinutes: 60,
    enabled: true,
    syncState: 'IDLE' as const,
    allowUnverifiedV10Routes: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function pluginCtx(): PluginContext {
    const ctx = minimalCtx();
    (ctx as { secrets: PluginContext['secrets'] }).secrets = {
      isAvailable: () => true,
      get: async () => JSON.stringify({ username: 'u', password: 'p' }),
      set: async () => {},
      remove: async () => {},
    };
    return ctx;
  }

  function providerCtx(runtime: Record<string, unknown>): ProviderServiceContext {
    const ctx = pluginCtx();
    return {
      service: {
        id: 's',
        providerId: 'zjmf',
        providerServiceId: '42',
        runtime,
        credentialsRef: null,
        userId: 'u',
        orderId: 'o',
        productId: 'p',
        status: 'ACTIVE',
      } as never,
      secrets: ctx.secrets,
    };
  }

  beforeEach(() => {
    vi.mocked(getUpstream).mockResolvedValue(baseUpstream);
  });

  it('只把变化的配置项发给上游', async () => {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        if (init?.body instanceof URLSearchParams) bodies.push(init.body);
        return json({ status: 200, msg: '请求成功', data: {} });
      }),
    );
    const provider = new ZJMFProvider(pluginCtx());
    await provider.changePackage(
      providerCtx({
        upstreamId: 'up-1',
        config: { cycle: 'monthly', selections: { '3395983': 'old-os', '3395985': '1' } },
      }),
      {
        type: 'package',
        config: { cycle: 'monthly', selections: { '3395983': 'old-os', '3395985': '2' } },
      },
    );
    const upgrade = bodies.find((body) => body.get('configoption[3395985]'));
    expect(upgrade?.get('configoption[3395985]')).toBe('2');
    expect(upgrade?.get('configoption[3395983]')).toBeNull();
  });

  it('配置没有变化时不向上游提交空升级', async () => {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        if (init?.body instanceof URLSearchParams) bodies.push(init.body);
        return json({ status: 200, msg: '请求成功', data: {} });
      }),
    );
    const provider = new ZJMFProvider(pluginCtx());
    const selection = { cycle: 'monthly', selections: { '3395985': '1' } };
    await provider.changePackage(providerCtx({ upstreamId: 'up-1', config: selection }), {
      type: 'package',
      config: selection,
    });
    expect(bodies.some((body) => body.get('hid'))).toBe(false);
  });
});

describe('财务协议的真实运维能力（V10 源码取证）', () => {
  const baseUpstream = {
    id: 'up-1',
    name: 'up',
    baseUrl: 'https://93.184.216.34/',
    protocol: 'finance' as const,
    currency: 'CNY',
    markupBps: 0,
    defaultStock: 100,
    syncIntervalMinutes: 60,
    enabled: true,
    syncState: 'IDLE' as const,
    allowUnverifiedV10Routes: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeCtx(store: { password?: string }) {
    const ctx = minimalCtx();
    (ctx as { secrets: PluginContext['secrets'] }).secrets = {
      isAvailable: () => true,
      get: async () => JSON.stringify({ username: 'u', password: 'p' }),
      set: async (_key: string, value: string) => {
        store.password = (JSON.parse(value) as { password?: string }).password;
      },
      remove: async () => {},
    };
    return ctx;
  }

  function providerCtx(secrets: ProviderServiceContext['secrets']): ProviderServiceContext {
    return {
      service: {
        id: 's',
        providerId: 'zjmf',
        providerServiceId: '42',
        runtime: { upstreamId: 'up-1' },
        credentialsRef: 'cred-1',
        userId: 'u',
        orderId: 'o',
        productId: 'p',
        status: 'ACTIVE',
      } as never,
      secrets,
    };
  }

  function stubFetch(bodies: URLSearchParams[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        if (path === '/zjmf_api_login') return json({ status: 200, jwt: 'jwt' });
        if (init?.body instanceof URLSearchParams) bodies.push(init.body);
        return json({ status: 200, msg: '发起重置密码成功', data: {} });
      }),
    );
  }

  beforeEach(() => {
    vi.mocked(getUpstream).mockResolvedValue(baseUpstream);
  });

  it('重置密码走上游的 crack_pass，并把新密码存进凭据', async () => {
    const bodies: URLSearchParams[] = [];
    stubFetch(bodies);
    const store: { password?: string } = {};
    const ctx = makeCtx(store);
    const provider = new ZJMFProvider(ctx);
    await provider.executeAction('reset_password', providerCtx(ctx.secrets), {
      password: 'Sp6qZw9rT4vY',
    });
    const action = bodies.find((body) => body.get('func'));
    // `reset_password` 在财务版是 406「不支持的方法」，真正的 func 是 crack_pass。
    expect(action?.get('func')).toBe('crack_pass');
    expect(action?.get('password')).toBe('Sp6qZw9rT4vY');
    expect(action?.get('is_api')).toBe('1');
    expect(store.password).toBe('Sp6qZw9rT4vY');
  });

  it('密码太短在本地就拦住，不白跑一趟上游异步任务', async () => {
    const bodies: URLSearchParams[] = [];
    stubFetch(bodies);
    const ctx = makeCtx({});
    const provider = new ZJMFProvider(ctx);
    await expect(
      provider.executeAction('reset_password', providerCtx(ctx.secrets), { password: 'short' }),
    ).rejects.toThrow(/至少 8 位/);
    expect(bodies).toHaveLength(0);
  });

  it('重装缺操作系统时明确报错，而不是让上游回一句「操作系统错误」', async () => {
    const bodies: URLSearchParams[] = [];
    stubFetch(bodies);
    const ctx = makeCtx({});
    const provider = new ZJMFProvider(ctx);
    await expect(provider.executeAction('reinstall', providerCtx(ctx.secrets))).rejects.toThrow(
      /请选择要重装的操作系统/,
    );
    expect(bodies).toHaveLength(0);
  });

  it('重装把 os/port 透传给上游 reinstall', async () => {
    const bodies: URLSearchParams[] = [];
    stubFetch(bodies);
    const ctx = makeCtx({});
    const provider = new ZJMFProvider(ctx);
    await provider.executeAction('reinstall', providerCtx(ctx.secrets), {
      os: '15711313',
      port: '22',
    });
    const action = bodies.find((body) => body.get('func'));
    expect(action?.get('func')).toBe('reinstall');
    expect(action?.get('os')).toBe('15711313');
    expect(action?.get('port')).toBe('22');
  });
});
