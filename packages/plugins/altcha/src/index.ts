import { createHash, randomBytes } from 'node:crypto';
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
import {
  DEFAULT_EXPIRES_MS,
  DEFAULT_MAX_NUMBER,
  createChallenge,
  verifySolution,
} from './challenge.js';
import { WIDGET_SCRIPT } from './widget-asset.js';

/**
 * 自托管人机验证 provider。
 *
 * 与 `captcha` 插件的区别只有一处，但很关键：`captcha` 把校验交给厂商的
 * `siteverify`，本插件**两侧都在本地**——
 *
 *  - 签发：`GET /altcha/challenge` 用本地 HMAC 密钥签名一道 ALTCHA 工作量证明；
 *  - 校验：`verify()` 重新算一遍哈希 + HMAC，不依赖任何外部服务。
 *
 * 因此装完即可用：没有站点密钥要申请、没有第三方域名要放行、没有网络依赖，
 * 也不存在「厂商挂了登录就进不去」。内核仍然零厂商知识 —— 它见到的只是又一个
 * `captcha.provider` 扩展实现，卸载后行为与安装前一致。
 *
 * 控件脚本由本插件自己的路由吐出（`GET /altcha/widget.js`），浏览器经内核既有的
 * 同源 BFF 取到 `/api/plugins/altcha/widget.js`，于是**同源、无 CORS、无需放宽
 * CSP** —— 这是把所有资源放在宿主侧换来的好处。
 */

const CONFIG_KEY = 'altcha-config';
const KEY_SECRET = 'altcha-hmac-key';
/** 控件把解写进这个隐藏字段（与 widget 的 `name` 属性一致）。 */
const HIDDEN_FIELD = 'altcha';
/** 内核既有约定：`/api/plugins/<path>` → `<API>/<path>`。 */
const BFF_PREFIX = '/api/plugins/altcha';

/** 受保护操作的稳定标识（与内核 `CaptchaAction` 对应）。 */
export const ALTCHA_ACTIONS = [
  'login',
  'register',
  'register_send_code',
  'password_reset',
  'change_password',
  'change_email',
  'api_token_create',
] as const;

type AltchaAction = (typeof ALTCHA_ACTIONS)[number];
type Mode = CaptchaPolicy['mode'];

const modeSchema = z.enum(['off', 'optional', 'required']);

const configSchema = z.object({
  /** 每个操作要多严；缺省项按 `DEFAULT_ACTIONS` 补齐。 */
  actions: z.record(z.string().trim().max(64), modeSchema).optional(),
  /** 工作量上限：越大越难，也越慢。默认 10 万次哈希（手机 < 1s）。 */
  maxNumber: z.number().int().min(1_000).max(5_000_000).optional(),
  /** 挑战有效期（分钟）。0 = 不过期（仅调试）。 */
  expiresMinutes: z.number().int().min(0).max(120).optional(),
  /** 控件语言（`zh-cn` / `en` …），缺省跟随浏览器。 */
  language: z.string().trim().max(20).optional(),
  theme: z.enum(['light', 'dark', 'auto']).optional(),
  /**
   * 一次性：校验成功后把挑战记为已消费，同一 token 不能再用第二次。
   * 关闭后 token 在过期前可重放（不推荐，仅供排障）。
   */
  singleUse: z.boolean().optional(),
});

export type AltchaConfig = z.infer<typeof configSchema>;

/** 兜底策略：受保护操作默认都要验证 —— 「装上就生效」的前提。 */
const DEFAULT_ACTIONS: Record<AltchaAction, Mode> = {
  login: 'required',
  register: 'required',
  register_send_code: 'required',
  password_reset: 'required',
  change_password: 'required',
  change_email: 'required',
  api_token_create: 'required',
};

interface ResolvedConfig {
  actions: Record<string, Mode>;
  maxNumber: number;
  expiresMs: number;
  language: string | null;
  theme: 'light' | 'dark' | 'auto' | null;
  singleUse: boolean;
}

export function resolveConfig(raw: AltchaConfig | null): ResolvedConfig {
  const minutes = raw?.expiresMinutes;
  return {
    actions: { ...DEFAULT_ACTIONS, ...(raw?.actions ?? {}) },
    maxNumber: raw?.maxNumber ?? DEFAULT_MAX_NUMBER,
    // `0` means "never expires", which only a debugging session wants.
    expiresMs: minutes === 0 ? 0 : (minutes ?? DEFAULT_EXPIRES_MS / 60_000) * 60_000,
    language: raw?.language?.trim() ? raw.language.trim() : null,
    theme: raw?.theme ?? null,
    singleUse: raw?.singleUse ?? true,
  };
}

