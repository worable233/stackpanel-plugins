import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptResource, notificationSignMessage, rsaSign } from './wechatpay-client.js';
import { TEST_PLATFORM_CERT_PEM, TEST_PLATFORM_KEY_PEM } from './test-fixtures.js';
import wechatpayPlugin from './index.js';

/** 插件自身的接线（不是协议）：下单、关单、原始报文回调在真实 ctx 契约下是否走得通。 */
const merchant = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const platform = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const API_V3_KEY = 'k'.repeat(32);

function config() {
  return {
    appId: 'wx1234567890abcdef',
    mchId: '1900000001',
    serialNo: 'SERIAL',
    privateKey: merchant.privateKey,
    apiV3Key: API_V3_KEY,
    platformPublicKey: platform.publicKey,
    apiBase: 'https://api.mch.weixin.qq.com',
  };
}

function fakeCtx(storedConfig: unknown = config()) {
  const secrets = new Map<string, string>();
  const settles: unknown[] = [];
  const schedules: Array<{ name: string; schedule: unknown }> = [];
  const jobHandlers = new Map<string, () => Promise<void>>();
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    jobs: {
      schedule: async (name: string, schedule: unknown) => {
        schedules.push({ name, schedule });
      },
      handle: (name: string, handler: () => Promise<void>) => {
        jobHandlers.set(name, handler);
        return () => jobHandlers.delete(name);
      },
      enqueue: async () => '',
    },
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
  return { ctx, settles, secrets, schedules, jobHandlers };
}

async function activate(storedConfig: unknown = config()) {
  let provider: Record<string, unknown> | null = null;
  const { ctx, settles, secrets, schedules, jobHandlers } = fakeCtx(storedConfig);
  await wechatpayPlugin.onActivate?.({
    ...ctx,
    registerExtension: (_point: string, service: unknown) => {
      provider = service as Record<string, unknown>;
      return () => undefined;
    },
  } as never);
  return {
    provider: provider as Record<string, unknown>,
    settles,
    secrets,
    ctx,
    schedules,
    jobHandlers,
  };
}

function signedNotification(transaction: Record<string, unknown>, overrideKey?: string) {
  const nonce = randomBytes(6).toString('hex');
  const ciphertext = encryptResource({
    plaintext: JSON.stringify(transaction),
    nonce,
    associatedData: 'transaction',
    apiV3Key: API_V3_KEY,
  });
  const body = JSON.stringify({
    id: 'evt-1',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce, associated_data: 'transaction' },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headerNonce = randomBytes(8).toString('hex');
  const signature = rsaSign(
    notificationSignMessage({ timestamp, nonce: headerNonce, body }),
    overrideKey ?? platform.privateKey,
  );
  return {
    body,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signature,
    },
  };
}

/** 原始报文路由：handler 直接拿 stream 和 raw reply。 */
function rawCallbackRoute() {
  const route = wechatpayPlugin.routes.find(
    (candidate) => candidate.path === '/callbacks/wechatpay',
  ) as { kind?: string; handler: (req: unknown, reply: unknown) => Promise<void> };
  expect(route.kind).toBe('raw');
  return route;
}

async function invokeCallback(body: string, headers: Record<string, string>) {
  const reply = {
    statusCode: 0,
    payload: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    header() {
      return this;
    },
    write() {
      return true;
    },
    async drain() {
      return undefined;
    },
    end(chunk?: string) {
      this.payload = chunk ?? '';
    },
    hijack() {},
    onClientClose() {},
    raw: null,
  };
  await rawCallbackRoute().handler(
    {
      method: 'POST',
      url: '/callbacks/wechatpay',
      params: {},
      query: new URLSearchParams(),
      headers,
      body: Readable.from([Buffer.from(body, 'utf8')]),
      raw: null,
    },
    reply,
  );
  return reply;
}

afterEach(() => {
  vi.unstubAllGlobals();
  wechatpayPlugin.onDeactivate?.({ logger: { info: vi.fn() } } as never);
});

