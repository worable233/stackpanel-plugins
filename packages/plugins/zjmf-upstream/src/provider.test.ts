import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext, ProviderServiceContext } from '@stackpanel/sdk';
import { ZJMFProvider, normalizeStatus } from './provider.js';
import { getUpstream } from './repository.js';

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
        if (path === '/zjmf_api_login')
          return json({ status: 200, jwt: 'jwt' });
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
        if (path === '/zjmf_api_login')
          return json({ status: 200, jwt: 'jwt' });
        return json({ status: 200, data: { list: [] } });
      }),
    );
    const provider = new ZJMFProvider(ctxWithCredentials());
    await expect(provider.listResources(ctx(), 'snapshot')).resolves.toEqual([]);
  });
});

describe('normalizeStatus', () => {
  it('maps upstream status words to canonical service statuses', () => {
    expect(normalizeStatus('active')).toBe('ACTIVE');
    expect(normalizeStatus('running')).toBe('ACTIVE');
    expect(normalizeStatus('suspended')).toBe('SUSPENDED');
    expect(normalizeStatus('terminated')).toBe('TERMINATED');
    expect(normalizeStatus('failed')).toBe('FAILED');
    expect(normalizeStatus('provisioning')).toBe('PROVISIONING');
    expect(normalizeStatus('anything')).toBe('PENDING_PROVISION');
  });
});