class AltchaPluginError extends PluginError {
  constructor(code: string, status: number, message: string) {
    super(code, status, message);
  }
}

export class AltchaService implements CaptchaProvider {
  readonly id = 'altcha';
  readonly name = 'ALTCHA（自托管）';

  private config: ResolvedConfig = resolveConfig(null);
  private hmacKey: string | null = null;
  private secretsReady = false;

  constructor(private readonly ctx: PluginContext) {}

  /**
   * `isAvailable()` is typed synchronous, but an **isolated** plugin reaches the
   * service over the host RPC bridge, where every call returns a Promise — a
   * bare `!ctx.secrets.isAvailable()` would then read a truthy Promise and take
   * the "available" branch even when no key is configured. Awaiting the value
   * works in both modes; `Promise.resolve` keeps the type honest.
   */
  private async secretsAvailable(): Promise<boolean> {
    return await Promise.resolve(this.ctx.secrets.isAvailable());
  }

  /** 读取（必要时生成）本地 HMAC 密钥与配置。 */
  async load(): Promise<void> {
    if (!(await this.secretsAvailable())) {
      // 没有平台密钥就没有稳定的签名密钥。宁可「什么都不做」，也不能对外
      // 宣称在验证 —— 一个校验永远失败的 provider 会把登录彻底锁死。
      this.ctx.logger.warn(
        'altcha: SETTINGS_ENCRYPTION_KEY 未配置，无法保存本地 HMAC 密钥；插件保持停用',
      );
      this.secretsReady = false;
      return;
    }
    this.secretsReady = true;

    const stored = await this.ctx.secrets.get(KEY_SECRET);
    if (stored && stored.trim().length >= 32) {
      this.hmacKey = stored.trim();
    } else {
      // 首次激活即生成：不需要任何人工配置，这是「装上就能用」的一部分。
      const generated = randomBytes(32).toString('hex');
      await this.ctx.secrets.set(KEY_SECRET, generated);
      this.hmacKey = generated;
      this.ctx.logger.info('altcha: generated a local HMAC key');
    }

    const raw = await this.ctx.secrets.get(CONFIG_KEY);
    if (!raw) return;
    try {
      const parsed = configSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.config = resolveConfig(parsed.data);
      else this.ctx.logger.warn('altcha: stored config is invalid, using defaults');
    } catch {
      this.ctx.logger.warn('altcha: stored config is unreadable, using defaults');
    }
  }

  /** 可用 = 有密钥；没密钥时绝不能对外宣称「在保护」。 */
  isConfigured(): boolean {
    return this.secretsReady && this.hmacKey !== null;
  }

  private requireKey(): string {
    if (!this.hmacKey) {
      throw new AltchaPluginError('altcha.not_configured', 503, '人机验证尚未就绪');
    }
    return this.hmacKey;
  }

  policyFor(action: string): CaptchaPolicy | null {
    if (!this.isConfigured()) return null;
    const mode = this.config.actions[action];
    return mode ? { mode } : null;
  }

  /** 无 action 时按登录策略回答（内核只用它做摘要展示）。 */
  clientConfig(): Record<string, unknown> | null {
    return this.clientConfigFor('login');
  }

  clientConfigFor(action: string): Record<string, unknown> | null {
    if (!this.isConfigured()) return null;
    if ((this.config.actions[action] ?? 'off') === 'off') return null;
    return {
      kind: 'element',
      tag: 'altcha-widget',
      // 同源脚本：经内核 BFF 取到，所以不需要任何 CSP 源。
      script: `${BFF_PREFIX}/widget.js`,
      attributes: {
        challenge: `${BFF_PREFIX}/challenge?action=${encodeURIComponent(action)}`,
        name: HIDDEN_FIELD,
        ...(this.config.language ? { language: this.config.language } : {}),
        ...(this.config.theme ? { theme: this.config.theme } : {}),
      },
      // 控件把解写进表单里的隐藏字段，而不是某个属性上。
      hiddenField: HIDDEN_FIELD,
      event: 'statechange',
      // 求解在工作线程里跑（`new Worker(URL.createObjectURL(blob))`）。不声明
      // 这个源，宿主 CSP 会按 `default-src` 拦掉 worker —— 控件在、但永远不过，
      // 而且浏览器只把原因写进控制台。
      sources: { worker: ['blob:'] },
    };
  }

