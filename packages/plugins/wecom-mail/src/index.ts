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
import { WecomError, WecomMailClient, type WecomMailConfig } from './wecom-client.js';
import { renderCodeEmail, renderNoticeEmail } from './template.js';
import { originFromHeaders, parseCredentials } from './credential-parser.js';

/**
 * 企业微信邮箱发件渠道（企业微信「应用发送邮件」API）。
 *
 * 文档：<https://developer.work.weixin.qq.com/document/path/97445>
 *
 * 和 SMTP 插件是同一种东西的两种接法：同样提供 `notification.channel` 与
 * `identity.challengeSender` 两个扩展点，内核侧（收件人授权、投递记录、幂等键、
 * 退避重试、失败重放）完全复用，本插件只负责"怎么把这一封信交给服务商"。
 *
 * 什么时候该选它而不是 SMTP：企业已经全员在用企业微信、且开通了企业邮箱，
 * 那么不需要再维护一个发信域名/SMTP 账号与发信 IP 的信誉——直接用自建应用的
 * 邮件权限发信，收件人还能按企业微信成员匹配（`userids`，本插件走邮箱地址）。
 *
 * 运维前提（配置错了都表现为"发送失败"，因此写进设置页文案与 README）：
 *   1. 企业微信管理后台创建**自建应用**，拿到 `corpid` 与 `corpsecret`；
 *   2. 该应用必须有**企业邮箱/邮件**权限；
 *   3. 若企业开启了可信 IP，必须把本服务出口 IP 加进去（否则 60020）。
 */

const CONFIG_KEY = 'wecom-mail-config';
const BRAND = 'StackPanel';

const configSchema = z.object({
  /** 企业 ID（我的企业 → 企业信息）。 */
  corpId: z.string().trim().min(1).max(64),
  /** 自建应用 Secret。更新时可留空，表示"沿用已保存的"。 */
  corpSecret: z.string().trim().max(1000).optional(),
  /**
   * 发件地址，仅用于后台展示与测试邮件说明。
   * `compose_send` 的 From 由企业微信按应用绑定邮箱决定，请求里没有这个字段。
   */
  from: z.string().trim().email().max(320).optional(),
  /** 接口地址，默认官方域名；可指向内网代理/镜像。 */
  baseUrl: z.string().trim().url().max(300).default('https://qyapi.weixin.qq.com'),
  /** 站点对外地址，用来把站内相对链接补成绝对链接。 */
  publicBaseUrl: z.string().trim().url().max(500).optional(),
  /** 哪些通知类型不发邮件（逗号分隔的 type 前缀）。 */
  excludeTypes: z.string().max(1000).default(''),
  /** 单次 HTTP 超时；应小于内核投递租约，避免重复投递。 */
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
});

type ConfigInput = z.input<typeof configSchema>;
type Config = z.infer<typeof configSchema>;
/** 落库形状：`corpSecret` 一定存在（更新时被合并回来）。 */
type StoredConfig = Config & { corpSecret: string };

class WecomMailPluginError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = 'wecom-mail.error',
  ) {
    super(message);
    this.name = 'WecomMailPluginError';
  }
}

/** 校验并归一化输入配置。`previous` 用于"Secret 留空＝沿用"。 */
function resolveConfig(input: ConfigInput, previous?: StoredConfig | null): StoredConfig {
  const parsed = configSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new WecomMailPluginError(400, '企业微信邮箱配置参数无效', 'wecom-mail.invalid_config');
  }
  const value = parsed.data;
  const corpSecret = value.corpSecret?.trim() || previous?.corpSecret || '';
  if (!corpSecret) {
    throw new WecomMailPluginError(
      400,
      '首次配置必须填写自建应用 Secret',
      'wecom-mail.invalid_config',
    );
  }
  return { ...value, corpSecret };
}

function toClientConfig(config: StoredConfig): WecomMailConfig {
  return {
    corpId: config.corpId,
    corpSecret: config.corpSecret,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  };
}