describe('wechatpay plugin wiring', () => {
  it('registers a gateway provider offering wechat_native once configured', async () => {
    const { provider } = await activate();
    expect(provider['id']).toBe('wechatpay');
    expect(provider['callbackPath']).toBe('/callbacks/wechatpay');
    expect((provider['getMethods'] as () => Array<{ id: string }>)()[0]?.id).toBe('wechat_native');
  });

  it('offers no methods until configured', async () => {
    const { provider } = await activate(null);
    expect((provider['getMethods'] as () => unknown[])()).toEqual([]);
  });

  it('creates a native order and verifies the signed response', async () => {
    const { provider } = await activate();
    const responseBody = JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=abc' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'respnonce';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
      return new Response(responseBody, {
        status: 200,
        headers: {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-signature': rsaSign(
            notificationSignMessage({ timestamp, nonce, body: responseBody }),
            platform.privateKey,
          ),
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await (provider['createPayment'] as (input: unknown) => Promise<unknown>)({
      purpose: 'ORDER',
      merchantOrderNo: 'ORD-1',
      amount: 1234,
      currency: 'CNY',
      method: 'wechat_native',
      subject: '测试订单',
      notifyUrl: 'https://shop.example.com/callbacks/wechatpay',
    });
    expect(result).toMatchObject({
      externalId: 'ORD-1',
      paymentUrl: 'weixin://wxpay/bizpayurl?pr=abc',
    });
  });

  it('rejects an unsigned gateway response (a forged code_url cannot be trusted)', async () => {
    const { provider } = await activate();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ code_url: 'weixin://evil' }), { status: 200 }),
      ),
    );
    await expect(
      (provider['createPayment'] as (input: unknown) => Promise<unknown>)({
        purpose: 'ORDER',
        merchantOrderNo: 'ORD-2',
        amount: 100,
        currency: 'CNY',
        method: 'wechat_native',
        subject: 'x',
        notifyUrl: 'https://x/cb',
      }),
    ).rejects.toThrow(/回调报文无效/);
  });

  it('refuses non-CNY before touching the network', async () => {
    const { provider } = await activate();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      (provider['createPayment'] as (input: unknown) => Promise<unknown>)({
        purpose: 'ORDER',
        merchantOrderNo: 'ORD-3',
        amount: 100,
        currency: 'USD',
        method: 'wechat_native',
        subject: 'x',
        notifyUrl: 'https://x/cb',
      }),
    ).rejects.toThrow(/CNY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('settles a signed SUCCESS notification and answers the WeChat envelope', async () => {
    const { provider, settles } = await activate();
    const { body, headers } = signedNotification({
      appid: 'wx1234567890abcdef',
      mchid: '1900000001',
      out_trade_no: 'ORD-1',
      transaction_id: '4200001234',
      trade_state: 'SUCCESS',
      amount: { total: 1234, currency: 'CNY' },
    });
    expect(settles).toEqual([]);
    const reply = await invokeCallback(body, headers);
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.payload)).toEqual({ code: 'SUCCESS', message: '成功' });
    expect(settles).toEqual([
      {
        providerId: 'wechatpay',
        merchantOrderNo: 'ORD-1',
        externalId: '4200001234',
        amount: 1234,
        currency: 'CNY',
      },
    ]);
    expect(provider['id']).toBe('wechatpay');
  });

  it('does not settle a non-SUCCESS notification but still confirms receipt', async () => {
    const { settles } = await activate();
    const { body, headers } = signedNotification({
      appid: 'wx1234567890abcdef',
      out_trade_no: 'ORD-1',
      trade_state: 'CLOSED',
      amount: { total: 1234 },
    });
    const reply = await invokeCallback(body, headers);
    expect(JSON.parse(reply.payload).code).toBe('SUCCESS');
    expect(settles).toEqual([]);
  });

  it('answers FAIL with 401 for a tampered notification (so WeChat retries)', async () => {
    const { settles } = await activate();
    const { body, headers } = signedNotification({ out_trade_no: 'ORD-1', trade_state: 'SUCCESS' });
    const reply = await invokeCallback(body.replace('SUCCESS', 'FAILED'), headers);
    expect(reply.statusCode).toBe(401);
    expect(JSON.parse(reply.payload).code).toBe('FAIL');
    expect(settles).toEqual([]);
  });

  it('rejects a notification for another app id (wrong merchant wiring)', async () => {
    const { settles } = await activate();
    const { body, headers } = signedNotification({
      appid: 'wx_other_app',
      out_trade_no: 'ORD-1',
      trade_state: 'SUCCESS',
      amount: { total: 100 },
    });
    const reply = await invokeCallback(body, headers);
    expect(reply.statusCode).toBe(401);
    expect(settles).toEqual([]);
  });

  it('rejects a SUCCESS notification without a usable amount', async () => {
    const { settles } = await activate();
    const { body, headers } = signedNotification({
      appid: 'wx1234567890abcdef',
      out_trade_no: 'ORD-1',
      trade_state: 'SUCCESS',
      amount: { total: 0 },
    });
    const reply = await invokeCallback(body, headers);
    expect(reply.statusCode).toBe(401);
    expect(settles).toEqual([]);
  });

  it('persists a validated config through secret storage', async () => {
    const { provider, secrets } = await activate(null);
    await (provider['configure'] as (input: unknown) => Promise<unknown>)(config());
    expect(JSON.parse(secrets.get('gateway-config') ?? '{}').mchId).toBe('1900000001');
    expect((provider['getMethods'] as () => unknown[])().length).toBe(1);
  });

  it('inherits blank key fields from the stored config (no unreadable re-paste)', async () => {
    const stored = { ...config() };
    const { provider, secrets } = await activate(stored);
    await (provider['configure'] as (input: unknown) => Promise<unknown>)({
      appId: 'wx1234567890abcdef',
      mchId: '1900000002',
      serialNo: 'SERIAL',
      privateKey: '',
      apiV3Key: '',
      platformPublicKey: '',
      apiBase: 'https://api.mch.weixin.qq.com',
    });
    const saved = JSON.parse(secrets.get('gateway-config') ?? '{}');
    expect(saved.mchId).toBe('1900000002');
    expect(saved.privateKey).toBe(stored.privateKey.trim());
    expect(saved.apiV3Key).toBe(stored.apiV3Key);
  });

  it('rejects an invalid config before saving anything', async () => {
    const { provider, secrets } = await activate(null);
    await expect(
      (provider['configure'] as (input: unknown) => Promise<unknown>)({
        ...config(),
        platformPublicKey: 'x'.repeat(64),
      }),
    ).rejects.toThrow(/密钥材料无效/);
    expect(secrets.size).toBe(0);
  });
});

