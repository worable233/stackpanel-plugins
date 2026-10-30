import { describe, expect, it } from 'vitest';
import {
  buildCustomCall,
  customRouteAdaptor,
  routeOf,
  validateCustomRoute,
} from './custom-route.js';
import type { AdaptorAccount } from './types.js';
import type { IRRequest } from '@stackpanel/llm-protocol';

function account(
  options: Record<string, unknown>,
  baseUrl = 'https://api.example.com',
): AdaptorAccount {
  return { id: 'acc_1', name: 'demo', baseUrl, apiKey: 'sk-test', options };
}

function input(overrides: Partial<Parameters<typeof buildCustomCall>[1]> = {}) {
  return {
    account: account({}),
    body: { model: 'm', messages: [] },
    subPath: '/v1/chat/completions',
    query: new URLSearchParams(),
    stream: false,
    ir: { model: 'upstream-m' } as IRRequest,
    ...overrides,
  };
}

describe('validateCustomRoute', () => {
  it('接受带 {baseUrl} 的模板并归一化', () => {
    const result = validateCustomRoute({
      urlTemplate: '{baseUrl}/chat',
      method: 'post',
      authType: 'x-api-key',
      headers: { 'X-Tenant': 'acme' },
    });
    expect(result.ok).toBe(true);
    expect(result.spec).toEqual({
      urlTemplate: '{baseUrl}/chat',
      method: 'POST',
      authType: 'x-api-key',
      headers: { 'x-tenant': 'acme' },
      contentType: 'application/json',
    });
  });

  it('接受绝对 URL，默认 POST + bearer', () => {
    const result = validateCustomRoute({ urlTemplate: 'https://x.example.com/v1/chat' });
    expect(result.ok).toBe(true);
    expect(result.spec?.method).toBe('POST');
    expect(result.spec?.authType).toBe('bearer');
  });

  it('拒绝相对地址与缺失模板', () => {
    expect(validateCustomRoute({}).ok).toBe(false);
    expect(validateCustomRoute({ urlTemplate: '/v1/chat' }).ok).toBe(false);
    expect(validateCustomRoute('nope').ok).toBe(false);
  });

  it('拒绝未知占位符、路径穿越、换行注入', () => {
    expect(validateCustomRoute({ urlTemplate: '{baseUrl}/{model}/{unknown}' }).ok).toBe(false);
    expect(validateCustomRoute({ urlTemplate: '{baseUrl}/../admin' }).ok).toBe(false);
    expect(validateCustomRoute({ urlTemplate: '{baseUrl}/x\r\nHost: evil' }).ok).toBe(false);
  });

  it('拒绝覆盖鉴权/协议头与非法头名', () => {
    expect(
      validateCustomRoute({ urlTemplate: '{baseUrl}/x', headers: { authorization: 'x' } }).ok,
    ).toBe(false);
    expect(
      validateCustomRoute({ urlTemplate: '{baseUrl}/x', headers: { 'bad header': 'x' } }).ok,
    ).toBe(false);
  });

  it('拒绝未知 method / authType / 越界 authParam', () => {
    expect(validateCustomRoute({ urlTemplate: '{baseUrl}/x', method: 'TRACE' }).ok).toBe(false);
    expect(validateCustomRoute({ urlTemplate: '{baseUrl}/x', authType: 'oauth' }).ok).toBe(false);
    expect(
      validateCustomRoute({ urlTemplate: '{baseUrl}/x', authType: 'query', authParam: 'a b' }).ok,
    ).toBe(false);
  });
});

describe('routeOf', () => {
  it('账号没有 route 时返回 null', () => {
    expect(routeOf(account({}))).toBeNull();
    expect(routeOf(account({ route: { urlTemplate: '/relative' } }))).toBeNull();
  });
});

describe('buildCustomCall', () => {
  const route = { urlTemplate: '{baseUrl}/v2/chat/{model}', authType: 'bearer' as const };

  it('填充占位符并注入 Bearer', () => {
    const call = buildCustomCall(account({ route }), input());
    expect(call.url).toBe('https://api.example.com/v2/chat/upstream-m');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer sk-test');
    expect(call.body).toBe(JSON.stringify({ model: 'm', messages: [] }));
  });

  it('x-api-key 与 query 两种鉴权', () => {
    const header = buildCustomCall(
      account({ route: { ...route, authType: 'x-api-key' } }),
      input(),
    );
    expect(header.headers['x-api-key']).toBe('sk-test');
    expect(header.headers['authorization']).toBeUndefined();

    const queryCall = buildCustomCall(
      account({ route: { ...route, authType: 'query', authParam: 'api_key' } }),
      input(),
    );
    expect(new URL(queryCall.url).searchParams.get('api_key')).toBe('sk-test');
  });

  it('authType none 不带凭证', () => {
    const call = buildCustomCall(account({ route: { ...route, authType: 'none' } }), input());
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.headers['x-api-key']).toBeUndefined();
  });

  it('GET 不带请求体与 content-type', () => {
    const call = buildCustomCall(account({ route: { ...route, method: 'GET' } }), input());
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('透传入口 query 与静态头', () => {
    const call = buildCustomCall(
      account({ route: { ...route, headers: { 'x-tenant': 'acme' } } }),
      input({ query: new URLSearchParams({ 'api-version': '2024-06-01' }) }),
    );
    expect(new URL(call.url).searchParams.get('api-version')).toBe('2024-06-01');
    expect(call.headers['x-tenant']).toBe('acme');
  });

  it('{stream} 按流式标记填充', () => {
    const call = buildCustomCall(
      account({ route: { urlTemplate: '{baseUrl}/chat?stream={stream}' } }),
      input({ stream: true }),
    );
    expect(new URL(call.url).searchParams.get('stream')).toBe('true');
  });

  it('缺少 route 配置时明确报错', () => {
    expect(() => buildCustomCall(account({}), input())).toThrowError(/route/);
  });

  it('生产环境下内网地址被 SSRF 校验拦下', () => {
    // SSRF 防护只在生产开启（开发期允许本地 mock 上游），这里显式切换环境。
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() =>
        buildCustomCall(
          account(
            { route: { urlTemplate: 'http://127.0.0.1:8080/v1/chat' } },
            'http://127.0.0.1:8080',
          ),
          input(),
        ),
      ).toThrowError(/公网/);
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  });
});

describe('customRouteAdaptor', () => {
  it('注册信息保守：openai-chat 方言、不注入 stream_options、不声明 operations', () => {
    expect(customRouteAdaptor.id).toBe('custom');
    expect(customRouteAdaptor.protocol).toBe('openai-chat');
    expect(customRouteAdaptor.capabilities.streamUsage).toBe(false);
    expect(customRouteAdaptor.capabilities.operations).toEqual([]);
    expect(customRouteAdaptor.authHeaders(account({}))).toEqual({});
  });
});
