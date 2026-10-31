import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import type {
  ExternalPaymentInitiation,
  ExternalPaymentInitiationResult,
  ExternalPaymentRequest,
  HttpReply,
  HttpRequest,
  ManualPaymentInstructions,
  PaymentMethod,
  PaymentProvider,
  PluginContext,
} from '@stackpanel/sdk';
import { z } from 'zod';
import {
  assertPublicGatewayUrl,
  decimalToMinor,
  EpayClient,
  EpayError,
  type EpayConfig,
  validateConfig,
  verifyParameters,
} from './epay-client.js';

const CONFIG_KEY = 'gateway-config';
const paymentTypeSchema = z.enum(['alipay', 'wxpay', 'qqpay']);

const configSchema = z.object({
  baseUrl: z.string().trim().min(1).max(191),
  pid: z.string().trim().min(1).max(64),
  privateKey: z.string().min(64).max(20_000),
  platformPublicKey: z.string().min(64).max(20_000),
  methods: z.array(paymentTypeSchema).min(1).max(3),
});

const configInputSchema = configSchema.extend({
  methods: z
    .string()
    .max(64)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(z.array(paymentTypeSchema).min(1).max(3)),
});

const methodMeta: Record<z.infer<typeof paymentTypeSchema>, PaymentMethod> = {
  alipay: { id: 'alipay', label: '支付宝', topUpAmounts: [1000, 3000, 5000, 10000] },
  wxpay: { id: 'wxpay', label: '微信支付', topUpAmounts: [1000, 3000, 5000, 10000] },
  qqpay: { id: 'qqpay', label: 'QQ 钱包', topUpAmounts: [1000, 3000, 5000, 10000] },
};

/**
 * Epay gateway adapter. Configuration lives on `payment_method` rows (resolved
 * by the kernel and passed to {@link createPayment}); plugin-scoped secrets are
 * kept as a legacy fallback. Epay only settles in CNY — the kernel converts the
 * order to its settlement currency before creating a payment.
 */
class EpayService implements PaymentProvider {
  readonly id = 'epay';
  readonly name = '易支付';
  readonly mode = 'gateway' as const;
  readonly callbackPath = '/callbacks/epay';
  private config: EpayConfig | null = null;

  constructor(private readonly ctx: PluginContext) {}

  async load(): Promise<void> {
    // Primary: config from the bound payment_method rows (single-merchant
    // platform → first active epay method), resolved by the kernel service.
    // Fallback: legacy plugin secret.
    try {
      const methodConfig = await this.ctx.payments.getProviderConfig('epay');
      if (methodConfig) {
        const parsed = configSchema.parse(methodConfig);
        this.config = validateConfig(parsed);
        return;
      }
    } catch (error) {
      this.ctx.logger.warn(`epay: could not load config from payment methods: ${String(error)}`);
    }

    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      const parsed = configSchema.parse(JSON.parse(saved));
      this.config = validateConfig(parsed);
    } catch {
      this.ctx.logger.warn('epay: stored gateway configuration is invalid and has been disabled');
      this.config = null;
    }
  }

  getMethods(): PaymentMethod[] {
    return this.config?.methods.map((method) => methodMeta[method]) ?? [];
  }

  async createPayment(
    request: ExternalPaymentRequest,
    config?: unknown,
  ): Promise<ExternalPaymentInitiationResult> {
    const resolved = config ? this.parseConfig(config) : this.requireConfig();
    if (request.currency !== 'CNY') throw new EpayError(400, '易支付仅支持 CNY 币种', true);
    const result = await new EpayClient(resolved).createPayment({
      method: request.method,
      merchantOrderNo: request.merchantOrderNo,
      amount: request.amount,
      subject: request.subject,
      notifyUrl: request.notifyUrl,
      returnUrl: request.returnUrl,
      ...(request.clientIp ? { clientIp: request.clientIp } : {}),
    });
    return result as ExternalPaymentInitiation;
  }

  async closePayment(request: { merchantOrderNo: string }): Promise<boolean> {
    return new EpayClient(this.requireConfig()).closePayment(request.merchantOrderNo);
  }

  async status(): Promise<unknown> {
    return {
      configured: this.config !== null,
      secretsEnabled: this.ctx.secrets.isAvailable(),
      ...(this.config
        ? { baseUrl: this.config.baseUrl, pid: this.config.pid, methods: this.getMethods() }
        : {}),
    };
  }

  async configure(input: unknown): Promise<unknown> {
    if (!this.ctx.secrets.isAvailable()) throw new EpayError(503, '密钥存储未配置');
    const parsed = configInputSchema.safeParse(input);
    if (!parsed.success) throw new EpayError(400, '易支付配置参数无效', true);
    const config = validateConfig(parsed.data);
    await assertPublicGatewayUrl(config.baseUrl);
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(config));
    this.config = config;
    return this.status();
  }

  async callback(req: HttpRequest, reply: HttpReply): Promise<unknown> {
    const config = this.requireConfig();
    const query = scalarQuery(req.query);
    if (!verifyParameters(query, config.platformPublicKey))
      throw new EpayError(400, '回调签名无效', true);
    if (query['pid'] !== config.pid || query['trade_status'] !== 'TRADE_SUCCESS') {
      throw new EpayError(400, '支付回调参数无效', true);
    }
    const merchantOrderNo = query['out_trade_no'];
    const externalId = query['trade_no'];
    if (typeof merchantOrderNo !== 'string' || typeof externalId !== 'string') {
      throw new EpayError(400, '支付回调参数不完整', true);
    }
    await this.ctx.payments.settle({
      providerId: this.id,
      merchantOrderNo,
      externalId,
      amount: decimalToMinor(query['money']),
      currency: 'CNY',
    });
    return reply.send('success');
  }

  private parseConfig(config: unknown): EpayConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new EpayError(503, '易支付支付方式配置无效');
    return validateConfig(parsed.data);
  }

  private requireConfig(): EpayConfig {
    if (!this.config) throw new EpayError(503, '易支付尚未配置');
    return this.config;
  }
}