function excluded(config: StoredConfig, type: string): boolean {
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

class WecomMailService implements NotificationChannel, IdentityChallengeSender {
  readonly id = 'wecom-mail';
  readonly name = '企业微信邮箱';
  private resolved: { config: StoredConfig; client: WecomMailClient } | null = null;

  constructor(private readonly ctx: PluginContext) {}

  /** 从加密存储载入配置；失败时记日志并保持"未配置"，不影响其它通道。 */
  async load(): Promise<void> {
    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      const previous = JSON.parse(saved) as StoredConfig;
      const config = resolveConfig(previous, previous);
      this.resolved = { config, client: this.clientFor(config) };
    } catch (error) {
      this.ctx.logger.warn(`wecom-mail: stored configuration is invalid: ${String(error)}`);
      this.resolved = null;
    }
  }

  dispose(): void {
    this.resolved = null;
  }

  /**
   * 同点上的其它通知渠道（不含自己）。
   *
   * 内核把通知 fan-out 给**每个** `wants()` 通过的渠道，所以 `smtp` 与
   * `wecom-mail` 同时配置好时，用户会收到两封同一内容的邮件。这一个字段就是
   * 让设置页能把这件事说出来，而不是等用户投诉"重复发送"。
   *
   * `configured: null` 表示那个渠道没有暴露探测能力（我们不下结论）。
   */
  otherChannels(): Array<{ id: string; configured: boolean | null }> {
    const read = this.ctx.getExtensionsWithOwner?.bind(this.ctx);
    if (typeof read !== 'function') return [];
    try {
      return read<NotificationChannel>(EXTENSION_POINTS.notificationChannel)
        .filter(({ pluginId }) => pluginId !== this.id)
        .map(({ pluginId, implementation }) => {
          const probe = (implementation as { isConfigured?: () => boolean }).isConfigured;
          return {
            id: pluginId,
            configured:
              typeof probe === 'function' ? Boolean(probe.call(implementation)) : (null as null),
          };
        });
    } catch (error) {
      this.ctx.logger.warn(`wecom-mail: could not enumerate channels: ${String(error)}`);
      return [];
    }
  }

  /** 只回显非敏感字段：Secret 永不出现在响应里。 */
  status(): unknown {
    const config = this.resolved?.config;
    const token = this.resolved?.client.tokenState() ?? null;
    return {
      configured: Boolean(config),
      secretsEnabled: this.ctx.secrets.isAvailable(),
      ...(config
        ? {
            corpId: config.corpId,
            from: config.from ?? null,
            baseUrl: config.baseUrl,
            publicBaseUrl: config.publicBaseUrl ?? null,
            excludeTypes: config.excludeTypes,
            timeoutMs: config.timeoutMs,
            // 诊断用：token 是否已缓存（能区分"配置错"与"网络/白名单错"）。
            tokenCached: token !== null,
            tokenExpiresInSeconds: token?.expiresInSeconds ?? 0,
          }
        : {}),
      otherChannels: this.otherChannels(),
    };
  }

  /** 登录插件据此判断"验证码有渠道可投递"，未配置即不放开邮箱验证流程。 */
  isConfigured(): boolean {
    return this.resolved !== null;
  }

  async configure(input: unknown): Promise<unknown> {
    const config = resolveConfig((input ?? {}) as ConfigInput, this.resolved?.config ?? null);
    await this.persist(config);
    return this.status();
  }

  /**
   * **一次粘贴就接通**：解析凭据 → 真实换取 token（这一步同时验证了 corpid、
   * Secret、可信 IP 和邮箱权限里的前三项）→ 保存 → 给当前管理员发一封测试信。
   *
   * 做不到的只有一件：Secret 必须由管理员在后台点「查看 Secret」并扫码拿一次——
   * 企业微信没有"读取应用 Secret"的接口，任何声称零输入的方案要么是服务商代开发
   * 应用（`suite_id` + 永久授权码），要么就是把厂商凭据塞进了客户端。
   *
   * 失败**不静默**：换 token 失败会带着稳定错误码冒到界面（例如
   * `wecom.ip_not_allowed`），界面按码给出"去后台做哪一件事"。测试信失败则单独
   * 报告——凭据已经可用，不该因为邮件没到而被判成"配置失败"。
   */
  async connect(
    input: unknown,
    context: { origin: string | null; adminEmail: string | null },
  ): Promise<unknown> {
    const parsed = connectSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new WecomMailPluginError(400, '接入参数无效', 'wecom-mail.invalid_config');
    }
    const body = parsed.data;
    const found = parseCredentials(body.text);
    const corpId = body.corpId?.trim() || found.corpId;
    const corpSecret = body.corpSecret?.trim() || found.corpSecret;
    if (!corpId || !corpSecret) {
      // 用解析器的缺口码作答：界面据此只说"还差哪一样"，不用猜。
      const gap = !corpId ? 'wecom-mail.missing_corp_id' : 'wecom-mail.missing_secret';
      throw new WecomMailPluginError(400, '粘贴内容里没有找到完整的凭据', gap);
    }

    const previous = this.resolved?.config ?? null;
    const config = resolveConfig(
      {
        // 粘贴只带来凭据；其余设置沿用已保存的，避免"一键接入"顺手抹掉排除规则。
        ...(previous ?? {}),
        corpId,
        corpSecret,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...((body.publicBaseUrl ?? context.origin)
          ? { publicBaseUrl: body.publicBaseUrl ?? context.origin ?? undefined }
          : {}),
      } as ConfigInput,
      previous,
    );

    const client = this.clientFor(config);
    // 真校验：换得到 token 才算接通（顺带把 token 预热进缓存）。
    await client.accessToken();
    await this.persist(config, client);

    const testTo = body.to ?? context.adminEmail;
    let test: { sent: boolean; to: string | null; code?: string } = {
      sent: false,
      to: testTo ?? null,
    };
    if (body.testSend !== false && testTo) {
      try {
        await this.sendTest(client, config, testTo);
        test = { sent: true, to: testTo };
      } catch (error) {
        // 凭据已经验证过了：测试信失败只报告，不回滚配置。
        const code = error instanceof WecomError ? error.code : 'wecom.send_failed';
        // 稳定码给界面，原始 errcode 进日志：`48002` 这类码要去企业微信的
        // devtool 里查才知道是"应用没开通这个接口"，只有日志留得住它。
        this.ctx.logger.warn(
          `wecom-mail: test send failed code=${code} errcode=${
            error instanceof WecomError ? String(error.errcode ?? '') : ''
          }`,
        );
        test = { sent: false, to: testTo, code };
      }
    }

    this.ctx.logger.info(`wecom-mail: connected to ${corpId} (testSent=${String(test.sent)})`);
    return { connected: true, corpId, publicBaseUrl: config.publicBaseUrl ?? null, test };
  }

  /** 发一封测试邮件：验证 corpid/secret/IP 白名单/邮箱权限四件事是否都通。 */
  async testSend(to: string): Promise<unknown> {
    const { config, client } = this.require();
    const parsed = z.string().email().max(320).safeParse(to);
    if (!parsed.success) {
      throw new WecomMailPluginError(400, '测试收件地址无效', 'wecom-mail.invalid_email');
    }
    await this.sendTest(client, config, parsed.data);
    return { sent: true, to: parsed.data };
  }

  private async sendTest(client: WecomMailClient, config: StoredConfig, to: string): Promise<void> {
    const content = renderNoticeEmail({
      title: '企业微信邮箱测试',
      body: '如果你看到这封邮件，说明企业微信邮箱渠道已配置成功。',
      brand: BRAND,
      ...(config.publicBaseUrl ? { link: absoluteUrl(config.publicBaseUrl, '/admin') } : {}),
    });
    await client.send({
      to: [to],
      subject: content.subject,
      content: content.html,
      contentType: 'html',
    });
    this.ctx.logger.info(`wecom-mail: test email accepted for ${mask(to)}`);
  }

  /** 落盘 + 换上带（可能已预热的）token 的客户端。 */
  private async persist(config: StoredConfig, client?: WecomMailClient): Promise<void> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new WecomMailPluginError(
        503,
        '加密密钥存储未配置，无法保存企业微信凭据',
        'wecom-mail.no_secrets',
      );
    }
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(config));
    // 凭据变了，旧 token 属于旧企业：不换会拿着别人的凭据发信。
    this.resolved?.client.invalidateToken();
    this.resolved = { config, client: client ?? this.clientFor(config) };
  }

  /* ---------------------- NotificationChannel ---------------------- */

  wants(dispatch: NotificationDispatch): boolean {
    const config = this.resolved?.config;
    if (!config) return false;
    return !excluded(config, dispatch.type);
  }

  async deliver(dispatch: NotificationDispatch): Promise<void> {
    const { config, client } = this.require();
    const recipient = await this.recipientEmail(dispatch.userId);
    if (!recipient) {
      // 用户不存在/无邮箱：无从投递。抛错会让内核无限重试，故记一条 warn 后跳过。
      this.ctx.logger.warn(
        `wecom-mail: user ${dispatch.userId} has no email; skipping ${dispatch.type}`,
      );
      return;
    }
    const content = renderNoticeEmail({
      title: dispatch.title,
      body: dispatch.body ?? '',
      brand: BRAND,
      ...(absoluteUrl(config.publicBaseUrl, dispatch.link)
        ? { link: absoluteUrl(config.publicBaseUrl, dispatch.link) as string }
        : {}),
    });
    await client.send({
      to: [recipient],
      subject: content.subject,
      content: content.html,
      contentType: 'html',
    });
  }

  /* -------------------- IdentityChallengeSender -------------------- */

  async send(message: IdentityChallengeMessage): Promise<void> {
    const { client } = this.require();
    const expiresInMinutes = Math.max(
      1,
      Math.round((message.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const content = renderCodeEmail({
      code: message.code,
      expiresInMinutes,
      brand: BRAND,
      ...(message.locale ? { locale: message.locale } : {}),
    });
    await client.send({
      to: [message.email],
      subject: content.subject,
      content: content.html,
      contentType: 'html',
    });
  }

  /* ------------------------------ 内部 ------------------------------ */

  private clientFor(config: StoredConfig): WecomMailClient {
    return new WecomMailClient(toClientConfig(config), {
      warn: (line) => this.ctx.logger.warn(`wecom-mail: ${line}`),
    });
  }

  private require(): { config: StoredConfig; client: WecomMailClient } {
    if (!this.resolved) {
      throw new WecomMailPluginError(503, '企业微信邮箱尚未配置', 'wecom-mail.not_configured');
    }
    return this.resolved;
  }

  private async recipientEmail(userId: string): Promise<string | null> {
    try {
      const user = await this.ctx.auth.getUser(userId);
      return user?.email ?? null;
    } catch (error) {
      this.ctx.logger.warn(`wecom-mail: could not resolve email for ${userId}: ${String(error)}`);
      return null;
    }
  }
}

/** 在日志里遮蔽收件人，避免审计日志变成通讯录。 */
function mask(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, 2)}***${email.slice(at)}`;
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      // 契约：内核错误边界按稳定错误码渲染（ADR-0012）。品牌检查而非 instanceof，
      // 以适配插件加载器的 cache-busted SDK 副本。
      if (error instanceof WecomMailPluginError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      if (error instanceof WecomError) {
        // 502：这是上游（企业微信）的问题，内核按此决定是否重试。
        throw new PluginError(error.code, 502, error.message);
      }
      throw error;
    }
  };
}

let service: WecomMailService | null = null;

const testSendSchema = z.object({ to: z.string().email().max(320) });

/**
 * 一键接入的入参：`text` 是管理员粘贴的任意一段文字（解析器负责认），
 * `corpId`/`corpSecret` 留给程序化调用（脚本、MCP）直接给结构化凭据。
 */
const connectSchema = z.object({
  text: z.string().max(4000).optional(),
  corpId: z.string().trim().max(64).optional(),
  corpSecret: z.string().trim().max(1000).optional(),
  baseUrl: z.string().trim().url().max(300).optional(),
  publicBaseUrl: z.string().trim().url().max(500).optional(),
  to: z.string().email().max(320).optional(),
  testSend: z.boolean().optional(),
});

export const wecomMailPlugin = definePlugin({
  manifest: {
    id: 'wecom-mail',
    name: '企业微信邮箱',
    version: '0.2.0',
    description:
      '通过企业微信「应用发送邮件」接口投递站内通知与注册验证码，无需自建 SMTP 与发信域名。',
    provides: [EXTENSION_POINTS.notificationChannel, EXTENSION_POINTS.identityChallengeSender],
    permissions: ['wecom-mail.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['wecom-mail.admin'] }],
    // 开放平台面：每条镜像一个内部路由，分发到同一个 handler，不会放宽鉴权。
    capabilities: [
      {
        id: 'wecom-mail.admin.config.read',
        method: 'GET',
        route: '/wecom-mail/admin/config',
        path: '/api/v1/wecom-mail/admin/config',
        summary: 'Read the WeCom mail configuration',
        scope: 'wecom-mail.admin',
        mutating: false,
        destructive: false,
      },
      {
        id: 'wecom-mail.admin.config.write',
        method: 'POST',
        route: '/wecom-mail/admin/config',
        path: '/api/v1/wecom-mail/admin/config',
        summary: 'Save the WeCom mail configuration',
        scope: 'wecom-mail.admin',
        mutating: true,
        destructive: true,
      },
      {
        id: 'wecom-mail.admin.connect',
        method: 'POST',
        route: '/wecom-mail/admin/connect',
        path: '/api/v1/wecom-mail/admin/connect',
        summary: 'Connect a WeCom self-built app from pasted credentials and self-test it',
        scope: 'wecom-mail.admin',
        mutating: true,
        destructive: true,
      },
      {
        id: 'wecom-mail.admin.test',
        method: 'POST',
        route: '/wecom-mail/admin/test',
        path: '/api/v1/wecom-mail/admin/test',
        summary: 'Send a test email through the configured WeCom app',
        scope: 'wecom-mail.admin',
        mutating: true,
        destructive: true,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/wecom-mail/admin/config',
      auth: 'admin',
      permission: 'wecom-mail.admin',
      // 顺带回传当前管理员的邮箱：一键接入默认把测试信发给他自己，
      // 这样"接通"和"收到信"是同一次点击里完成的。
      handler: handle(async (req) => ({
        ...((service?.status() as Record<string, unknown>) ?? { configured: false }),
        adminEmail: req.user?.email ?? null,
      })),
    },
    {
      // 一粘贴就接通：解析 → 换 token 真校验 → 保存 → 自测发信。
      method: 'POST',
      path: '/wecom-mail/admin/connect',
      auth: 'admin',
      permission: 'wecom-mail.admin',
      handler: handle(async (req) => {
        if (!service) {
          throw new WecomMailPluginError(503, '插件未就绪', 'wecom-mail.not_ready');
        }
        return service.connect(req.body, {
          origin: originFromHeaders(req.headers),
          adminEmail: req.user?.email ?? null,
        });
      }),
    },
    {
      method: 'POST',
      path: '/wecom-mail/admin/config',
      auth: 'admin',
      permission: 'wecom-mail.admin',
      handler: handle(async (req) => {
        if (!service) {
          throw new WecomMailPluginError(503, '插件未就绪', 'wecom-mail.not_ready');
        }
        return service.configure(req.body);
      }),
    },
    {
      method: 'POST',
      path: '/wecom-mail/admin/test',
      auth: 'admin',
      permission: 'wecom-mail.admin',
      handler: handle(async (req) => {
        if (!service) {
          throw new WecomMailPluginError(503, '插件未就绪', 'wecom-mail.not_ready');
        }
        const parsed = testSendSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new WecomMailPluginError(400, '收件地址无效', 'wecom-mail.invalid_email');
        }
        return service.testSend(parsed.data.to);
      }),
    },
  ],
  onActivate: async (ctx) => {
    const instance = new WecomMailService(ctx);
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
    ctx.logger.info(`wecom-mail: activated (configured=${String(instance.isConfigured())})`);
  },
  onDeactivate: (ctx) => {
    service?.dispose();
    service = null;
    ctx.logger.info('wecom-mail: deactivated');
  },
});

export default wecomMailPlugin;
