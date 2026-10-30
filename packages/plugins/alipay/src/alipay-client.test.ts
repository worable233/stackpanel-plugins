import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AlipayError,
  alipayTimestamp,
  buildCloseParams,
  buildPrecreateParams,
  canonicalize,
  configSchema,
  extractSignedNode,
  minorToYuan,
  parsePrecreateResponse,
  signRsa2,
  validateConfig,
  verifyCallback,
  verifyRsa2,
  yuanToMinor,
  type AlipayConfig,
} from './alipay-client.js';
import { assertGatewayUrl } from './index.js';

/**
 * 支付宝协议的验证策略（12.2）：商户凭据拿不到，但**协议本身可以验透**。
 * 这里用自签 RSA 密钥对扮演「商户私钥」和「支付宝密钥」，签名/验签/回调/金额换算
 * 全部跑真实 crypto —— 没有一处 mock 掉密码学。
 */
function keypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const merchant = keypair();
// 支付宝的密钥对：商户只持有它的公钥，用来验签响应与通知。
const alipay = keypair();

function config(overrides: Partial<AlipayConfig> = {}): AlipayConfig {
  return {
    appId: '2021000000000000',
    privateKey: merchant.privateKey,
    alipayPublicKey: alipay.publicKey,
    gatewayUrl: 'https://openapi.alipay.com/gateway.do',
    ...overrides,
  };
}

/** 构造一段「支付宝风格」的响应体：业务节点原文 + 对原文的签名。 */
function signedBody(node: Record<string, unknown>, signWith = alipay.privateKey): string {
  const raw = JSON.stringify(node);
  const sign = signRsa2(raw, signWith);
  return `{"alipay_trade_precreate_response":${raw},"sign":"${sign}"}`;
}

describe('canonicalize', () => {
  it('sorts by ASCII, drops sign and empty values', () => {
    expect(canonicalize({ b: '2', a: '1', sign: 'x', c: '', d: null })).toBe('a=1&b=2');
  });

  it('sorts uppercase before lowercase (ASCII, not locale)', () => {
    // localeCompare 在部分 locale 下会把大小写混排，支付宝用的是字节序。
    expect(canonicalize({ a: '1', Z: '2' })).toBe('Z=2&a=1');
  });
});

describe('RSA2 signing', () => {
  it('round-trips and rejects a tampered payload', () => {
    const sign = signRsa2('a=1&b=2', merchant.privateKey);
    expect(verifyRsa2('a=1&b=2', sign, merchant.publicKey)).toBe(true);
    expect(verifyRsa2('a=1&b=3', sign, merchant.publicKey)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const sign = signRsa2('a=1', merchant.privateKey);
    expect(verifyRsa2('a=1', sign, alipay.publicKey)).toBe(false);
  });

  it('accepts bare base64 keys pasted from the Alipay console', () => {
    const bare = merchant.privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');
    const sign = signRsa2('a=1', bare);
    expect(verifyRsa2('a=1', sign, merchant.publicKey)).toBe(true);
  });
});

describe('amounts', () => {
  it('converts minor units to yuan and back without float drift', () => {
    expect(minorToYuan(1234)).toBe('12.34');
    expect(yuanToMinor('12.34')).toBe(1234);
    expect(yuanToMinor('0.1') + yuanToMinor('0.2')).toBe(30);
    expect(yuanToMinor('7')).toBe(700);
  });

  it('rejects non-integer or non-positive amounts', () => {
    expect(() => minorToYuan(12.5)).toThrow(AlipayError);
    expect(() => minorToYuan(0)).toThrow(AlipayError);
    expect(() => yuanToMinor('12.345')).toThrow(AlipayError);
  });
});

describe('precreate request', () => {
  it('signs a request carrying the amount in yuan and FACE_TO_FACE product code', () => {
    const params = buildPrecreateParams(config(), {
      merchantOrderNo: 'ORD-1',
      amount: 1234,
      subject: '测试订单',
      notifyUrl: 'https://shop.example.com/callbacks/alipay',
      timeout: '15m',
    });
    expect(params['method']).toBe('alipay.trade.precreate');
    expect(params['sign_type']).toBe('RSA2');
    const biz = JSON.parse(params['biz_content'] as string) as Record<string, unknown>;
    expect(biz).toMatchObject({
      out_trade_no: 'ORD-1',
      total_amount: '12.34',
      product_code: 'FACE_TO_FACE_PAYMENT',
      timeout_express: '15m',
    });
    const { sign, ...rest } = params;
    expect(verifyRsa2(canonicalize(rest), sign as string, merchant.publicKey)).toBe(true);
  });

  it('closes by out_trade_no', () => {
    const params = buildCloseParams(config(), 'ORD-1');
    expect(params['method']).toBe('alipay.trade.close');
    expect(JSON.parse(params['biz_content'] as string)).toEqual({ out_trade_no: 'ORD-1' });
  });

  it('formats the timestamp in Beijing time, not ISO', () => {
    // 支付宝只认 `YYYY-MM-DD HH:mm:ss`，ISO 8601 会被直接拒。
    expect(alipayTimestamp(new Date('2026-10-25T16:30:05Z'))).toBe('2026-10-26 00:30:05');
  });
});

describe('gateway response', () => {
  it('verifies the signature over the raw node text and returns the QR code', () => {
    const body = signedBody({
      code: '10000',
      msg: 'Success',
      out_trade_no: 'ORD-1',
      qr_code: 'https://qr.alipay.com/bavh4wjlxf12tper3a',
    });
    const response = parsePrecreateResponse(body, config());
    expect(response.qr_code).toBe('https://qr.alipay.com/bavh4wjlxf12tper3a');
  });

  it('rejects a response signed by the wrong key', () => {
    const body = signedBody({ code: '10000', qr_code: 'x' }, merchant.privateKey);
    expect(() => parsePrecreateResponse(body, config())).toThrow(/响应签名无效/);
  });

  it('rejects a tampered node', () => {
    const body = signedBody({ code: '10000', out_trade_no: 'ORD-1', qr_code: 'https://qr/1' });
    const tampered = body.replace('https://qr/1', 'https://qr/2');
    expect(() => parsePrecreateResponse(tampered, config())).toThrow(/响应签名无效/);
  });

  it('treats a business error as definitive (no retry storm)', () => {
    const body = signedBody({ code: '40004', msg: 'Business Failed', sub_msg: '商户无权限' });
    try {
      parsePrecreateResponse(body, config());
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AlipayError);
      expect((error as AlipayError).definitive).toBe(true);
      expect((error as AlipayError).message).toContain('商户无权限');
    }
  });

  it('extracts a node containing nested objects and escaped quotes', () => {
    const inner = { code: '10000', extra: { a: { b: 'say "hi"' } } };
    const raw = JSON.stringify(inner);
    const body = `{"alipay_trade_precreate_response":${raw},"sign":"S"}`;
    const extracted = extractSignedNode(body, 'alipay_trade_precreate_response');
    expect(JSON.parse(extracted.raw)).toEqual(inner);
    expect(extracted.sign).toBe('S');
  });
});