  /** 签发一个新挑战；`singleUse` 时登记它的 id。 */
  async issue(action: string): Promise<ReturnType<typeof createChallenge>> {
    const key = this.requireKey();
    if ((this.config.actions[action] ?? 'off') === 'off') {
      throw new AltchaPluginError('altcha.action_disabled', 404, '该操作未启用人机验证');
    }

    const challenge = createChallenge({
      hmacKey: key,
      maxNumber: this.config.maxNumber,
      expiresMs: this.config.expiresMs,
    });

    if (this.config.singleUse) {
      // 登记「这个挑战是我们发的」。校验时用 consume 取回：取不到说明没发过
      // （伪造）或已经用过（重放），两种都拒。
      const ttl = this.config.expiresMs > 0 ? this.config.expiresMs : 60 * 60_000;
      await this.ctx.state.set(`altcha:c:${challenge.challenge}`, action, ttl);
    }
    return challenge;
  }

  async verify(input: CaptchaVerification): Promise<CaptchaVerifyResult> {
    // 失败关闭：任何异常都按「未通过」返回，绝不放行。
    if (!this.hmacKey) return { success: false, reason: 'not_configured' };
    const token = typeof input.token === 'string' ? input.token : '';
    const result = verifySolution(token, { hmacKey: this.hmacKey });
    if (!result.ok) return { success: false, reason: result.reason };

    if (this.config.singleUse) {
      const issued = await this.ctx.state.consume(`altcha:c:${result.id}`);
      if (issued === null) return { success: false, reason: 'replayed_or_unknown' };
    }
    return { success: true };
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      configured: this.isConfigured(),
      secretsEnabled: await this.secretsAvailable(),
      // 指纹便于运维确认「密钥换过没有」，本身不可反推。
      keyFingerprint: this.hmacKey ? this.hmacKey.slice(0, 8) : null,
      actions: this.config.actions,
      maxNumber: this.config.maxNumber,
      expiresMinutes: Math.round(this.config.expiresMs / 60_000),
      language: this.config.language,
      theme: this.config.theme,
      singleUse: this.config.singleUse,
      widgetBytes: WIDGET_SCRIPT.length,
    };
  }

  async configure(input: unknown): Promise<Record<string, unknown>> {
    if (!(await this.secretsAvailable())) {
      throw new AltchaPluginError('altcha.no_secrets', 503, '平台加密密钥未配置，无法保存设置');
    }
    const parsed = configSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new AltchaPluginError('altcha.invalid_config', 400, '请求参数无效');
    }
    // 未知 action 不落库：拼错的 key 会静默产生一个永远不被读取的策略。
    const actions: Record<string, Mode> = {};
    for (const [action, mode] of Object.entries(parsed.data.actions ?? {})) {
      if ((ALTCHA_ACTIONS as readonly string[]).includes(action)) actions[action] = mode;
    }
    const next: AltchaConfig = { ...parsed.data, actions: { ...DEFAULT_ACTIONS, ...actions } };
    await this.ctx.secrets.set(CONFIG_KEY, JSON.stringify(next));
    this.config = resolveConfig(next);
    return this.status();
  }

  /**
   * 自检：自己签发一道题、自己解开、自己校验，再验一次确认「一次性」生效。
   * 比起让运维手工贴 token，这能一次性验证密钥、时钟与状态存储都对。
   */
  async selfTest(): Promise<Record<string, unknown>> {
    const challenge = await this.issue('login');
    let solution = -1;
    for (let n = 0; n < challenge.maxnumber; n += 1) {
      if (createHash('sha256').update(challenge.salt + n).digest('hex') === challenge.challenge) {
        solution = n;
        break;
      }
    }
    if (solution < 0) return { ok: false, reason: 'unsolvable_challenge' };
    const token = Buffer.from(JSON.stringify({ ...challenge, number: solution })).toString(
      'base64',
    );
    const first = await this.verify({ token, action: 'login' });
    const second = await this.verify({ token, action: 'login' });
    return {
      ok: first.success && (this.config.singleUse ? !second.success : true),
      firstAttempt: first,
      secondAttempt: second,
      solved: solution,
    };
  }
}

