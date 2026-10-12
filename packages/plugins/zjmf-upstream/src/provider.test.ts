import { describe, expect, it } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
import { ZJMFProvider, normalizeStatus } from './provider.js';

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
