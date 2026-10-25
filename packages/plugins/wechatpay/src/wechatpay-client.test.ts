import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEST_PLATFORM_CERT_PEM } from './test-fixtures.js';
import {
  NOTIFICATION_TIMESTAMP_TOLERANCE_S,
  WechatPayError,
  assertApiBase,
  buildAuthorization,
  buildCloseOrderBody,
  buildNativeOrderBody,
  configSchema,
  decryptResource,
  encryptResource,
  loadPrivateKey,
  loadPublicKey,
  notificationSignMessage,
  PlatformKeyring,
  parseCertificateList,
  parseErrorBody,
  parseNativeOrderResponse,
  requestSignMessage,
  rsaSign,
  rsaVerify,
  sameAppId,
  validateConfig,
  verifyNotification,
} from './wechatpay-client.js';

/**
 * 扮演两方：商户（自己持有的 API 私钥）与微信支付（平台私钥，用来签应答/回调）。
 * 没有商户号也能把这些验透，因为这些都是纯密码学 + 报文格式。
 */
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
const API_V3_KEY = 'a'.repeat(32) + '1234567890'.slice(0, 0); // 32 chars

function baseConfig() {
  return {
    appId: 'wx1234567890abcdef',
    mchId: '1900000001',
    serialNo: '5157F09EFDC096DE15EBE81A47057A7232F1B8E1',
    privateKey: merchant.privateKey,
    apiV3Key: API_V3_KEY,
    platformPublicKey: platform.publicKey,
    apiBase: 'https://api.mch.weixin.qq.com',
  };
}

/** 微信发来的通知：JSON 信封 + 签名头。 */
function signedNotification(transaction: Record<string, unknown>, options?: { timestamp?: number; key?: string }) {
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
  const timestamp = String(options?.timestamp ?? Math.floor(Date.now() / 1000));
  const headerNonce = randomBytes(8).toString('hex');
  const signature = rsaSign(
    notificationSignMessage({ timestamp, nonce: headerNonce, body }),
    options?.key ?? platform.privateKey,
  );
  return {
    body,
    headers: { timestamp, nonce: headerNonce, signature, serial: 'CERT-SERIAL' },
  };
}

describe('pem handling', () => {
  it('accepts a bare base64 private key (what the console copies)', () => {
    const bare = merchant.privateKey
      .replace(/-----[A-Z ]+-----/g, '')
      .replace(/\s+/g, '');
    expect(() => loadPrivateKey(bare)).not.toThrow();
  });

  it('rejects garbage key material', () => {
    expect(() => loadPrivateKey('not-a-key')).toThrow(WechatPayError);
    expect(() => loadPublicKey('not-a-key')).toThrow(WechatPayError);
  });
});

describe('request signing', () => {
  it('signs METHOD\\nURL\\nTIMESTAMP\\nNONCE\\nBODY\\n (trailing newline included)', () => {
    const message = requestSignMessage({
      method: 'post',
      urlPath: '/v3/pay/transactions/native',
      timestamp: '1700000000',
      nonce: 'abc',
      body: '{}',
    });
    expect(message).toBe('POST\n/v3/pay/transactions/native\n1700000000\nabc\n{}\n');
    expect(
      rsaVerify(message, rsaSign(message, merchant.privateKey), loadPublicKey(merchant.publicKey)),
    ).toBe(true);
  });

  it('produces the WECHATPAY2-SHA256-RSA2048 authorization header', () => {
    const signed = buildAuthorization({
      method: 'POST',
      urlPath: '/v3/pay/transactions/native',
      body: '{"a":1}',
      mchId: '1900000001',
      serialNo: 'SERIAL',
      privateKey: loadPrivateKey(merchant.privateKey),
      timestamp: '1700000000',
      nonce: 'nonce123',
    });
    expect(signed.authorization).toMatch(
      /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="nonce123",signature="[^"]+",timestamp="1700000000",serial_no="SERIAL"$/,
    );
    expect(
      rsaVerify(
        requestSignMessage({
          method: 'POST',
          urlPath: '/v3/pay/transactions/native',
          timestamp: '1700000000',
          nonce: 'nonce123',
          body: '{"a":1}',
        }),
        signed.signature,
        loadPublicKey(merchant.publicKey),
      ),
    ).toBe(true);
  });
});

