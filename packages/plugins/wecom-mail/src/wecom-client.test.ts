import { describe, expect, it, vi } from 'vitest';
import { WecomError, WecomMailClient, type WecomMailConfig } from './wecom-client.js';

/**
 * 企业微信发件客户端（文档 path/97445）的契约测试。
 *
 * 这里钉的是"线上最容易出错的四件事"：token 复用、token 失效重试一次、
 * 厂商错误码 → 稳定错误码、以及请求体字段名（企业微信失败也是 HTTP 200，
 * 字段名写错了只会得到一句 errcode，很容易被当成网络问题排查半天）。
 */

const CONFIG: WecomMailConfig = {
  corpId: 'ww1234567890',
  corpSecret: 'secret-value',
  baseUrl: 'https://qyapi.weixin.qq.com',
  timeoutMs: 5000,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** 按顺序返回预设响应的 fetch 桩，并记录每次调用的 URL 与方法。 */
function stubFetch(responses: Array<{ json: unknown; status?: number; raw?: string }>) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const payload = next?.raw ?? JSON.stringify(next?.json ?? { errcode: 0, errmsg: 'ok' });
    return new Response(payload, { status: next?.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function tokenResponse(token = 'TOKEN-1', expiresIn = 7200) {
  return { errcode: 0, errmsg: 'ok', access_token: token, expires_in: expiresIn };
}

describe('WecomMailClient token handling', () => {
  it('fetches the access token once and reuses it for later sends', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: tokenResponse() }, { json: {} }, { json: {} }]);
    // 固定时钟：`expires_in` 的换算不该随测试运行时长漂移一秒。
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl, now: () => 1_700_000_000_000 });

    await client.send({ to: ['a@example.com'], subject: 's1', content: 'c1', contentType: 'text' });
    await client.send({ to: ['a@example.com'], subject: 's2', content: 'c2', contentType: 'text' });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/cgi-bin/gettoken',
      '/cgi-bin/exmail/app/compose_send',
      '/cgi-bin/exmail/app/compose_send',
    ]);
    expect(client.tokenState()?.expiresInSeconds).toBe(7200);
  });

  it('refreshes before the token expires (skew on a cached-but-old token)', async () => {
    let clock = 1_000_000;
    const { fetchImpl, calls } = stubFetch([
      { json: tokenResponse('T1', 7200) },
      { json: {} },
      { json: tokenResponse('T2', 7200) },
      { json: {} },
    ]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl, now: () => clock });

    await client.send({ to: ['a@example.com'], subject: 's', content: 'c', contentType: 'text' });
    // 7 小时后：缓存的 token 已在 60 秒内到期，必须换新的。
    clock += 7 * 60 * 60 * 1000;
    await client.send({ to: ['a@example.com'], subject: 's', content: 'c', contentType: 'text' });

    expect(calls.filter((call) => call.url.includes('/cgi-bin/gettoken'))).toHaveLength(2);
    expect(calls.at(-1)?.url).toContain('access_token=T2');
  });

  it('refreshes and retries exactly once when the server invalidates the token', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: tokenResponse('STALE') },
      { json: { errcode: 42001, errmsg: 'access_token expired' } },
      { json: tokenResponse('FRESH') },
      { json: {} },
    ]);
    const warn = vi.fn();
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl, warn });

    await client.send({ to: ['a@example.com'], subject: 's', content: 'c', contentType: 'text' });

    const compose = calls.filter((call) => call.url.includes('compose_send'));
    expect(compose).toHaveLength(2);
    expect(compose[0]?.url).toContain('access_token=STALE');
    expect(compose[1]?.url).toContain('access_token=FRESH');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry business errors (a wrong config must not become three attempts)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: tokenResponse() },
      { json: { errcode: 48002, errmsg: 'api forbidden' } },
    ]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });

    await expect(
      client.send({ to: ['a@example.com'], subject: 's', content: 'c', contentType: 'text' }),
    ).rejects.toMatchObject({ code: 'wecom.mail_forbidden' });
    expect(calls.filter((call) => call.url.includes('compose_send'))).toHaveLength(1);
    // 业务错误不该顺手把 token 缓存也丢了。
    expect(client.tokenState()).not.toBeNull();
  });
});

