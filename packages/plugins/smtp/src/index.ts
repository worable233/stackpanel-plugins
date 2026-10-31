import { EXTENSION_POINTS, PluginError, definePlugin } from '@stackpanel/sdk';
import type {
  HttpReply,
  HttpRequest,
  IdentityChallengeMessage,
  IdentityChallengeSender,
  NotificationChannel,
  NotificationDispatch,
  PluginContext,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { SmtpError, SmtpTransport, type SmtpConfig } from './smtp-client.js';
import { buildMessage, renderCodeEmail, renderNoticeEmail } from './message.js';

/**
 * SMTP 通知渠道插件（审计 §5）。
 *
 * 一个插件同时提供两个内核扩展点，复用同一份 SMTP 配置与连接池：
 *   - `notification.channel` → 把站内通知投影成邮件（业务提醒）；
 *   - `identity.challengeSender` → 投递注册邮箱验证码（身份挑战，**绝不**经站内通知）。
 *
 * 内核负责：收件人授权、投递记录、幂等键、退避重试与失败重放（见
 * `apps/api/src/notifications/dispatcher.ts`）。本插件只负责「怎么把邮件发出去」；
 * `deliver`/`send` 抛错即请求内核重试。
 *
 * 凭据加密存储于 `ctx.secrets`；站点地址等非敏感项同时存于同一份配置。
 */

const CONFIG_KEY = 'smtp-config';

const configSchema = z.object({
  host: z.string().trim().min(1).max(191),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
  requireStartTls: z.boolean().default(false),
  allowInsecure: z.boolean().default(false),
  rejectUnauthorized: z.boolean().default(true),
  user: z.string().trim().max(320).optional(),
  password: z.string().max(2000).optional(),
  authMethod: z.enum(['plain', 'login']).optional(),
  from: z.string().trim().email().max(320),
  fromName: z.string().trim().max(120).optional(),
  /** 站点对外地址，用于把相对链接补成绝对链接。 */
  publicBaseUrl: z.string().trim().url().max(500).optional(),
  /** 哪个通知类型不发邮件（逗号分隔的 type 前缀）。 */
  excludeTypes: z.string().max(1000).default(''),
  connectionTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  commandTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  /** 整体发送时限；应小于内核投递租约 60s，避免重复投递。 */
  sendTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  maxConnections: z.number().int().min(1).max(20).optional(),
  /** 池满时的非阻塞排队上限（背压）；超出即快速失败交给内核重试。 */
  maxQueue: z.number().int().min(0).max(10000).optional(),
  ratePerMinute: z.number().int().min(0).max(100000).optional(),
});

type SmtpConfigInput = z.input<typeof configSchema>;

/** 持久配置 + 派生出的传输实例。 */
interface ResolvedConfig {
  secret: z.infer<typeof configSchema>;
  transport: SmtpTransport;
}

class SmtpPluginError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    code = 'smtp.error',
  ) {
    super(message);
    this.code = code;
  }
}

/** 校验并归一化输入配置（对外只回显非敏感字段）。 */
function resolveConfig(input: SmtpConfigInput): z.infer<typeof configSchema> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new SmtpPluginError(400, 'SMTP 配置参数无效', 'smtp.invalid_config');
  const value = parsed.data;
  if (value.secure && value.requireStartTls) {
    throw new SmtpPluginError(400, '隐式 TLS 与 STARTTLS 不能同时启用', 'smtp.invalid_config');
  }
  if (!value.secure && !value.requireStartTls && !value.allowInsecure) {
    throw new SmtpPluginError(
      400,
      '必须启用隐式 TLS 或 STARTTLS；如确需明文请显式允许',
      'smtp.invalid_config',
    );
  }
  if (value.user && !value.password) {
    throw new SmtpPluginError(400, '配置了用户名时必须提供密码', 'smtp.invalid_config');
  }
  return value;
}

function toTransportConfig(config: z.infer<typeof configSchema>): SmtpConfig {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireStartTls: config.requireStartTls,
    allowInsecure: config.allowInsecure,
    rejectUnauthorized: config.rejectUnauthorized,
    from: config.from,
    ...(config.fromName ? { fromName: config.fromName } : {}),
    ...(config.connectionTimeoutMs ? { connectionTimeoutMs: config.connectionTimeoutMs } : {}),
    ...(config.commandTimeoutMs ? { commandTimeoutMs: config.commandTimeoutMs } : {}),
    ...(config.sendTimeoutMs ? { sendTimeoutMs: config.sendTimeoutMs } : {}),
    ...(config.maxConnections ? { maxConnections: config.maxConnections } : {}),
    ...(config.maxQueue ? { maxQueue: config.maxQueue } : {}),
    ...(config.ratePerMinute ? { ratePerMinute: config.ratePerMinute } : {}),
    ...(config.user && config.password
      ? {
          auth: {
            user: config.user,
            pass: config.password,
            ...(config.authMethod ? { method: config.authMethod } : {}),
          },
        }
      : {}),
  };
}