describe('wechatpay platform certificate rotation', () => {
  /**
   * bootstrap 用的是测试自己生成的那把公钥，**不是**随后下发的证书公钥 ——
   * 只有两把不同，才能证明轮换真的把验签密钥换掉了。
   */
  function certificateConfig() {
    return config();
  }

  function certificateBody(serialNo: string): string {
    const nonce = 'certnonce123';
    const ciphertext = encryptResource({
      plaintext: TEST_PLATFORM_CERT_PEM,
      nonce,
      associatedData: 'certificate',
      apiV3Key: 'k'.repeat(32),
    });
    return JSON.stringify({
      data: [
        {
          serial_no: serialNo,
          encrypt_certificate: { nonce, associated_data: 'certificate', ciphertext },
        },
      ],
    });
  }

  function signedResponse(body: string, serial = 'ROTATED-SERIAL') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'respnonce';
    return new Response(body, {
      status: 200,
      headers: {
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-serial': serial,
        // 轮换应答由**当前**平台私钥签（bootstrap 那把），证书列表本身随后才换。
        'wechatpay-signature': rsaSign(
          notificationSignMessage({ timestamp, nonce, body }),
          platform.privateKey,
        ),
      },
    });
  }

  it('schedules the rotation job every 12h on activation', async () => {
    const { schedules, jobHandlers } = await activate(certificateConfig());
    expect(schedules).toEqual([
      { name: 'platform-cert-refresh', schedule: { everyMs: 12 * 60 * 60_000 } },
    ]);
    expect(jobHandlers.has('platform-cert-refresh')).toBe(true);
  });

  it('downloads, decrypts and installs the rotated certificate', async () => {
    const { provider } = await activate(certificateConfig());
    const body = certificateBody('ROTATED-SERIAL');
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.mch.weixin.qq.com/v3/certificates');
      return signedResponse(body);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = (await (provider['refreshCertificates'] as () => Promise<unknown>)()) as {
      count: number;
      serials: string[];
    };
    expect(summary.count).toBe(1);
    expect(summary.serials).toEqual(['ROTATED-SERIAL']);
  });

  it('refuses a rotation response whose signature does not verify', async () => {
    const { provider } = await activate(certificateConfig());
    const body = certificateBody('EVIL-SERIAL');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        return new Response(body, {
          status: 200,
          headers: {
            'wechatpay-timestamp': timestamp,
            'wechatpay-nonce': 'n',
            'wechatpay-serial': 'EVIL-SERIAL',
            // 用商户自己的私钥签：应答验签必须挡住。
            'wechatpay-signature': rsaSign(
              notificationSignMessage({ timestamp, nonce: 'n', body }),
              merchant.privateKey,
            ),
          },
        });
      }),
    );
    await expect((provider['refreshCertificates'] as () => Promise<unknown>)()).rejects.toThrow(
      /签名无效/,
    );
  });

  it('switches callback verification to the rotated certificate (before/after)', async () => {
    const { provider, settles } = await activate(certificateConfig());

    const transaction = {
      appid: 'wx1234567890abcdef',
      out_trade_no: 'ORD-ROT',
      transaction_id: '4200009999',
      trade_state: 'SUCCESS',
      amount: { total: 500, currency: 'CNY' },
    };
    const nonce = randomBytes(6).toString('hex');
    const ciphertext = encryptResource({
      plaintext: JSON.stringify(transaction),
      nonce,
      associatedData: 'transaction',
      apiV3Key: 'k'.repeat(32),
    });
    const notifyBody = JSON.stringify({
      id: 'evt-rot',
      event_type: 'TRANSACTION.SUCCESS',
      resource: { ciphertext, nonce, associated_data: 'transaction' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headerNonce = randomBytes(8).toString('hex');
    const headers = {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': headerNonce,
      'wechatpay-serial': 'ROTATED-SERIAL',
      // 轮换后微信改用新证书对应的私钥签名；bootstrap 那把已经验不过了。
      'wechatpay-signature': rsaSign(
        notificationSignMessage({ timestamp, nonce: headerNonce, body: notifyBody }),
        TEST_PLATFORM_KEY_PEM,
      ),
    };

    // 轮换前：bootstrap 公钥验不过新证书签的回调 —— 这正是必须自动轮换的原因。
    const before = await invokeCallback(notifyBody, headers);
    expect(before.statusCode).toBe(401);
    expect(settles).toEqual([]);

    const fetchMock = vi.fn(async () => signedResponse(certificateBody('ROTATED-SERIAL')));
    vi.stubGlobal('fetch', fetchMock);
    await (provider['refreshCertificates'] as () => Promise<unknown>)();

    const reply = await invokeCallback(notifyBody, headers);
    expect(reply.statusCode).toBe(200);
    expect(settles).toEqual([
      {
        providerId: 'wechatpay',
        merchantOrderNo: 'ORD-ROT',
        externalId: '4200009999',
        amount: 500,
        currency: 'CNY',
      },
    ]);
  });
});