describe('WecomMailClient error mapping', () => {
  const cases: Array<[number, string]> = [
    [40001, 'wecom.invalid_secret'],
    [40013, 'wecom.invalid_corp_id'],
    [60020, 'wecom.ip_not_allowed'],
    [48002, 'wecom.mail_forbidden'],
    [45009, 'wecom.rate_limited'],
    [301002, 'wecom.send_failed'],
  ];

  for (const [errcode, code] of cases) {
    it(`maps ${errcode} to ${code}`, async () => {
      const { fetchImpl } = stubFetch([{ json: { errcode, errmsg: 'boom' } }]);
      const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });
      const error = await client.accessToken().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WecomError);
      expect((error as WecomError).code).toBe(code);
      expect((error as WecomError).errcode).toBe(errcode);
    });
  }

  it('reports a non-JSON body instead of pretending it failed to send', async () => {
    const { fetchImpl } = stubFetch([{ raw: '<html>502 Bad Gateway</html>', status: 502 }]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });
    await expect(client.accessToken()).rejects.toMatchObject({ code: 'wecom.bad_response' });
  });

  it('wraps transport failures as network errors with the original cause', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND qyapi.weixin.qq.com');
    }) as unknown as typeof globalThis.fetch;
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });
    const error = await client.accessToken().catch((caught: unknown) => caught);
    expect((error as WecomError).code).toBe('wecom.network_error');
    expect((error as WecomError).message).toContain('ENOTFOUND');
  });
});

describe('WecomMailClient request shape', () => {
  it('sends the documented compose_send body', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: tokenResponse() }, { json: {} }]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });

    await client.send({
      to: ['a@example.com', 'A@example.com', ' b@example.com '],
      subject: '注册验证码',
      content: '<p>123456</p>',
      contentType: 'html',
      cc: ['cc@example.com'],
    });

    const compose = calls.at(-1);
    expect(compose?.method).toBe('POST');
    expect(new URL(compose?.url ?? '').searchParams.get('access_token')).toBe('TOKEN-1');
    expect(compose?.body).toEqual({
      // 大小写不同的同一个地址只发一次。
      to: { emails: ['a@example.com', 'b@example.com'] },
      cc: { emails: ['cc@example.com'] },
      subject: '注册验证码',
      content: '<p>123456</p>',
      content_type: 'html',
    });
  });

  it('rejects an empty recipient list before spending a network call', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: tokenResponse() }]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });
    await expect(
      client.send({ to: ['  '], subject: 's', content: 'c', contentType: 'text' }),
    ).rejects.toMatchObject({ code: 'wecom.send_failed' });
    expect(calls).toHaveLength(0);
  });

  it('enforces the 50 recipient ceiling (including cc/bcc)', async () => {
    const { fetchImpl } = stubFetch([{ json: tokenResponse() }]);
    const client = new WecomMailClient(CONFIG, { fetch: fetchImpl });
    const many = Array.from({ length: 50 }, (_, index) => `u${index}@example.com`);
    await expect(
      client.send({
        to: many,
        cc: ['cc@example.com'],
        subject: 's',
        content: 'c',
        contentType: 'text',
      }),
    ).rejects.toMatchObject({ code: 'wecom.send_failed' });
  });

  it('honours a custom baseUrl (proxy / mirror) without duplicating slashes', async () => {
    const { fetchImpl, calls } = stubFetch([{ json: tokenResponse() }, { json: {} }]);
    const client = new WecomMailClient(
      { ...CONFIG, baseUrl: 'https://wecom-proxy.internal/' },
      { fetch: fetchImpl },
    );
    await client.send({ to: ['a@example.com'], subject: 's', content: 'c', contentType: 'text' });
    expect(calls[0]?.url.startsWith('https://wecom-proxy.internal/cgi-bin/gettoken?')).toBe(true);
  });
});
