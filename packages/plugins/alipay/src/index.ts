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
} from '@stackpanel/sdk';
import {
  ALIPAY_DEFAULT_GATEWAY,
  AlipayError,
  buildCloseParams,
  buildPrecreateParams,
  configSchema,
  parsePrecreateResponse,
  validateConfig,
  verifyCallback,
  type AlipayConfig,
} from './alipay-client.js';

const CONFIG_KEY = 'gateway-config';
const ALIPAY_METHOD: PaymentMethod = {
  id: 'alipay',
  label: '支付宝',
  topUpAmounts: [1000, 3000, 5000, 10000],
};

/**
 * 支付宝「当面付」直连（对标 #12.2 的支付宝半边）。
 *
 * 与 epay 的区别：不经过第三方聚合，商户号/应用私钥/支付宝公钥都由平台自己持有。
 * 代价是运维要自己配密钥，收益是不再被中间商抽成、也不再受其可用性影响。
 */
class AlipayService implements PaymentProvider {
  readonly id = 'alipay';
  readonly name = '支付宝';
  readonly mode = 'gateway' as const;
  readonly callbackPath = '/callbacks/alipay';
  private config: AlipayConfig | null = null;

  constructor(private readonly ctx: PluginContext) {}

  async load(): Promise<void> {
    // 主路径：绑定到 payment_methods 的配置（内核已按 providerId 取第一个启用的方法）。
    try {
      const methodConfig = await this.ctx.payments.getProviderConfig('alipay');
      if (methodConfig) {
        const parsed = configSchema.parse(methodConfig);
        this.config = validateConfig(parsed);
        return;
      }
    } catch (error) {
      this.ctx.logger.warn(`alipay: could not load config from payment methods: ${String(error)}`);
    }

    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      this.config = validateConfig(configSchema.parse(JSON.parse(saved)));
    } catch {
      this.ctx.logger.warn('alipay: stored gateway configuration is invalid and has been disabled');
      this.config = null;
    }
  }

  getMethods(): PaymentMethod[] {
    return this.config ? [ALIPAY_METHOD] : [];
  }

  async createPayment(
    request: ExternalPaymentRequest,
    config?: unknown,
  ): Promise<ExternalPaymentInitiationResult> {
    const resolved = config ? this.parseConfig(config) : this.requireConfig();
    // 当面付只结算人民币。跨币种由内核换算成结算币种后再进来，这里不接受别的币种。
    if (request.currency !== 'CNY') throw new AlipayError(400, '支付宝仅支持 CNY 币种', true);

    const params = buildPrecreateParams(resolved, {
      merchantOrderNo: request.merchantOrderNo,
      amount: request.amount,
      subject: request.subject,
      notifyUrl: request.notifyUrl,
      timeout: '15m',
    });

    const body = await this.post(resolved.gatewayUrl, params);
    const response = parsePrecreateResponse(body, resolved);
    const initiation: ExternalPaymentInitiation = {
      externalId: response.out_trade_no ?? request.merchantOrderNo,
      // 当面付返回的是二维码内容（不是可跳转网页），前端据此渲染二维码。
      paymentUrl: response.qr_code as string,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    return initiation;
  }

  async closePayment(request: { merchantOrderNo: string }): Promise<boolean> {
    const config = this.requireConfig();
    const body = await this.post(
      config.gatewayUrl,
      buildCloseParams(config, request.merchantOrderNo),
    );
    // 关单失败不做「本地已关」的假象：返回 false 让内核保留支付记录，等过期扫描处理。
    return body.includes('"code":"10000"') || body.includes('"code":"40004"');
  }

  async status(): Promise<unknown> {
    return {
      configured: this.config !== null,
      secretsEnabled: this.ctx.secrets.isAvailable(),
      ...(this.config
        ? {
            appId: this.config.appId,
            gatewayUrl: this.config.gatewayUrl,
            methods: this.getMethods(),
          }
        : {}),
    };
  }

  async configure(input: unknown): Promise<unknown> {
    if (!this.ctx.secrets.isAvailable()) throw new AlipayError(503, '密钥存储未配置');
    const parsed = configSchema.safeParse(input);
    if (!parsed.success) throw new AlipayError(400, '支付宝配置参数无效', true);
    const config = validateConfig(parsed.data);
    assertGatewayUrl(config.gatewayUrl);
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(config));
    this.config = config;
    return this.status();
  }

  /**
   * 异步通知。**无论是否结算都要回 `success`** —— 回 4xx 支付宝会一直重推，
   * 而「交易关闭」这类通知本来就不该结算，重推多少次结果都一样。
   */
  async callback(req: HttpRequest, reply: HttpReply): Promise<unknown> {
    const config = this.requireConfig();
    const params = mergeParams(req.body, req.query);
    const settlement = verifyCallback(params, config);
    if (!settlement) return reply.send('success');
    await this.ctx.payments.settle({
      providerId: this.id,
      merchantOrderNo: settlement.merchantOrderNo,
      externalId: settlement.externalId,
      amount: settlement.amount,
      currency: settlement.currency,
    });
    return reply.send('success');
  }

  private async post(url: string, params: Record<string, string>): Promise<string> {
    const form = new URLSearchParams(params);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AlipayError(502, '无法连接支付网关');
    }
    if (!response.ok) {
      throw new AlipayError(502, `Payment gateway returned HTTP ${response.status}`);
    }
    return response.text();
  }

  private parseConfig(config: unknown): AlipayConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new AlipayError(503, '支付宝配置参数无效');
    return validateConfig(parsed.data);
  }

  private requireConfig(): AlipayConfig {
    if (!this.config) throw new AlipayError(503, '支付宝尚未配置');
    return this.config;
  }
}

