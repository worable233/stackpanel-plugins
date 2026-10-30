import { EXTENSION_POINTS, PluginError, definePlugin } from '@stackpanel/sdk';
import type {
  CaptchaPolicy,
  CaptchaProvider,
  CaptchaVerification,
  CaptchaVerifyResult,
  HttpReply,
  HttpRequest,
  PluginContext,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { PRESETS, isValidVerifyUrl, presetById, type Preset } from './presets.js';
import { verifyChallenge } from './verify.js';

/**
 * 人机验证 provider 插件。
 *
 * 契约完全由内核定义（`captcha.provider` 扩展点 + `ctx.captcha`），本插件只
 * 做两件事：
 *
 *  1. `verify()` —— 把 token 送到厂商的 `siteverify`，返回布尔结果；
 *  2. `policyFor(action)` —— 声明「哪个受保护操作要多严」。
 *
 * 内核因此不认识任何厂商：换 Turnstile → Cap → 私有化校验地址，改的是本插件
 * 的配置，内核与前端一行不动。反过来，**卸载本插件后全站行为与安装前完全一致**
 * —— 没有 provider 时 `ctx.captcha.mode()` 回落 `AUTH_CAPTCHA_MODE`（默认 `off`），
 * 前端拿不到 `clientConfig` 就不渲染任何控件。
 *
 * 密钥只存在 `ctx.secrets`（AES-256-GCM），`clientConfig()` 只返回公开字段
 * （site key、脚本地址、需要的 CSP 源）。
 */

const CONFIG_KEY = 'captcha-config';

/** 受保护操作的稳定标识（与内核 `CaptchaAction` 对应）。 */
export const CAPTCHA_ACTIONS = [
  'login',
  'register',
  'register_send_code',
  'password_reset',
  'change_password',
  'change_email',
  'api_token_create',
] as const;

export type CaptchaActionId = (typeof CAPTCHA_ACTIONS)[number];

const policyMode = z.enum(['off', 'optional', 'required']);

const configSchema = z.object({
  preset: z.string().trim().min(1).max(40),
  siteKey: z.string().trim().min(1).max(400),
  /** 只在服务端使用；`status()` 永远不返回它。 */
  secret: z.string().trim().min(1).max(2000),
  verifyUrl: z.string().trim().max(500).optional(),
  /** 自定义元素协议需要的额外属性（例如自托管 Cap 的 endpoint）。 */
  widgetAttributes: z.record(z.string(), z.string().max(500)).optional(),
  /** `generic` 预设的字段映射覆盖。 */
  fieldMap: z.record(z.string(), z.string().max(120)).optional(),
  extraFields: z.record(z.string(), z.string().max(500)).optional(),
  actionField: z.string().trim().max(120).optional(),
  /** per-action 策略；未列出的 action 由内核回落到全局 `AUTH_CAPTCHA_MODE`。 */
  actions: z.record(z.string(), policyMode).default({}),
  theme: z.enum(['auto', 'light', 'dark']).optional(),
});

type CaptchaConfig = z.infer<typeof configSchema>;

class CaptchaPluginError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    message: string,
    code = 'captcha.error',
  ) {
    super(message);
    this.code = code;
  }
}

/** 校验并归一化配置；对外只回显非敏感字段。 */
export function resolveConfig(input: unknown): CaptchaConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new CaptchaPluginError(400, '人机验证配置参数无效', 'captcha.invalid_config');
  }
  const value = parsed.data;
  if (!presetById(value.preset)) {
    throw new CaptchaPluginError(400, '未知的验证服务预设', 'captcha.invalid_config');
  }
  // 空字符串视为「用预设默认值」。
  if (value.verifyUrl === '') value.verifyUrl = undefined;
  if (value.verifyUrl && !isValidVerifyUrl(value.verifyUrl)) {
    throw new CaptchaPluginError(
      400,
      '校验地址必须是公网 https 地址',
      'captcha.invalid_config',
    );
  }
  const unknownActions = Object.keys(value.actions).filter(
    (action) => !CAPTCHA_ACTIONS.includes(action as CaptchaActionId),
  );
  if (unknownActions.length > 0) {
    throw new CaptchaPluginError(
      400,
      `未知的受保护操作：${unknownActions.join('、')}`,
      'captcha.invalid_config',
    );
  }
  return value;
}

/**
 * 把配置汇编成「前端协议对象」。
 *
 * 这是本插件唯一的「厂商知识出口」：宿主只认 `kind: 'script'` 与
 * `kind: 'element'` 两种形状，所以新增厂商不需要改内核或前端。
 */