let service: AltchaService | null = null;
let logger: PluginContext['logger'] | null = null;

function handle(
  handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown> | unknown,
): (req: HttpRequest, reply: HttpReply) => Promise<unknown> {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof AltchaPluginError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      if (error instanceof PluginError) {
        return reply.code(error.status ?? 400).send({ error: error.message, code: error.code });
      }
      // 原始错误只进日志：它可能带密钥或内部地址，不该回到浏览器。
      logger?.error(`altcha: ${String(error)}`);
      return reply.code(500).send({ error: '人机验证服务异常' });
    }
  };
}

const issueQuerySchema = z.object({
  action: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});

export const altchaPlugin = definePlugin({
  manifest: {
    id: 'altcha',
    name: '自托管人机验证',
    version: '0.1.0',
    description:
      '插件自己签发并校验 ALTCHA 工作量证明挑战：无第三方服务、无需站点密钥、装完即用，可保护登录、注册、改密码、改邮箱等操作。',
    provides: [EXTENSION_POINTS.captchaProvider],
    permissions: ['altcha.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['altcha.admin'] }],
    capabilities: [
      {
        id: 'altcha.admin.config.read',
        method: 'GET',
        route: '/altcha/admin/config',
        path: '/api/v1/altcha/admin/config',
        summary: 'Read the self-hosted captcha configuration',
        scope: 'altcha.admin',
      },
      {
        id: 'altcha.admin.config.write',
        method: 'POST',
        route: '/altcha/admin/config',
        path: '/api/v1/altcha/admin/config',
        summary: 'Update the per-action policy and proof-of-work difficulty',
        scope: 'altcha.admin',
        mutating: true,
        destructive: false,
      },
      {
        id: 'altcha.admin.test',
        method: 'POST',
        route: '/altcha/admin/test',
        path: '/api/v1/altcha/admin/test',
        summary: 'Solve and verify a self-issued challenge to prove the provider works',
        scope: 'altcha.admin',
        mutating: true,
        destructive: false,
      },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/altcha/admin/config',
      auth: 'user',
      permission: 'altcha.admin',
      handler: handle(async () => service!.status()),
    },
    {
      method: 'POST',
      path: '/altcha/admin/config',
      auth: 'user',
      permission: 'altcha.admin',
      handler: handle(async (req) => service!.configure(req.body)),
    },
    {
      method: 'POST',
      path: '/altcha/admin/test',
      auth: 'user',
      permission: 'altcha.admin',
      handler: handle(async () => service!.selfTest()),
    },
    {
      method: 'GET',
      path: '/altcha/widget.js',
      auth: 'public',
      handler: handle((_req, reply) => {
        // 同源提供：MIME 必须是 JS，否则浏览器直接拒绝执行。
        reply.header?.('content-type', 'text/javascript; charset=utf-8');
        reply.header?.('cache-control', 'public, max-age=86400');
        reply.header?.('x-content-type-options', 'nosniff');
        return reply.code(200).send(WIDGET_SCRIPT);
      }),
    },
    {
      method: 'GET',
      path: '/altcha/challenge',
      auth: 'public',
      // 挑战是公开数据，允许任意来源读取：私有化部署里页面域与 API 域常常不同。
      cors: { origins: ['*'], methods: ['GET'], maxAge: 600 },
      handler: handle(async (req) => {
        const parsed = issueQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success) throw new AltchaPluginError('altcha.invalid_query', 400, '请求参数无效');
        return service!.issue(parsed.data.action ?? 'login');
      }),
    },
  ],
  onActivate: async (ctx) => {
    logger = ctx.logger;
    const instance = new AltchaService(ctx);
    await instance.load();
    service = instance;
    // `ctx.effect` is called immediately to obtain the disposer (the same shape
    // the built-in captcha plugin uses); returning the cleanup, not running it.
    ctx.effect(() => () => {
      service = null;
      logger = null;
    });
    if (!instance.isConfigured()) {
      ctx.logger.warn('altcha: activated but idle (no local signing key)');
      return;
    }
    ctx.registerExtension<CaptchaProvider>(EXTENSION_POINTS.captchaProvider, instance);
    ctx.logger.info('altcha: activated (self-hosted proof of work)');
  },
  onDeactivate: (ctx) => {
    service = null;
    ctx.logger.info('altcha: deactivated');
  },
});

export default altchaPlugin;