function scalarQuery(query: Record<string, unknown>): Record<string, unknown> {
  for (const value of Object.values(query)) {
    if (Array.isArray(value) || (typeof value !== 'string' && typeof value !== 'number')) {
      throw new EpayError(400, '回调参数无效', true);
    }
  }
  return query;
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof EpayError)
        throw new PluginError(error.code, error.status, error.message);
      throw error;
    }
  };
}

let service: EpayService | null = null;

export const epayPlugin = definePlugin({
  manifest: {
    id: 'epay',
    name: '易支付',
    version: '0.3.1',
    description: '易支付（EasyPay）网关：为余额充值与订单结算提供 RSA 签名支付。',
    provides: [EXTENSION_POINTS.paymentProvider],
    permissions: ['epay.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['epay.admin'] }],
    // Open-platform surface: every entry mirrors one internal route below and
    // dispatches to the *same* handler, so the alias never widens auth.
    capabilities: [
      {
        id: 'epay.admin.config.read',
        method: 'GET',
        route: '/epay/admin/config',
        path: '/api/v1/epay/admin/config',
        summary: 'Read the Epay configuration',
        scope: 'epay.admin',
      },
      {
        id: 'epay.admin.config.write',
        method: 'POST',
        route: '/epay/admin/config',
        path: '/api/v1/epay/admin/config',
        summary: 'Update the Epay configuration and credentials',
        scope: 'epay.admin',
        mutating: true,
        destructive: true,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/epay/admin/config',
      auth: 'admin',
      permission: 'epay.admin',
      handler: handle(
        async () => service?.status() ?? Promise.reject(new EpayError(503, '易支付插件未就绪')),
      ),
    },
    {
      method: 'POST',
      path: '/epay/admin/config',
      auth: 'admin',
      permission: 'epay.admin',
      handler: handle(
        async (req) =>
          service?.configure(req.body) ?? Promise.reject(new EpayError(503, '易支付插件未就绪')),
      ),
    },
    {
      method: 'GET',
      path: '/callbacks/epay',
      auth: 'public',
      handler: handle(
        async (req, reply) =>
          service?.callback(req, reply) ?? Promise.reject(new EpayError(503, '易支付插件未就绪')),
      ),
    },
  ],
  onActivate: async (ctx) => {
    service = new EpayService(ctx);
    await service.load();
    ctx.registerExtension<PaymentProvider>(EXTENSION_POINTS.paymentProvider, service);
    ctx.logger.info(
      `epay: activated (${service.getMethods().length > 0 ? 'configured' : 'not configured'})`,
    );
  },
  onDeactivate: (ctx) => {
    service = null;
    ctx.logger.info('epay: deactivated');
  },
});

export default epayPlugin;
export type { ManualPaymentInstructions };
