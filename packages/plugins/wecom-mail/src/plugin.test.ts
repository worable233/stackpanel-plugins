import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HttpReply,
  HttpRequest,
  IdentityChallengeMessage,
  IdentityChallengeSender,
  NotificationChannel,
  NotificationDispatch,
  PluginContext,
} from '@stackpanel/sdk';
import { wecomMailPlugin } from './index.js';

/**
 * 插件装配层的契约测试：路由表（谁能调、要不要权限）、配置合并规则、
 * 两个扩展点的接线，以及"上游报错 → 稳定错误码"这条翻译。
 *
 * 网络层在 `wecom-client.test.ts` 里单独测；这里把 `fetch` 整体打桩，验的是
 * 插件**装进内核之后**的行为——包括它绝不在响应里回显 Secret。
 */

const ORIGINAL_FETCH = globalThis.fetch;

/** access_token / compose_send 的成功应答。 */
function okResponses(): void {
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    call += 1;
    return new Response(
      call === 1
        ? JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'TOKEN', expires_in: 7200 })
        : JSON.stringify({ errcode: 0, errmsg: 'ok' }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
}

interface Captured {
  extensions: Array<[string, unknown]>;
  secrets: Map<string, string>;
  users: Map<string, { email: string | null }>;
  context: PluginContext;
}

function activate(): Captured {
  const captured: Captured = {
    extensions: [],
    secrets: new Map<string, string>(),
    users: new Map([['user-1', { email: 'user@example.com' }]]),
    context: undefined as unknown as PluginContext,
  };
  captured.context = {
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    secrets: {
      isAvailable: () => true,
      get: async (key: string) => captured.secrets.get(key) ?? null,
      set: async (key: string, value: string) => {
        captured.secrets.set(key, value);
      },
      delete: async (key: string) => {
        captured.secrets.delete(key);
      },
    },
    auth: {
      getUser: async (id: string) => captured.users.get(id) ?? null,
    },
    registerExtension: (point: string, implementation: unknown) => {
      captured.extensions.push([point, implementation]);
      return () => undefined;
    },
    effect: () => () => undefined,
  } as unknown as PluginContext;
  return captured;
}

function route(method: string, path: string) {
  const found = (wecomMailPlugin.routes ?? []).find(
    (entry) => entry.method === method && entry.path === path,
  );
  if (!found) throw new Error(`route not found: ${method} ${path}`);
  return found;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ value?: unknown; error?: { code: string; status: number } }> {
  try {
    const value = await route(method, path).handler(
      { body, headers: {}, query: {}, params: {} } as unknown as HttpRequest,
      {} as HttpReply,
    );
    return { value };
  } catch (error) {
    const typed = error as { code?: string; status?: number };
    return { error: { code: typed.code ?? 'unknown', status: typed.status ?? 0 } };
  }
}

const VALID_CONFIG = {
  corpId: 'ww1234567890',
  corpSecret: 'secret-value',
  from: 'noreply@example.com',
  publicBaseUrl: 'https://panel.example.com',
};

beforeEach(() => {
  okResponses();
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  await wecomMailPlugin.onDeactivate?.(activate().context);
});

describe('wecom-mail plugin wiring', () => {
  it('exposes admin-only, permission-gated routes', () => {
    for (const path of ['/wecom-mail/admin/config', '/wecom-mail/admin/test']) {
      const entry = (wecomMailPlugin.routes ?? []).find((item) => item.path === path);
      expect(entry?.auth).toBe('admin');
      expect(entry?.permission).toBe('wecom-mail.admin');
    }
    // 开放平台面镜像每一个内部路由（少一条就等于某个能力没有对外路径）。
    const capabilityRoutes = (wecomMailPlugin.manifest.capabilities ?? []).map(
      (capability) => capability.route,
    );
    for (const path of ['/wecom-mail/admin/config', '/wecom-mail/admin/test']) {
      expect(capabilityRoutes).toContain(path);
    }
  });

  it('registers both kernel extension points under the same service', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);
    const points = captured.extensions.map(([point]) => point);
    expect(points).toHaveLength(2);
    const channel = captured.extensions.find(
      ([point]) => point === 'notification.channel',
    )?.[1] as NotificationChannel;
    const sender = captured.extensions.find(
      ([point]) => point === 'identity.challengeSender',
    )?.[1] as IdentityChallengeSender;
    expect(channel.id).toBe(sender.id);
    expect(channel.name).toBeTruthy();
  });
});