/** 回调参数可能来自 body（POST 表单）或 query（少数网关版本）。 */
function mergeParams(body: unknown, query: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const source of [query, body]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (Array.isArray(value) || (typeof value !== 'string' && typeof value !== 'number')) {
        throw new AlipayError(400, '回调参数无效', true);
      }
      params[key] = String(value);
    }
  }
  return params;
}

/**
 * 网关地址校验：必须是 https，且不能是 IP 字面量或内网域名。
 *
 * 允许自定义网关是为了沙箱；但「可配置的出站地址」天然是 SSRF 入口，
 * 所以只给域名、只给 https。
 */
export function assertGatewayUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AlipayError(400, '网关 URL 无效', true);
  }
  if (url.protocol !== 'https:') throw new AlipayError(400, '网关 URL 必须使用 https', true);
  const host = url.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    throw new AlipayError(400, '网关 URL 不能是 IP 地址', true);
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new AlipayError(400, '网关 URL 不能指向内网', true);
  }
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof AlipayError)
        throw new PluginError(error.code, error.status, error.message);
      throw error;
    }
  };
}

let service: AlipayService | null = null;

export const alipayPlugin = definePlugin({
  manifest: {
    id: 'alipay',
    name: '支付宝（当面付）',
    version: '0.1.0',
    description: '支付宝当面付直连：扫码支付 + 异步通知验签，不经过第三方聚合网关。',
    provides: [EXTENSION_POINTS.paymentProvider],
    permissions: ['alipay.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['alipay.admin'] }],
  },
  routes: [
    {
      method: 'GET',
      path: '/alipay/admin/config',
      auth: 'admin',
      permission: 'alipay.admin',
      handler: handle(
        async () => service?.status() ?? Promise.reject(new AlipayError(503, '支付宝插件未就绪')),
      ),
    },
    {
      method: 'POST',
      path: '/alipay/admin/config',
      auth: 'admin',
      permission: 'alipay.admin',
      handler: handle(
        async (req) =>
          service?.configure(req.body) ?? Promise.reject(new AlipayError(503, '支付宝插件未就绪')),
      ),
    },
    {
      method: 'POST',
      path: '/callbacks/alipay',
      auth: 'public',
      handler: handle(
        async (req, reply) =>
          service?.callback(req, reply) ?? Promise.reject(new AlipayError(503, '支付宝插件未就绪')),
      ),
    },
  ],
  onActivate: async (ctx) => {
    service = new AlipayService(ctx);
    await service.load();
    ctx.registerExtension<PaymentProvider>(EXTENSION_POINTS.paymentProvider, service);
    ctx.logger.info(
      `alipay: activated (${service.getMethods().length > 0 ? 'configured' : 'not configured'})`,
    );
  },
  onDeactivate: (ctx) => {
    service = null;
    ctx.logger.info('alipay: deactivated');
  },
});

export default alipayPlugin;
export { ALIPAY_DEFAULT_GATEWAY };
