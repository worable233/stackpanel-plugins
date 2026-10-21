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
    const provider = new ZJMFProvider(ctx);
    vi.spyOn(provider as never, 'resolveForProduct').mockResolvedValue({
      client: { createService, payServiceInvoice, verifyCancelledInvoice },
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
    createService.mockRejectedValue(new Error('settle response lost'));
    await expect(provider.provision(input)).rejects.toThrow('settle response lost');
    await expect(provider.provision(input)).rejects.toThrow(/禁止重复下单/);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(
      [...rows.keys()].filter((key) => key.startsWith(provisioningCartLockModel.kind)),
    ).toHaveLength(1);
    await expect(provider.provision({ ...input, orderId: 'other-order' })).rejects.toMatchObject({
      retryableBeforeSubmit: true,
    });
    expect(createService).toHaveBeenCalledTimes(1);
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