describe('configuration lifecycle', () => {
  it('reports an unconfigured channel instead of failing the route', async () => {
    await wecomMailPlugin.onActivate?.(activate().context);
    const result = await call('GET', '/wecom-mail/admin/config');
    expect(result.value).toMatchObject({ configured: false });
  });

  it('refuses to send before it is configured', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);
    const sender = captured.extensions.find(
      ([point]) => point === 'identity.challengeSender',
    )?.[1] as IdentityChallengeSender;
    await expect(
      sender.send({
        email: 'user@example.com',
        code: '123456',
        expiresAt: new Date(Date.now() + 600_000),
      } as IdentityChallengeMessage),
    ).rejects.toMatchObject({ code: 'wecom-mail.not_configured' });
  });

  it('stores the secret encrypted and never echoes it back', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);

    const saved = await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);
    expect(saved.error).toBeUndefined();
    expect(JSON.stringify(saved.value)).not.toContain('secret-value');
    // 凭据进的是加密存储，不是普通设置。
    expect(captured.secrets.get('wecom-mail-config')).toContain('secret-value');

    const read = await call('GET', '/wecom-mail/admin/config');
    expect(JSON.stringify(read.value)).not.toContain('secret-value');
    expect(read.value).toMatchObject({ configured: true, corpId: VALID_CONFIG.corpId });
  });

  it('keeps the saved secret when the form leaves it blank', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);
    await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);

    const updated = await call('POST', '/wecom-mail/admin/config', {
      ...VALID_CONFIG,
      corpSecret: '',
      excludeTypes: 'security.',
    });
    expect(updated.error).toBeUndefined();
    expect(captured.secrets.get('wecom-mail-config')).toContain('secret-value');
    expect(updated.value).toMatchObject({ excludeTypes: 'security.' });
  });

  it('rejects the first save without any secret', async () => {
    await wecomMailPlugin.onActivate?.(activate().context);
    const result = await call('POST', '/wecom-mail/admin/config', { corpId: 'ww1' });
    expect(result.error).toMatchObject({ code: 'wecom-mail.invalid_config', status: 400 });
  });

  it('rejects an obviously invalid configuration before spending a request', async () => {
    await wecomMailPlugin.onActivate?.(activate().context);
    const result = await call('POST', '/wecom-mail/admin/config', {
      ...VALID_CONFIG,
      baseUrl: 'not-a-url',
    });
    expect(result.error).toMatchObject({ code: 'wecom-mail.invalid_config' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('delivery paths', () => {
  it('delivers a verification code through the challenge sender', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);
    await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);

    const sender = captured.extensions.find(
      ([point]) => point === 'identity.challengeSender',
    )?.[1] as IdentityChallengeSender;
    await sender.send({
      email: 'user@example.com',
      code: '426913',
      expiresAt: new Date(Date.now() + 600_000),
      locale: 'en-US',
    } as IdentityChallengeMessage);

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const compose = calls.at(-1);
    const body = JSON.parse((compose?.[1] as RequestInit).body as string);
    expect(body.to).toEqual({ emails: ['user@example.com'] });
    expect(body.subject).toBe('StackPanel verification code');
    expect(body.content).toContain('426913');
    expect(body.content_type).toBe('html');
  });

  it('skips excluded notification types and resolves relative links', async () => {
    const captured = activate();
    await wecomMailPlugin.onActivate?.(captured.context);
    await call('POST', '/wecom-mail/admin/config', {
      ...VALID_CONFIG,
      excludeTypes: 'security.,system.',
    });

    const channel = captured.extensions.find(
      ([point]) => point === 'notification.channel',
    )?.[1] as NotificationChannel;
    const dispatch = (type: string) =>
      ({
        type,
        userId: 'user-1',
        title: '订单已支付',
        body: '金额 ¥100',
        link: '/orders/1',
      }) as unknown as NotificationDispatch;

    expect(channel.wants(dispatch('security.login_failed'))).toBe(false);
    expect(channel.wants(dispatch('order.paid'))).toBe(true);

    await channel.deliver(dispatch('order.paid'));
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.content).toContain('https://panel.example.com/orders/1');
  });

  it('does not chase a user with no email (a throw would retry forever)', async () => {
    const captured = activate();
    captured.users.set('user-2', { email: null });
    await wecomMailPlugin.onActivate?.(captured.context);
    await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);

    const channel = captured.extensions.find(
      ([point]) => point === 'notification.channel',
    )?.[1] as NotificationChannel;
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    await expect(
      channel.deliver({
        type: 'order.paid',
        userId: 'user-2',
        title: 't',
        body: 'b',
      } as unknown as NotificationDispatch),
    ).resolves.toBeUndefined();
    const after = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(after).toBe(before);
  });
});

describe('admin test send', () => {
  it('validates the recipient and reports success', async () => {
    await wecomMailPlugin.onActivate?.(activate().context);
    await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);

    const bad = await call('POST', '/wecom-mail/admin/test', { to: 'nope' });
    expect(bad.error).toMatchObject({ code: 'wecom-mail.invalid_email' });

    const good = await call('POST', '/wecom-mail/admin/test', { to: 'admin@example.com' });
    expect(good.value).toMatchObject({ sent: true, to: 'admin@example.com' });
  });

  it('surfaces the WeCom error code (502, so the kernel can retry)', async () => {
    await wecomMailPlugin.onActivate?.(activate().context);
    await call('POST', '/wecom-mail/admin/config', VALID_CONFIG);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ errcode: 60020, errmsg: 'ip not allowed' })),
    ) as unknown as typeof globalThis.fetch;

    const result = await call('POST', '/wecom-mail/admin/test', { to: 'admin@example.com' });
    expect(result.error).toMatchObject({ code: 'wecom.ip_not_allowed', status: 502 });
  });
});