export function buildClientConfig(config: CaptchaConfig): Record<string, unknown> {
  const preset = presetById(config.preset);
  if (!preset) return {};
  const widget = preset.widget;
  const attributes = { ...(widget.attributes ?? {}), ...(config.widgetAttributes ?? {}) };
  const sources = widget.sources;

  if (widget.tag && widget.tokenAttribute && widget.event) {
    return {
      kind: 'element',
      tag: widget.tag,
      attributes,
      tokenAttribute: widget.tokenAttribute,
      event: widget.event,
      ...(widget.resetEvent ? { resetEvent: widget.resetEvent } : {}),
      ...(sources ? { sources } : {}),
    };
  }

  return {
    kind: 'script',
    script: widget.script ?? '',
    globalFn: widget.globalFn ?? '',
    siteKey: config.siteKey,
    ...(config.theme ? { theme: config.theme } : {}),
    ...(widget.renderOptions ? { renderOptions: widget.renderOptions } : {}),
    ...(sources ? { sources } : {}),
  };
}

class CaptchaService implements CaptchaProvider {
  readonly id = 'captcha';
  readonly name = '人机验证';
  private config: CaptchaConfig | null = null;

  constructor(private readonly ctx: PluginContext) {}

  /** 从加密存储载入配置。损坏的配置按「未配置」处理，绝不让激活失败。 */
  async load(): Promise<void> {
    const saved = await this.ctx.secrets.get(CONFIG_KEY);
    if (!saved) return;
    try {
      this.config = resolveConfig(JSON.parse(saved) as unknown);
    } catch (error) {
      this.ctx.logger.warn(`captcha: stored configuration is invalid: ${String(error)}`);
      this.config = null;
    }
  }

  /** Provider 声明自己的策略；没有配置就不表态，由内核回落全局 mode。 */
  policyFor(action: string): CaptchaPolicy | null {
    const mode = this.config?.actions[action];
    return mode ? { mode } : null;
  }

  /** 公开的 widget 配置（无密钥）。未配置时返回 null，前端据此不渲染控件。 */
  clientConfig(): Record<string, unknown> | null {
    if (!this.config) return null;
    return buildClientConfig(this.config);
  }

  async verify(input: CaptchaVerification): Promise<CaptchaVerifyResult> {
    const config = this.config;
    if (!config) return { success: false, reason: 'no_provider' };
    const preset = presetById(config.preset);
    if (!preset) return { success: false, reason: 'unknown_preset' };

    const settings = {
      preset,
      verifyUrl: config.verifyUrl ?? preset.verifyUrl,
      secret: config.secret,
      fieldMap: config.fieldMap,
      extraFields: config.extraFields,
      actionField: config.actionField,
    };
    const outcome = await verifyChallenge(settings, input);
    if (!outcome.success) {
      // Error codes are vendor tokens, not prose: keep them structured in the log
      // and give the caller a stable reason.
      this.ctx.logger.warn(
        `captcha: verification failed (preset=${preset.id}, reason=${outcome.reason ?? 'unknown'})`,
      );
      return { success: false, reason: outcome.reason ?? 'rejected', providerId: this.id };
    }
    return { success: true, providerId: this.id };
  }

  /* ------------------------------ 后台 ------------------------------ */

