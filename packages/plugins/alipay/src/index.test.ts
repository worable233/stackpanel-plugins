import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPrecreateParams, canonicalize, signRsa2 } from './alipay-client.js';
import alipayPlugin from './index.js';

/**
 * 插件自身的接线（不是协议）：createPayment / callback / configure 在真实
 * ctx 契约下是否走得通。协议细节在 alipay-client.test.ts 里验。
 */
const merchant = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const alipay = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function fakeCtx(storedConfig: unknown = null) {
  const secrets = new Map<string, string>();
  const settles: unknown[] = [];
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    secrets: {
      isAvailable: () => true,
      get: async (key: string) => secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
    payments: {
      getProviderConfig: async () => storedConfig,
      settle: async (input: unknown) => {
        settles.push(input);
        return { settled: true, alreadySettled: false };
      },
    },
  };
  return { ctx, settles, secrets };
}

function config() {
  return {
    appId: '2021000000000000',
    privateKey: merchant.privateKey,
    alipayPublicKey: alipay.publicKey,
    gatewayUrl: 'https://openapi.alipay.com/gateway.do',
  };
}

/** 启动插件并拿到它注册到扩展点上的 provider 实例。 */
async function activate(storedConfig: unknown) {
  let registered: unknown = null;
  const { ctx, settles, secrets } = fakeCtx(storedConfig);
  await alipayPlugin.onActivate?.({
    ...ctx,
    registerExtension: (_point: string, service: unknown) => {
      registered = service;
      return () => undefined;
    },
  } as never);
  return { provider: registered as Record<string, unknown>, settles, secrets, ctx };
}

afterEach(() => {
  vi.unstubAllGlobals();
  alipayPlugin.onDeactivate?.({ logger: { info: vi.fn() } } as never);
});

describe('alipay plugin wiring', () => {
  it('registers a gateway provider with the alipay method once configured', async () => {
    const { provider } = await activate(config());
    expect(provider['id']).toBe('alipay');
    expect(provider['mode']).toBe('gateway');
    expect(provider['callbackPath']).toBe('/callbacks/alipay');
    expect((provider['getMethods'] as () => unknown[])().length).toBe(1);
  });

  it('offers no methods until configured', async () => {
    const { provider } = await activate(null);
    expect((provider['getMethods'] as () => unknown[])()).toEqual([]);
  });

  it('posts a signed precreate request and returns the QR payload', async () => {
    const { provider } = await activate(config());
    const node = JSON.stringify({
      code: '10000',
      msg: 'Success',
      out_trade_no: 'ORD-1',
      qr_code: 'https://qr.alipay.com/abc',
    });
    const body = `{"alipay_trade_precreate_response":${node},"sign":"${signRsa2(node, alipay.privateKey)}"}`;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('method')).toBe('alipay.trade.precreate');
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await (provider['createPayment'] as (input: unknown) => Promise<unknown>)({
      purpose: 'ORDER',
      merchantOrderNo: 'ORD-1',
      amount: 1234,
      currency: 'CNY',
      method: 'alipay',
      subject: '测试订单',
      notifyUrl: 'https://shop.example.com/callbacks/alipay',
      returnUrl: 'https://shop.example.com/orders/1',
    });
    expect(result).toMatchObject({
      externalId: 'ORD-1',
      paymentUrl: 'https://qr.alipay.com/abc',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses non-CNY before touching the network', async () => {
    const { provider } = await activate(config());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      (provider['createPayment'] as (input: unknown) => Promise<unknown>)({
        purpose: 'ORDER',
        merchantOrderNo: 'ORD-1',
        amount: 1234,
        currency: 'USD',
        method: 'alipay',
        subject: 'x',
        notifyUrl: 'https://x/cb',
        returnUrl: 'https://x/r',
      }),
    ).rejects.toThrow(/CNY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('settles a signed success notification and answers success', async () => {
    const { provider, settles } = await activate(config());
    const params: Record<string, string> = {
      app_id: '2021000000000000',
      out_trade_no: 'ORD-1',
      trade_no: '2026',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
    };
    const body = { ...params, sign: signRsa2(canonicalize(params), alipay.privateKey) };
    const sent: unknown[] = [];
    const reply = { send: (value: unknown) => sent.push(value) };

    await (provider['callback'] as (req: unknown, reply: unknown) => Promise<unknown>)(
      { body, query: {}, headers: {} },
      reply,
    );
    expect(settles).toEqual([
      {
        providerId: 'alipay',
        merchantOrderNo: 'ORD-1',
        externalId: '2026',
        amount: 1234,
        currency: 'CNY',
      },
    ]);
    expect(sent).toEqual(['success']);
  });

  it('still answers success for a closed trade (no settlement, no retry storm)', async () => {
    const { provider, settles } = await activate(config());
    const params: Record<string, string> = {
      app_id: '2021000000000000',
      out_trade_no: 'ORD-1',
      trade_no: '2026',
      trade_status: 'TRADE_CLOSED',
      total_amount: '12.34',
    };
    const body = { ...params, sign: signRsa2(canonicalize(params), alipay.privateKey) };
    const sent: unknown[] = [];
    await (provider['callback'] as (req: unknown, reply: unknown) => Promise<unknown>)(
      { body, query: {}, headers: {} },
      { send: (value: unknown) => sent.push(value) },
    );
    expect(settles).toEqual([]);
    expect(sent).toEqual(['success']);
  });

  it('rejects an unsigned notification before settling', async () => {
    const { provider, settles } = await activate(config());
    await expect(
      (provider['callback'] as (req: unknown, reply: unknown) => Promise<unknown>)(
        { body: { out_trade_no: 'ORD-1', trade_status: 'TRADE_SUCCESS' }, query: {}, headers: {} },
        { send: vi.fn() },
      ),
    ).rejects.toThrow(/回调签名无效/);
    expect(settles).toEqual([]);
  });

  it('persists a validated config through secret storage', async () => {
    const { provider, secrets } = await activate(null);
    await (provider['configure'] as (input: unknown) => Promise<unknown>)(config());
    const stored = JSON.parse(secrets.get('gateway-config') ?? '{}') as { appId?: string };
    expect(stored.appId).toBe('2021000000000000');
    expect((provider['getMethods'] as () => unknown[])().length).toBe(1);
  });

  it('rejects a config whose keys cannot be loaded, before saving anything', async () => {
    const { provider, secrets } = await activate(null);
    await expect(
      (provider['configure'] as (input: unknown) => Promise<unknown>)({
        ...config(),
        privateKey: 'x'.repeat(80),
      }),
    ).rejects.toThrow(/RSA 密钥材料无效/);
    expect(secrets.size).toBe(0);
  });

  it('builds the precreate params used by the gateway call', () => {
    const params = buildPrecreateParams(config(), {
      merchantOrderNo: 'ORD-1',
      amount: 100,
      subject: 'x',
      notifyUrl: 'https://x/cb',
    });
    expect(params['notify_url']).toBe('https://x/cb');
  });
});
