import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import type {
  ExternalPaymentInitiation,
  ExternalPaymentInitiationResult,
  ExternalPaymentRequest,
  HttpReply,
  HttpRequest,
  PaymentMethod,
  PaymentProvider,
  PluginContext,
  RawHttpReply,
  RawHttpRequest,
} from '@stackpanel/sdk';
import {
  WECHATPAY_DEFAULT_API_BASE,
  WechatPayError,
  buildAuthorization,
  buildCloseOrderBody,
  buildNativeOrderBody,
  configSchema,
  decryptResource,
  parseErrorBody,
  parseNativeOrderResponse,
  sameAppId,
  validateConfig,
  verifyNotification,
  type DecryptedTransaction,
  type NotificationHeaders,
  type WechatPayConfig,
} from './wechatpay-client.js';

const CONFIG_KEY = 'gateway-config';
const WECHATPAY_METHOD: PaymentMethod = {
  id: 'wechat_native',
  label: '微信支付',
  topUpAmounts: [1000, 3000, 5000, 10000],
};

type ResolvedConfig = ReturnType<typeof validateConfig>;

/**
 * 微信支付 v3 Native 直连（对标 #12.2 的微信半边）。
 *
 * 与支付宝的三处结构差异：
 * 1. 请求带 `Authorization: WECHATPAY2-SHA256-RSA2048 ...` 而不是表单里的 `sign`；
 * 2. 应答与回调都是 **JSON + 响应头签名**，验签要用原始报文；
 * 3. 回调 `resource` 是 AES-256-GCM 密文，要用 APIv3 密钥解出交易。
 */
class WechatPayService implements PaymentProvider {
  readonly id = 'wechatpay';
  readonly name = '微信支付';
  readonly mode = 'gateway' as const;
  readonly callbackPath = '/callbacks/wechatpay';
  private config: ResolvedConfig | null = null;
  /** 原始配置（含密钥明文），只用于「留空保持不变」时回填，永不外泄。 */
  private raw: WechatPayConfig | null = null;

  constructor(private readonly ctx: PluginContext) {}

