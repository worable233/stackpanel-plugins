import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EpayClient,
  canonicalize,
  decimalToMinor,
  loadPrivateKey,
  loadPublicKey,
  minorToDecimal,
  signParameters,
  validateConfig,
  verifyParameters,
} from './epay-client.js';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPrivate = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformPrivate = platform.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformPublic = platform.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Strip PEM armor to the bare base64 body the EasyPay panel exposes. */
function bareBody(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
}

describe('EasyPay RSA V2 primitives', () => {
  it('canonicalizes all non-empty scalar fields including unknown provider additions', () => {
    expect(
      canonicalize({
        z: 'last',
        sign: 'ignored',
        blank: '',
        extensions: ['ignored'],
        a: 'first',
        timestamp: 2,
      }),
    ).toBe('a=first&timestamp=2&z=last');
  });

  it('signs a request and verifies a platform callback', () => {
    const request = { pid: '1000', money: '10.00', out_trade_no: 'sp_top_1', sign_type: 'RSA' };
    expect(signParameters(request, merchantPrivate)).toMatch(/^[A-Za-z0-9+/=]+$/);
    const callback = { ...request, trade_status: 'TRADE_SUCCESS', trade_no: 'trade_1' };
    const signer = createSign('RSA-SHA256');
    signer.update(canonicalize(callback), 'utf8');
    signer.end();
    const signed = { ...callback, sign: signer.sign(platformPrivate, 'base64') };
    expect(verifyParameters(signed, platformPublic)).toBe(true);
    expect(verifyParameters({ ...signed, money: '9.99' }, platformPublic)).toBe(false);
  });

  it('converts money without floating point rounding', () => {
    expect(minorToDecimal(1)).toBe('0.01');
    expect(minorToDecimal(12345)).toBe('123.45');
    expect(decimalToMinor('123.45')).toBe(12345);
    expect(() => decimalToMinor('1.001')).toThrow();
  });

  it('validates a generic configured gateway without persisting secrets in settings', () => {
    expect(
      validateConfig({
        baseUrl: 'https://pay.example.com/',
        pid: 'merchant_1000',
        privateKey: merchantPrivate,
        platformPublicKey: platformPublic,
        methods: ['alipay', 'wxpay'],
      }),
    ).toMatchObject({ baseUrl: 'https://pay.example.com', methods: ['alipay', 'wxpay'] });
  });

  it('accepts the bare base64 key material copied from the EasyPay panel', () => {
    // The panel exposes keys without PEM armor, which Node's `createPrivateKey`
    // rejects. Regression for the "RSA 密钥材料无效" false negative.
    const config = validateConfig({
      baseUrl: 'https://pay.example.com',
      pid: '1001',
      privateKey: bareBody(merchantPrivate),
      platformPublicKey: bareBody(platformPublic),
      methods: ['wxpay'],
    });
    expect(config.methods).toEqual(['wxpay']);

    // Signing and verification must work with the normalized keys too.
    expect(loadPrivateKey(bareBody(merchantPrivate)).asymmetricKeyType).toBe('rsa');
    expect(loadPublicKey(bareBody(platformPublic)).asymmetricKeyType).toBe('rsa');
  });

  it('accepts PKCS#1 bare base64 key material', () => {
    const pkcs1 = merchant.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const spki = platform.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() =>
      validateConfig({
        baseUrl: 'https://pay.example.com',
        pid: '1001',
        privateKey: bareBody(pkcs1),
        platformPublicKey: bareBody(spki),
        methods: ['wxpay'],
      }),
    ).not.toThrow();
  });

  it('rejects genuinely unusable key material', () => {
    expect(() =>
      validateConfig({
        baseUrl: 'https://pay.example.com',
        pid: '1001',
        privateKey: 'not a key at all',
        platformPublicKey: bareBody(platformPublic),
        methods: ['wxpay'],
      }),
    ).toThrow();
  });
});

describe('EpayClient response handling', () => {
  // A public literal IP keeps `assertPublicGatewayUrl` off DNS; the stub fetch
  // means no request is actually sent.
  const config = validateConfig({
    baseUrl: 'https://8.8.8.8',
    pid: '1001',
    privateKey: bareBody(merchantPrivate),
    platformPublicKey: bareBody(platformPublic),
    methods: ['alipay'],
  });
  const payment = {
    method: 'alipay',
    merchantOrderNo: 'sp_top_1',
    amount: 1000,
    subject: 'probe',
    notifyUrl: 'https://example.com/notify',
    returnUrl: 'https://example.com/return',
  };
  const stub = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('surfaces an unsigned business rejection verbatim, not as a signature error', async () => {
    // EasyPay returns `{code:-1,msg}` unsigned; verifying it first masked the
    // real reason ("当前商户未完成实名认证，无法收款") behind "签名无效".
    const client = new EpayClient(
      config,
      stub({ code: -1, msg: '当前商户未完成实名认证，无法收款' }),
    );
    await expect(client.createPayment(payment)).rejects.toThrow(
      '当前商户未完成实名认证，无法收款',
    );
  });

  it('still rejects an unsigned success response', async () => {
    const client = new EpayClient(
      config,
      stub({ code: 0, trade_no: 'trade_1', pay_info: 'https://pay.example.com/1' }),
    );
    await expect(client.createPayment(payment)).rejects.toThrow('支付网关响应签名无效');
  });

  it('accepts a properly signed success response', async () => {
    const body = { code: 0, trade_no: 'trade_1', pay_info: 'https://pay.example.com/1' };
    const client = new EpayClient(
      config,
      stub({ ...body, sign: signParameters(body, platformPrivate) }),
    );
    await expect(client.createPayment(payment)).resolves.toEqual({
      externalId: 'trade_1',
      paymentUrl: 'https://pay.example.com/1',
    });
  });
});