describe('async notification', () => {
  function callbackParams(overrides: Record<string, string> = {}) {
    const params: Record<string, string> = {
      app_id: '2021000000000000',
      out_trade_no: 'ORD-1',
      trade_no: '2026102522001400000000000001',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
      notify_time: '2026-10-25 12:00:00',
      ...overrides,
    };
    return { ...params, sign: signRsa2(canonicalize(params), alipay.privateKey) };
  }

  it('accepts a correctly signed success notification', () => {
    expect(verifyCallback(callbackParams(), config())).toEqual({
      merchantOrderNo: 'ORD-1',
      externalId: '2026102522001400000000000001',
      amount: 1234,
      currency: 'CNY',
    });
  });

  it('returns null for non-settling states instead of throwing', () => {
    // 关闭/等待付款的通知不是错误：调用方照样要回 success，否则支付宝一直重推。
    expect(verifyCallback(callbackParams({ trade_status: 'TRADE_CLOSED' }), config())).toBeNull();
  });

  it('rejects a tampered notification', () => {
    const params = callbackParams();
    expect(() => verifyCallback({ ...params, total_amount: '0.01' }, config())).toThrow(
      /回调签名无效/,
    );
  });

  it('rejects a notification for another app id', () => {
    expect(() => verifyCallback(callbackParams({ app_id: 'other' }), config())).toThrow(
      /回调商户不匹配/,
    );
  });

  it('rejects a notification without a signature', () => {
    const { sign: _sign, ...params } = callbackParams();
    expect(() => verifyCallback(params, config())).toThrow(/回调签名无效/);
  });
});

describe('config validation', () => {
  it('accepts a well-formed config', () => {
    const parsed = configSchema.parse({
      appId: '2021000000000000',
      privateKey: merchant.privateKey,
      alipayPublicKey: alipay.publicKey,
    });
    // 未填网关时落到正式环境，避免沙箱地址被误用到生产。
    expect(validateConfig(parsed).gatewayUrl).toBe('https://openapi.alipay.com/gateway.do');
  });

  it('rejects unloadable keys at configure time, not at checkout time', () => {
    expect(() =>
      validateConfig({
        appId: 'x',
        privateKey: 'not-a-key-not-a-key-not-a-key-not-a-key-not-a-key-not-a-key-1234',
        alipayPublicKey: alipay.publicKey,
        gatewayUrl: 'https://openapi.alipay.com/gateway.do',
      }),
    ).toThrow(AlipayError);
  });

  it('only allows https gateway hosts, never IPs or internal names', () => {
    expect(() => assertGatewayUrl('http://openapi.alipay.com/gateway.do')).toThrow(/https/);
    expect(() => assertGatewayUrl('https://127.0.0.1/gateway.do')).toThrow(/IP/);
    expect(() => assertGatewayUrl('https://localhost/gateway.do')).toThrow(/内网/);
    expect(() =>
      assertGatewayUrl('https://openapi-sandbox.dl.alipaydev.com/gateway.do'),
    ).not.toThrow();
  });
});