  /** 只回显非敏感字段：secret 永远不出现在响应里。 */
  status(): unknown {
    const config = this.config;
    return {
      configured: config !== null,
      secretsEnabled: this.ctx.secrets.isAvailable(),
      presets: PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        verifyUrl: preset.verifyUrl,
        supportsAction: preset.supportsAction,
        ...(preset.hint ? { hint: preset.hint } : {}),
      })),
      actions: CAPTCHA_ACTIONS,
      ...(config
        ? {
            preset: config.preset,
            siteKey: config.siteKey,
            verifyUrl: config.verifyUrl ?? null,
            widgetAttributes: config.widgetAttributes ?? {},
            fieldMap: config.fieldMap ?? {},
            actionField: config.actionField ?? null,
            theme: config.theme ?? null,
            policies: config.actions,
            secretConfigured: true,
          }
        : {}),
    };
  }

  async configure(input: unknown): Promise<unknown> {
    if (!this.ctx.secrets.isAvailable()) {
      throw new CaptchaPluginError(
        503,
        '平台未配置加密密钥，无法保存验证服务密钥',
        'captcha.no_secrets',
      );
    }
    // 允许前端不重复提交 secret（沿用已保存的），避免每次改策略都要重填。
    const previous = this.config;
    const raw = { ...(input as Record<string, unknown>) };
    if ((raw['secret'] === undefined || raw['secret'] === '') && previous) {
      raw['secret'] = previous.secret;
    }
    const next = resolveConfig(raw);
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(next));
    this.config = next;
    return this.status();
  }

  /** 用给定 token 试校验一次，供后台确认配置可用。 */
  async test(token: string, remoteIp?: string): Promise<unknown> {
    const config = this.config;
    if (!config) {
      throw new CaptchaPluginError(503, '尚未配置人机验证', 'captcha.not_configured');
    }
    const preset: Preset | undefined = presetById(config.preset);
    if (!preset) {
      throw new CaptchaPluginError(503, '配置的预设不可用', 'captcha.unknown_preset');
    }
    const outcome = await verifyChallenge(
      {
        preset,
        verifyUrl: config.verifyUrl ?? preset.verifyUrl,
        secret: config.secret,
        fieldMap: config.fieldMap,
        extraFields: config.extraFields,
        actionField: config.actionField,
      },
      { token, ...(remoteIp ? { remoteIp } : {}) },
    );
    // The raw vendor payload is useful here and contains no secret.
    return { ok: outcome.success, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
}

let service: CaptchaService | null = null;

const testSchema = z.object({ token: z.string().trim().min(1).max(4096) });

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof CaptchaPluginError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export const captchaPlugin = definePlugin({
  manifest: {
    id: 'captcha',
    name: '人机验证',
    version: '0.1.0',
    description:
      '在登录、注册、改密码、改邮箱等敏感操作前加人机验证。支持 Turnstile / hCaptcha / reCAPTCHA / Cap 与任意 siteverify 兼容接口。',
    // 内核的单一扩展点。策略不落在内核，也不落在别的插件。
    provides: [EXTENSION_POINTS.captchaProvider],
    permissions: ['captcha.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['captcha.admin'] }],
    capabilities: [
      {
        id: 'captcha.admin.config.read',
        method: 'GET',
        route: '/captcha/admin/config',
        path: '/api/v1/captcha/admin/config',
        summary: 'Read the human-verification configuration',
        scope: 'captcha.admin',
      },
      {
        id: 'captcha.admin.config.write',
        method: 'POST',
        route: '/captcha/admin/config',
        path: '/api/v1/captcha/admin/config',
        summary: 'Update the human-verification configuration and per-action policy',
        scope: 'captcha.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'captcha.admin.test',
        method: 'POST',
        route: '/captcha/admin/test',
        path: '/api/v1/captcha/admin/test',
        summary: 'Verify one challenge token against the configured provider',
        scope: 'captcha.admin',
        mutating: true,
        // It spends a one-time token against an external service; treat it as
        // destructive so an agent cannot burn tokens incidentally.
        destructive: true,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/captcha/admin/config',
      auth: 'admin',
      permission: 'captcha.admin',
      handler: handle(async () => service?.status() ?? { configured: false }),
    },
    {
      method: 'POST',
      path: '/captcha/admin/config',
      auth: 'admin',
      permission: 'captcha.admin',
      handler: handle(async (req) => {
        if (!service) throw new CaptchaPluginError(503, '插件未就绪', 'captcha.not_ready');
        return service.configure(req.body);
      }),
    },
    {
      method: 'POST',
      path: '/captcha/admin/test',
      auth: 'admin',
      permission: 'captcha.admin',
      handler: handle(async (req) => {
        if (!service) throw new CaptchaPluginError(503, '插件未就绪', 'captcha.not_ready');
        const parsed = testSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new CaptchaPluginError(400, 'token 无效', 'captcha.invalid_token');
        }
        return service.test(parsed.data.token, req.ip ?? undefined);
      }),
    },
  ],
  onActivate: async (ctx) => {
    const instance = new CaptchaService(ctx);
    await instance.load();
    service = instance;
    ctx.effect(() => () => {
      if (service === instance) service = null;
    });
    ctx.registerExtension<CaptchaProvider>(EXTENSION_POINTS.captchaProvider, instance);
    ctx.logger.info(
      `captcha: activated (${instance.clientConfig() ? 'configured' : 'not configured'})`,
    );
  },
  onDeactivate: (ctx) => {
    service = null;
    ctx.logger.info('captcha: deactivated');
  },
});

export default captchaPlugin;