  async load(): Promise<void> {
    try {
      const methodConfig = await this.ctx.payments.getProviderConfig('wechatpay');
      if (methodConfig) {
        const parsed = configSchema.parse(methodConfig);
        this.config = validateConfig(parsed);
        this.raw = parsed;
        return;
      }
    } catch (error) {
      this.ctx.logger.warn(
        `wechatpay: could not load config from payment methods: ${String(error)}`,
      );
    }

    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      const parsed = configSchema.parse(JSON.parse(saved));
      this.config = validateConfig(parsed);
      this.raw = parsed;
    } catch {
      this.ctx.logger.warn('wechatpay: stored configuration is invalid and has been disabled');
      this.config = null;
    }
  }

  getMethods(): PaymentMethod[] {
    return this.config ? [WECHATPAY_METHOD] : [];
  }

  async createPayment(
    request: ExternalPaymentRequest,
    config?: unknown,
  ): Promise<ExternalPaymentInitiationResult> {
    const resolved = config ? this.parseConfig(config) : this.requireConfig();
    if (request.currency !== 'CNY') {
      throw new WechatPayError('unsupported-currency', undefined, 400, true);
    }

    const urlPath = '/v3/pay/transactions/native';
    const payload = buildNativeOrderBody(resolved, {
      merchantOrderNo: request.merchantOrderNo,
      amount: request.amount,
      subject: request.subject,
      notifyUrl: request.notifyUrl,
      expiresInMs: 2 * 60 * 60_000,
    });
    const body = JSON.stringify(payload);
    const response = await this.send(resolved, 'POST', urlPath, body);
    const parsed = parseNativeOrderResponse(response);
    if (!parsed.code_url) {
      throw new WechatPayError('order-create-failed', '微信支付未返回二维码内容', 502, true);
    }

    const initiation: ExternalPaymentInitiation = {
      externalId: request.merchantOrderNo,
      // Native 返回的是二维码内容（weixin://wxpay/...），前端渲染成二维码。
      paymentUrl: parsed.code_url,
      expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
    };
    return initiation;
  }

  async closePayment(request: { merchantOrderNo: string }): Promise<boolean> {
    const config = this.requireConfig();
    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(request.merchantOrderNo)}/close`;
    const body = JSON.stringify(buildCloseOrderBody(config));
    try {
      await this.send(config, 'POST', urlPath, body, { expectEmpty: true });
      return true;
    } catch (error) {
      // 订单在微信侧不存在 = 本来就没关单的必要，视为已关闭；其它错误不假装成功，
      // 让内核保留支付记录等过期扫描。
      if (error instanceof WechatPayError && /ORDER_NOT_EXIST|ORDERNOTEXIST/.test(error.message)) {
        return true;
      }
      this.ctx.logger.warn(`wechatpay: close failed: ${String(error)}`);
      return false;
    }
  }

  async status(): Promise<unknown> {
    return {
      configured: this.config !== null,
      secretsEnabled: this.ctx.secrets.isAvailable(),
      ...(this.config
        ? {
            appId: this.config.appId,
            mchId: this.config.mchId,
            serialNo: this.config.serialNo,
            apiBase: this.config.apiBase,
            methods: this.getMethods(),
          }
        : {}),
    };
  }

  async configure(input: unknown): Promise<unknown> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new WechatPayError('config-invalid', '密钥存储未配置', 503, true);
    }
    // 密钥留空 = 保持不变。后台不回显密钥材料，所以「改个商户号」不该逼管理员
    // 把三份密钥重新粘贴一遍；但继承只发生在**已存过配置**的前提下。
    const merged = await this.inheritSecrets(input);
    const parsed = configSchema.safeParse(merged);
    if (!parsed.success) {
      throw new WechatPayError('config-invalid', undefined, 400, true);
    }
    const config = validateConfig(parsed.data);
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(parsed.data));
    this.config = config;
    this.raw = parsed.data;
    return this.status();
  }

  /**
   * 回调（原始报文路由）。
   *
   * 验签必须用**原始字节**：内核的 JSON 解析会把报文重新序列化，字段顺序/空格/转义
   * 一旦与微信发来的不同，签名就永远验不过 —— 这不是偶发 bug，是必然。
   */
  async handleNotification(
    rawBody: string,
    headers: NotificationHeaders,
  ): Promise<{ settled: boolean }> {
    const config = this.requireConfig();
    verifyNotification({
      headers,
      body: rawBody,
      platformPublicKey: config.platformKeyObject,
    });

    let envelope: { resource?: { ciphertext?: string; nonce?: string; associated_data?: string } };
    try {
      envelope = JSON.parse(rawBody) as typeof envelope;
    } catch {
      throw new WechatPayError('notification-invalid', undefined, 401, true);
    }
    const resource = envelope.resource;
    if (!resource?.ciphertext || !resource.nonce) {
      throw new WechatPayError('notification-invalid', undefined, 401, true);
    }

    const plaintext = decryptResource({
      ciphertext: resource.ciphertext,
      nonce: resource.nonce,
      associatedData: resource.associated_data,
      apiV3Key: config.apiV3Key,
    });
    let transaction: DecryptedTransaction;
    try {
      transaction = JSON.parse(plaintext) as DecryptedTransaction;
    } catch {
      throw new WechatPayError('notification-invalid', '回调交易报文不是 JSON', 401, true);
    }

    if (transaction.appid && !sameAppId(transaction.appid, config.appId)) {
      throw new WechatPayError('appid-mismatch', undefined, 401, true);
    }

    // 只有 SUCCESS 才结算；PROCESSING/CLOSED/REFUND 等直接确认收到，避免微信重推。
    if (transaction.trade_state !== 'SUCCESS') return { settled: false };
    const amount = transaction.amount?.total;
    const orderNo = transaction.out_trade_no;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || !orderNo) {
      throw new WechatPayError('notification-invalid', '回调交易缺少金额或订单号', 401, true);
    }

    await this.ctx.payments.settle({
      providerId: this.id,
      merchantOrderNo: orderNo,
      externalId: transaction.transaction_id ?? orderNo,
      amount,
      currency: 'CNY',
    });
    return { settled: true };
  }

  private async send(
    config: ResolvedConfig,
    method: 'GET' | 'POST',
    urlPath: string,
    body: string,
    options?: { expectEmpty?: boolean },
  ): Promise<string> {
    const signed = buildAuthorization({
      method,
      urlPath,
      body,
      mchId: config.mchId,
      serialNo: config.serialNo,
      privateKey: config.privateKeyObject,
    });

    let response: Response;
    try {
      response = await fetch(`${config.apiBase}${urlPath}`, {
        method,
        headers: {
          authorization: signed.authorization,
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'stackpanel-wechatpay/0.1.0',
        },
        ...(method === 'GET' ? {} : { body }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new WechatPayError('request-failed');
    }

    const text = options?.expectEmpty && response.status === 204 ? '' : await response.text();
    if (!response.ok) {
      const parsed = parseErrorBody(text);
      throw new WechatPayError(
        'gateway-error',
        `${parsed.code ?? 'UNKNOWN'}${parsed.message ? `: ${parsed.message}` : ''}`,
        response.status === 400 || response.status === 403 ? 502 : 502,
        response.status < 500,
      );
    }
    // 应答验签：没有签名的应答不能信（中间人可伪造 code_url）。
    verifyNotification({
      headers: {
        timestamp: response.headers.get('wechatpay-timestamp') ?? undefined,
        nonce: response.headers.get('wechatpay-nonce') ?? undefined,
        signature: response.headers.get('wechatpay-signature') ?? undefined,
        serial: response.headers.get('wechatpay-serial') ?? undefined,
      },
      body: text,
      platformPublicKey: config.platformKeyObject,
    });
    return text;
  }

  private async inheritSecrets(input: unknown): Promise<unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    // 配置可能来自 payment_methods（内核主路径）而不是插件 secrets，所以先看内存里
    // 已加载的那份，再退回 secrets。
    let previous: Record<string, unknown> = this.raw ? { ...this.raw } : {};
    if (!this.raw) {
      const saved = await this.ctx.secrets.get(CONFIG_KEY);
      if (!saved) return input;
      try {
        previous = JSON.parse(saved) as Record<string, unknown>;
      } catch {
        return input;
      }
    }
    const patch = input as Record<string, unknown>;
    const next: Record<string, unknown> = { ...patch };
    for (const key of ['privateKey', 'platformPublicKey', 'apiV3Key'] as const) {
      const value = patch[key];
      if (typeof value === 'string' && value.trim() === '' && typeof previous[key] === 'string') {
        next[key] = previous[key];
      }
    }
    return next;
  }

  private parseConfig(config: unknown): ResolvedConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new WechatPayError('config-invalid', undefined, 503, true);
    return validateConfig(parsed.data);
  }

  private requireConfig(): ResolvedConfig {
    if (!this.config) throw new WechatPayError('config-missing', undefined, 503, true);
    return this.config;
  }
}

async function readStream(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof WechatPayError) throw new PluginError(error.code, error.status, error.message);
      throw error;
    }
  };
}

let service: WechatPayService | null = null;

export const wechatpayPlugin = definePlugin({
  manifest: {
    id: 'wechatpay',
    name: '微信支付（Native）',
    version: '0.1.0',
    description: '微信支付 v3 Native 直连：扫码支付 + 回调验签与 AES-GCM 解密，不经过第三方聚合。',
    provides: [EXTENSION_POINTS.paymentProvider],
    permissions: ['wechatpay.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['wechatpay.admin'] }],
  },
  routes: [
    {
      method: 'GET',
      path: '/wechatpay/admin/config',
      auth: 'admin',
      permission: 'wechatpay.admin',
      handler: handle(async () => {
        if (!service) throw new WechatPayError('config-missing', '微信支付插件未就绪', 503, true);
        return service.status();
      }),
    },
    {
      method: 'POST',
      path: '/wechatpay/admin/config',
      auth: 'admin',
      permission: 'wechatpay.admin',
      handler: handle(async (req) => {
        if (!service) throw new WechatPayError('config-missing', '微信支付插件未就绪', 503, true);
        return service.configure(req.body);
      }),
    },
    {
      // 原始报文路由：验签需要未经解析的字节（见 handleNotification 注释）。
      kind: 'raw',
      method: 'POST',
      path: '/callbacks/wechatpay',
      auth: 'public',
      handler: async (req: RawHttpRequest, reply: RawHttpReply): Promise<void> => {
        const rawBody = await readStream(req.body);
        try {
          if (!service) throw new WechatPayError('config-missing', '微信支付插件未就绪', 503, true);
          await service.handleNotification(rawBody, {
            timestamp: headerValue(req.headers, 'wechatpay-timestamp'),
            nonce: headerValue(req.headers, 'wechatpay-nonce'),
            signature: headerValue(req.headers, 'wechatpay-signature'),
            serial: headerValue(req.headers, 'wechatpay-serial'),
          });
          reply
            .status(200)
            .header('content-type', 'application/json')
            .end(JSON.stringify({ code: 'SUCCESS', message: '成功' }));
        } catch (error) {
          // 回 4xx 会让微信重推 —— 这是对的：验签失败/解密失败说明报文不可信，必须让它重试。
          const status = error instanceof WechatPayError ? error.status : 500;
          const message = error instanceof Error ? error.message : 'unknown';
          reply
            .status(status)
            .header('content-type', 'application/json')
            .end(JSON.stringify({ code: 'FAIL', message }));
        }
      },
    },
  ],
  onActivate: async (ctx) => {
    service = new WechatPayService(ctx);
    await service.load();
    ctx.registerExtension<PaymentProvider>(EXTENSION_POINTS.paymentProvider, service);
    ctx.logger.info(
      `wechatpay: activated (${service.getMethods().length > 0 ? 'configured' : 'not configured'})`,
    );
  },
  onDeactivate: (ctx) => {
    service = null;
    ctx.logger.info('wechatpay: deactivated');
  },
});

export default wechatpayPlugin;
export { WECHATPAY_DEFAULT_API_BASE };