function excluded(config: z.infer<typeof configSchema>, type: string): boolean {
  const prefixes = config.excludeTypes
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return prefixes.some((prefix) => type.startsWith(prefix));
}

function absoluteUrl(base: string | undefined, link: string | null): string | undefined {
  if (!link) return undefined;
  if (/^https?:\/\//i.test(link)) return link;
  if (!base) return link;
  return `${base.replace(/\/$/, '')}${link.startsWith('/') ? '' : '/'}${link}`;
}

class SmtpService implements NotificationChannel, IdentityChallengeSender {
  readonly id = 'smtp';
  readonly name = 'SMTP 邮件';
  private resolved: ResolvedConfig | null = null;

  constructor(private readonly ctx: PluginContext) {}

  /** 从加密存储载入配置并建立传输。失败时记录并保持未配置。 */
  async load(): Promise<void> {
    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      const parsed = resolveConfig(JSON.parse(saved) as SmtpConfigInput);
      this.resolved = {
        secret: parsed,
        transport: new SmtpTransport(toTransportConfig(parsed), {
          warn: (message) => this.ctx.logger.warn(`smtp: ${message}`),
        }),
      };
    } catch (error) {
      this.ctx.logger.warn(`smtp: stored configuration is invalid: ${String(error)}`);
      this.resolved = null;
    }
  }

  /** 停止时释放连接池。 */
  dispose(): void {
    this.resolved?.transport.close();
    this.resolved = null;
  }

  /** 只回显非敏感字段，绝不回显密码。 */
  async status(): Promise<unknown> {
    const config = this.resolved?.secret;
    return {
      configured: Boolean(config),
      // 隔离执行下 ctx 调用被代理成一次往返，返回 Promise：不 await 会序列化成 `{}`。
      secretsEnabled: await this.ctx.secrets.isAvailable(),
      ...(config
        ? {
            host: config.host,
            port: config.port,
            secure: config.secure,
            requireStartTls: config.requireStartTls,
            from: config.from,
            fromName: config.fromName ?? null,
            user: config.user ?? null,
            excludeTypes: config.excludeTypes,
          }
        : {}),
    };
  }

  /** The login plugin uses this capability check before enabling verification. */
  isConfigured(): boolean {
    return this.resolved !== null;
  }

  async configure(input: unknown): Promise<unknown> {
    // `await` 是必须的：Promise 恒为真，漏掉它等于把"密钥存储不可用"当成可用。
    if (!(await this.ctx.secrets.isAvailable())) {
      throw new SmtpPluginError(503, '加密密钥存储未配置，无法保存 SMTP 凭据', 'smtp.no_secrets');
    }
    const parsed = resolveConfig((input ?? {}) as SmtpConfigInput);
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(parsed));
    this.dispose();
    this.resolved = {
      secret: parsed,
      transport: new SmtpTransport(toTransportConfig(parsed), {
        warn: (message) => this.ctx.logger.warn(`smtp: ${message}`),
      }),
    };
    return this.status();
  }

  /** 发送一封测试邮件，验证连通性与认证。 */
  async testSend(to: string): Promise<unknown> {
    const resolved = this.requireConfig();
    const email = z.string().email().safeParse(to);
    if (!email.success) throw new SmtpPluginError(400, '测试收件地址无效', 'smtp.invalid_email');
    const content = renderNoticeEmail({
      title: 'SMTP 测试邮件',
      body: '如果你看到这封邮件，说明 SMTP 通知渠道已配置成功。',
      brand: 'StackPanel',
    });
    await this.transport().send({
      to: email.data,
      raw: buildMessage({
        to: email.data,
        from: resolved.secret.from,
        ...(resolved.secret.fromName ? { fromName: resolved.secret.fromName } : {}),
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    return { sent: true, to: email.data };
  }

  /* ---------------------- NotificationChannel ---------------------- */

  wants(dispatch: NotificationDispatch): boolean {
    const config = this.resolved?.secret;
    if (!config) return false;
    // 未配置就不参与；排除类型不发邮件（例如高频的活动进度）。
    return !excluded(config, dispatch.type);
  }

  async deliver(dispatch: NotificationDispatch): Promise<void> {
    const resolved = this.requireConfig();
    const recipient = await this.recipientEmail(dispatch.userId);
    if (!recipient) {
      // 用户不存在/无邮箱：无从投递。抛错会让内核不断重试，故直接跳过。
      this.ctx.logger.warn(`smtp: user ${dispatch.userId} has no email; skipping ${dispatch.type}`);
      return;
    }
    const content = renderNoticeEmail({
      title: dispatch.title,
      body: dispatch.body ?? '',
      ...(absoluteUrl(resolved.secret.publicBaseUrl, dispatch.link)
        ? {
            link: absoluteUrl(resolved.secret.publicBaseUrl, dispatch.link) as string,
          }
        : {}),
    });
    await this.transport().send({
      to: recipient,
      raw: buildMessage({
        to: recipient,
        from: resolved.secret.from,
        ...(resolved.secret.fromName ? { fromName: resolved.secret.fromName } : {}),
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
  }

  /* -------------------- IdentityChallengeSender -------------------- */

  async send(message: IdentityChallengeMessage): Promise<void> {
    const resolved = this.requireConfig();
    const expiresInMinutes = Math.max(
      1,
      Math.round((message.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const content = renderCodeEmail({
      code: message.code,
      expiresInMinutes,
      brand: 'StackPanel',
      ...(message.locale ? { locale: message.locale } : {}),
    });
    await this.transport().send({
      to: message.email,
      raw: buildMessage({
        to: message.email,
        from: resolved.secret.from,
        ...(resolved.secret.fromName ? { fromName: resolved.secret.fromName } : {}),
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
  }

  /* ------------------------------ 内部 ------------------------------ */

  private requireConfig(): ResolvedConfig {
    if (!this.resolved) throw new SmtpPluginError(503, 'SMTP 尚未配置', 'smtp.not_configured');
    return this.resolved;
  }

  private transport(): SmtpTransport {
    return this.requireConfig().transport;
  }

  private async recipientEmail(userId: string): Promise<string | null> {
    try {
      const user = await this.ctx.auth.getUser(userId);
      return user?.email ?? null;
    } catch (error) {
      this.ctx.logger.warn(`smtp: could not resolve email for ${userId}: ${String(error)}`);
      return null;
    }
  }
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof SmtpPluginError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      if (error instanceof SmtpError) {
        throw new PluginError('smtp.send_failed', 502, error.message);
      }
      throw error;
    }
  };
}

let service: SmtpService | null = null;

const testSendSchema = z.object({ to: z.string().email().max(320) });

export const smtpPlugin = definePlugin({
  manifest: {
    id: 'smtp',
    name: 'SMTP 邮件通知',
    version: '0.1.0',
    description: '通过 SMTP 投递站内通知与注册验证码（TLS、认证、超时、连接复用、限速）。',
    provides: [EXTENSION_POINTS.notificationChannel, EXTENSION_POINTS.identityChallengeSender],
    permissions: ['smtp.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['smtp.admin'] }],
    // Open-platform surface: every entry mirrors one internal route below and
    // dispatches to the *same* handler, so the alias never widens auth.
    capabilities: [
      {
        id: 'smtp.admin.config.read',
        method: 'GET',
        route: '/smtp/admin/config',
        path: '/api/v1/smtp/admin/config',
        summary: 'Read the SMTP configuration',
        scope: 'smtp.admin',
      },
      {
        id: 'smtp.admin.config.write',
        method: 'POST',
        route: '/smtp/admin/config',
        path: '/api/v1/smtp/admin/config',
        summary: 'Update the SMTP configuration',
        scope: 'smtp.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'smtp.admin.test',
        method: 'POST',
        route: '/smtp/admin/test',
        path: '/api/v1/smtp/admin/test',
        summary: 'Send a test email through the configured SMTP relay',
        scope: 'smtp.admin',
        mutating: true,
        destructive: true,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/smtp/admin/config',
      auth: 'admin',
      permission: 'smtp.admin',
      handler: handle(async () => service?.status() ?? { configured: false }),
    },
    {
      method: 'POST',
      path: '/smtp/admin/config',
      auth: 'admin',
      permission: 'smtp.admin',
      handler: handle(async (req) => {
        if (!service) throw new SmtpPluginError(503, 'SMTP 插件未就绪', 'smtp.not_ready');
        return service.configure(req.body);
      }),
    },
    {
      method: 'POST',
      path: '/smtp/admin/test',
      auth: 'admin',
      permission: 'smtp.admin',
      handler: handle(async (req) => {
        if (!service) throw new SmtpPluginError(503, 'SMTP 插件未就绪', 'smtp.not_ready');
        const parsed = testSendSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new SmtpPluginError(400, '收件地址无效', 'smtp.invalid_email');
        }
        return service.testSend(parsed.data.to);
      }),
    },
  ],
  onActivate: async (ctx) => {
    const instance = new SmtpService(ctx);
    await instance.load();
    service = instance;
    ctx.effect(() => () => {
      instance.dispose();
      if (service === instance) service = null;
    });
    ctx.registerExtension<NotificationChannel>(EXTENSION_POINTS.notificationChannel, instance);
    ctx.registerExtension<IdentityChallengeSender>(
      EXTENSION_POINTS.identityChallengeSender,
      instance,
    );
    const status = (await instance.status()) as { configured: boolean };
    ctx.logger.info(`smtp: activated (${status.configured ? 'configured' : 'not configured'})`);
  },
  onDeactivate: (ctx) => {
    service?.dispose();
    service = null;
    ctx.logger.info('smtp: deactivated');
  },
});

export default smtpPlugin;