describe('response / notification verification', () => {
  it('verifies a well-formed notification', () => {
    const { body, headers } = signedNotification({ trade_state: 'SUCCESS' });
    expect(() =>
      verifyNotification({ headers, body, platformPublicKey: loadPublicKey(platform.publicKey) }),
    ).not.toThrow();
  });

  it('accepts query-style header lookups but rejects missing signature', () => {
    const { body } = signedNotification({ trade_state: 'SUCCESS' });
    expect(() =>
      verifyNotification({
        headers: { timestamp: String(Math.floor(Date.now() / 1000)), nonce: 'n' },
        body,
        platformPublicKey: loadPublicKey(platform.publicKey),
      }),
    ).toThrow(/回调报文无效/);
  });

  it('rejects a body modified after signing', () => {
    const { body, headers } = signedNotification({ trade_state: 'SUCCESS' });
    const tampered = body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.FAIL');
    expect(() =>
      verifyNotification({
        headers,
        body: tampered,
        platformPublicKey: loadPublicKey(platform.publicKey),
      }),
    ).toThrow(/签名无效/);
  });

  it('rejects a signature made with the wrong key', () => {
    const { body, headers } = signedNotification({ trade_state: 'SUCCESS' }, { key: merchant.privateKey });
    expect(() =>
      verifyNotification({ headers, body, platformPublicKey: loadPublicKey(platform.publicKey) }),
    ).toThrow(/签名无效/);
  });

  it('rejects a stale timestamp even with a valid signature (replay defence)', () => {
    const stale = Math.floor(Date.now() / 1000) - NOTIFICATION_TIMESTAMP_TOLERANCE_S - 60;
    const { body, headers } = signedNotification({ trade_state: 'SUCCESS' }, { timestamp: stale });
    expect(() =>
      verifyNotification({ headers, body, platformPublicKey: loadPublicKey(platform.publicKey) }),
    ).toThrow(/时间戳/);
  });
});

describe('callback decryption', () => {
  it('round-trips AES-256-GCM with associated data', () => {
    const plaintext = JSON.stringify({ out_trade_no: 'ORD-1', amount: { total: 1234 } });
    const ciphertext = encryptResource({
      plaintext,
      nonce: 'abcdefghijkl',
      associatedData: 'transaction',
      apiV3Key: API_V3_KEY,
    });
    expect(
      decryptResource({
        ciphertext,
        nonce: 'abcdefghijkl',
        associatedData: 'transaction',
        apiV3Key: API_V3_KEY,
      }),
    ).toBe(plaintext);
  });

  it('fails on a tampered auth tag instead of returning garbage', () => {
    const ciphertext = encryptResource({
      plaintext: '{"a":1}',
      nonce: 'abcdefghijkl',
      apiV3Key: API_V3_KEY,
    });
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() =>
      decryptResource({
        ciphertext: raw.toString('base64'),
        nonce: 'abcdefghijkl',
        apiV3Key: API_V3_KEY,
      }),
    ).toThrow(/解密失败/);
  });

  it('fails on the wrong APIv3 key (direction of trust, not just length)', () => {
    const ciphertext = encryptResource({
      plaintext: '{"a":1}',
      nonce: 'abcdefghijkl',
      apiV3Key: API_V3_KEY,
    });
    expect(() =>
      decryptResource({ ciphertext, nonce: 'abcdefghijkl', apiV3Key: 'b'.repeat(32) }),
    ).toThrow(/解密失败/);
  });

  it('rejects an APIv3 key that is not 32 bytes', () => {
    expect(() =>
      decryptResource({ ciphertext: 'AAAA', nonce: 'abcdefghijkl', apiV3Key: 'short' }),
    ).toThrow(/32 个字符/);
  });
});

describe('order payloads', () => {
  it('sends amounts in fen (no unit conversion) and pins CNY', () => {
    const body = buildNativeOrderBody(
      { appId: 'wx1', mchId: '1900' },
      {
        merchantOrderNo: 'ORD-1',
        amount: 1234,
        subject: '测试订单',
        notifyUrl: 'https://shop.example.com/callbacks/wechatpay',
      },
    );
    expect(body['amount']).toEqual({ total: 1234, currency: 'CNY' });
    expect(body['out_trade_no']).toBe('ORD-1');
    expect(body).not.toHaveProperty('time_expire');
  });

  it('adds time_expire in WeChat’s +08:00-friendly ISO form', () => {
    const body = buildNativeOrderBody(
      { appId: 'wx1', mchId: '1900' },
      {
        merchantOrderNo: 'ORD-1',
        amount: 1,
        subject: 'x',
        notifyUrl: 'https://x/cb',
        expiresInMs: 60_000,
      },
    );
    expect(String(body['time_expire'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });

  it('clamps an over-long description to 127 chars (WeChat rejects longer)', () => {
    const body = buildNativeOrderBody(
      { appId: 'wx1', mchId: '1900' },
      { merchantOrderNo: 'O', amount: 1, subject: 'x'.repeat(300), notifyUrl: 'https://x/cb' },
    );
    expect(String(body['description']).length).toBe(127);
  });

  it('parses code_url and reports a malformed body as definitive', () => {
    expect(parseNativeOrderResponse('{"code_url":"weixin://wxpay/1"}').code_url).toBe('weixin://wxpay/1');
    expect(() => parseNativeOrderResponse('<html>502</html>')).toThrow(/不是 JSON/);
  });

  it('parses the WeChat error envelope', () => {
    expect(parseErrorBody('{"code":"PARAM_ERROR","message":"缺少参数"}')).toEqual({
      code: 'PARAM_ERROR',
      message: '缺少参数',
    });
    expect(parseErrorBody('not json')).toEqual({});
  });

  it('builds the close-order body with mchid only', () => {
    expect(buildCloseOrderBody({ mchId: '1900' })).toEqual({ mchid: '1900' });
  });
});

describe('config validation', () => {
  it('accepts a complete config and resolves keys', () => {
    const resolved = validateConfig(configSchema.parse(baseConfig()));
    expect(resolved.apiBase).toBe('https://api.mch.weixin.qq.com');
    expect(resolved.privateKeyObject.asymmetricKeyType).toBe('rsa');
  });

  it('rejects an APIv3 key that is not exactly 32 chars', () => {
    const bad = { ...baseConfig(), apiV3Key: 'short' };
    // 表单层就挡住：zod 的长度约束先于 validateConfig 的字节长度检查。
    expect(() => configSchema.parse(bad)).toThrow(/apiV3Key/);
  });

  it('rejects unloadable platform public key at configure time, not at callback time', () => {
    const bad = { ...baseConfig(), platformPublicKey: 'x'.repeat(64) };
    expect(() => validateConfig(configSchema.parse(bad))).toThrow(/密钥材料无效/);
  });

  it('refuses non-https / IP / internal API bases', () => {
    expect(() => assertApiBase('http://api.mch.weixin.qq.com')).toThrow(/https/);
    expect(() => assertApiBase('https://127.0.0.1')).toThrow(/IP/);
    expect(() => assertApiBase('https://localhost')).toThrow(/内网/);
    expect(assertApiBase('https://api.mch.weixin.qq.com/')).toBe('https://api.mch.weixin.qq.com');
  });

  it('compares app ids in constant time and still distinguishes them', () => {
    expect(sameAppId('wx1', 'wx1')).toBe(true);
    expect(sameAppId('wx1', 'wx2')).toBe(false);
    expect(sameAppId('wx1', 'wx10')).toBe(false);
  });
});


describe('platform certificate list', () => {
  function certificateResponse(options?: { serialNo?: string; expiresAtMs?: number }): string {
    const nonce = 'abcdefghijkl';
    const ciphertext = encryptResource({
      // PEM 就是证书本身；微信把整张证书加密下发，不是只发公钥。
      plaintext: TEST_PLATFORM_CERT_PEM,
      nonce,
      associatedData: 'certificate',
      apiV3Key: API_V3_KEY,
    });
    return JSON.stringify({
      data: [
        {
          serial_no: options?.serialNo ?? 'CERT-SERIAL-1',
          effective_time: '2026-01-01T00:00:00+08:00',
          expire_time: '2036-01-01T00:00:00+08:00',
          encrypt_certificate: {
            algorithm: 'AEAD_AES_256_GCM',
            nonce,
            associated_data: 'certificate',
            ciphertext,
          },
        },
      ],
    });
  }

  it('decrypts the certificate, keeps its serial and real expiry', () => {
    const [certificate] = parseCertificateList(certificateResponse(), API_V3_KEY);
    expect(certificate?.serialNo).toBe('CERT-SERIAL-1');
    // 有效期取自证书本身（X509 validTo），不是应答里的 expire_time 字段。
    expect(certificate?.expiresAtMs).toBeGreaterThan(Date.now());
    expect(certificate?.publicKey.asymmetricKeyType).toBe('rsa');
    expect(certificate?.certificatePem).toContain('BEGIN CERTIFICATE');
  });

  it('drops certificates that already expired instead of trusting them', () => {
    // now 放到 2037 年：整张证书都过期，列表为空 ⇒ 明确报错，而不是装一张废证书。
    expect(() => parseCertificateList(certificateResponse(), API_V3_KEY, Date.parse('2037-01-01T00:00:00Z'))).toThrow(
      /没有可用证书/,
    );
  });

  it('rejects a body that is not the documented envelope', () => {
    expect(() => parseCertificateList('<html>', API_V3_KEY)).toThrow(/不是 JSON/);
    expect(() => parseCertificateList('{"data":{}}', API_V3_KEY)).toThrow(/格式无效/);
  });

  it('fails when the APIv3 key cannot decrypt (wrong merchant key)', () => {
    expect(() => parseCertificateList(certificateResponse(), 'b'.repeat(32))).toThrow(/解密失败/);
  });

  it('keyring picks the key named by Wechatpay-Serial, not "the only one"', () => {
    const fallback = loadPublicKey(platform.publicKey);
    const keyring = new PlatformKeyring(fallback);
    const [certificate] = parseCertificateList(certificateResponse(), API_V3_KEY);
    if (!certificate) throw new Error('fixture missing');
    keyring.replace([certificate]);

    expect(keyring.size).toBe(1);
    expect(keyring.forSerial('CERT-SERIAL-1')?.asymmetricKeyType).toBe('rsa');
    // 未知序列号（轮换窗口里的旧号）退回任一仍有效证书，而不是直接失败。
    expect(keyring.forSerial('SOMETHING-ELSE')?.asymmetricKeyType).toBe('rsa');
    // 没有 fallback、也没有有效证书时必须返回 undefined，让调用方拒绝验签。
    const empty = new PlatformKeyring();
    expect(empty.forSerial('CERT-SERIAL-1')).toBeUndefined();
  });

  it('keyring ignores certificates that expired after being loaded', () => {
    const keyring = new PlatformKeyring(loadPublicKey(platform.publicKey));
    keyring.replace([
      {
        serialNo: 'OLD',
        certificatePem: TEST_PLATFORM_CERT_PEM,
        publicKey: loadPublicKey(TEST_PLATFORM_CERT_PEM),
        expiresAtMs: Date.now() - 1,
      },
    ]);
    expect(keyring.describe()).toEqual([]);
    expect(keyring.forSerial('OLD')).toBeDefined(); // 退回 fallback，不是抛错
  });
});
