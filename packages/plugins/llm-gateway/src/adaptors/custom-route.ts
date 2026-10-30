/**
 * 自定义上游路由（C3）。
 *
 * 有些上游「一家一条私有协议」：路径不是 `/v1/chat/completions`，鉴权不是
 * `Authorization: Bearer`，甚至要靠 query 传 key。给每个这样的厂商写一个
 * adaptor 不划算，于是提供一个**声明式路由**：管理员填模板，插件按模板拼 URL。
 *
 * 与对手的关键差别：这里**没有 converter 代码**。新-api 允许在渠道里挂一段
 * 可执行转换脚本，我们只允许：
 *
 * - URL 模板（`{baseUrl}` `{path}` `{model}` `{stream}` 四个占位符）
 * - HTTP 方法、内容类型
 * - 四种鉴权方式（bearer / x-api-key / query / 无）
 * - 附加静态头
 *
 * 需要真正改请求体结构的场景，走 C4 的白名单改写或写一个 adaptor——两者都
 * 是静态可审计的。把「能执行任意代码」放进渠道配置，等于把鉴权与计费链路的
 * 入参交给一段不受审的脚本，我们不接受这个交换。
 */

import type {
  ProviderAdaptor,
  AdaptorAccount,
  AdaptorRequestInput,
  UpstreamCall,
} from './types.js';
import { createAdaptor } from './base.js';
import { GatewayError } from '../errors.js';
import { isAllowedUpstreamUrl } from '../guard.js';

export type CustomAuthType = 'bearer' | 'x-api-key' | 'query' | 'none';

export interface CustomRouteSpec {
  /** 目标地址模板；必须能拼出绝对 http(s) URL。 */
  urlTemplate: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  authType?: CustomAuthType | undefined;
  /** `authType: 'query'` 时的参数名，默认 `key`。 */
  authParam?: string | undefined;
  /** 附加静态请求头。 */
  headers?: Record<string, string> | undefined;
  /** 请求体内容类型，默认 `application/json`。 */
  contentType?: string | undefined;
}

const METHODS = new Set(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']);
const AUTH_TYPES = new Set<CustomAuthType>(['bearer', 'x-api-key', 'query', 'none']);

/** 头名白名单式校验（HTTP token 字符），并拒绝改写鉴权/协议关键头。 */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const RESERVED_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
  'content-encoding',
]);

/** 模板允许的占位符（未知占位符直接报错，避免「写了但没生效」的困惑）。 */
const PLACEHOLDERS = new Set(['baseUrl', 'path', 'model', 'stream']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CustomRouteValidation {
  ok: boolean;
  spec: CustomRouteSpec | null;
  issues: string[];
}

/**
 * 校验并归一化自定义路由。管理端写入时调用；运行期假定已合法。
 *
 * 拒绝的形态都有具体理由：
 * - 模板里出现 `../`、换行、`{{`：路径穿越与请求头注入的入口，一律不许。
 * - 未知占位符：静默忽略会让管理员以为生效了。
 * - 覆盖鉴权头：凭证注入必须由 `authType` 单一来源决定。
 */
export function validateCustomRoute(raw: unknown): CustomRouteValidation {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, spec: null, issues: ['自定义路由必须是对象'] };
  }
  const urlTemplate = typeof raw['urlTemplate'] === 'string' ? raw['urlTemplate'].trim() : '';
  if (!urlTemplate) {
    return { ok: false, spec: null, issues: ['缺少 urlTemplate'] };
  }
  if (/[\r\n\t]/.test(urlTemplate)) issues.push('urlTemplate 不能包含换行或制表符');
  if (urlTemplate.includes('..')) issues.push('urlTemplate 不能包含 ..');
  for (const match of urlTemplate.matchAll(/\{([^}]*)\}/g)) {
    const name = (match[1] ?? '').trim();
    if (!PLACEHOLDERS.has(name)) issues.push(`未知占位符：{${name}}`);
  }
  if (!urlTemplate.includes('{baseUrl}') && !/^https?:\/\//i.test(urlTemplate)) {
    issues.push('urlTemplate 必须是绝对地址，或包含 {baseUrl}');
  }

  const rawMethod = typeof raw['method'] === 'string' ? raw['method'].toUpperCase() : 'POST';
  if (!METHODS.has(rawMethod)) issues.push(`不支持的 method：${rawMethod}`);

  const rawAuth = typeof raw['authType'] === 'string' ? raw['authType'] : 'bearer';
  if (!AUTH_TYPES.has(rawAuth as CustomAuthType)) issues.push(`不支持的 authType：${rawAuth}`);

  const headers: Record<string, string> = {};
  const rawHeaders = raw['headers'];
  if (rawHeaders !== undefined) {
    if (!isRecord(rawHeaders)) {
      issues.push('headers 必须是对象');
    } else {
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (!HEADER_NAME.test(name)) {
          issues.push(`头名不合法：${name}`);
          continue;
        }
        if (RESERVED_HEADERS.has(name.toLowerCase())) {
          issues.push(`不允许自定义这些头：${name}`);
          continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          issues.push(`头 ${name} 的值必须是字符串/数字/布尔`);
          continue;
        }
        headers[name.toLowerCase()] = String(value);
      }
    }
  }

  const authParam = typeof raw['authParam'] === 'string' ? raw['authParam'].trim() : '';
  if (authParam && !/^[A-Za-z0-9_-]+$/.test(authParam)) {
    issues.push('authParam 只能是字母数字下划线短横');
  }

  const contentType =
    typeof raw['contentType'] === 'string' && raw['contentType'].trim()
      ? raw['contentType'].trim()
      : 'application/json';
  if (/[\r\n]/.test(contentType)) issues.push('contentType 不能包含换行');

  if (issues.length > 0) return { ok: false, spec: null, issues };

  return {
    ok: true,
    issues: [],
    spec: {
      urlTemplate,
      method: rawMethod as CustomRouteSpec['method'],
      authType: rawAuth as CustomAuthType,
      ...(authParam ? { authParam } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      contentType,
    },
  };
}

/** 从账号 `options.route` 取路由配置；缺失或非法返回 null。 */
export function routeOf(account: AdaptorAccount): CustomRouteSpec | null {
  const result = validateCustomRoute(account.options['route']);
  return result.ok ? result.spec : null;
}

function fillTemplate(template: string, values: Record<string, string>): string | null {
  let missing = false;
  const filled = template.replace(/\{([^}]*)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = values[name];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : filled;
}

/**
 * 按模板构造上游调用。
 *
 * `{baseUrl}` 用账号的 baseUrl（已过 SSRF 校验），`{path}` 用 codec 给出的
 * 相对路径，`{model}` 用 IR 里的上游模型名，`{stream}` 为 `true|false`。
 */
export function buildCustomCall(account: AdaptorAccount, input: AdaptorRequestInput): UpstreamCall {
  const spec = routeOf(account);
  if (!spec) {
    throw new GatewayError(400, 'invalid_upstream', '自定义上游缺少合法的 route 配置');
  }

  const baseUrl = account.baseUrl.replace(/\/+$/, '');
  const path = input.subPath.startsWith('/') ? input.subPath : `/${input.subPath}`;
  const url = fillTemplate(spec.urlTemplate, {
    baseUrl,
    path,
    model: input.ir.model ?? '',
    stream: input.stream ? 'true' : 'false',
  });
  if (url === null) {
    throw new GatewayError(400, 'invalid_upstream', '自定义上游路由模板占位符无法填充');
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new GatewayError(400, 'invalid_upstream', '自定义上游路由不是合法 URL');
  }

  // 透传入口 query，再按鉴权方式追加/覆盖。
  for (const [key, value] of input.query.entries()) target.searchParams.set(key, value);
  const headers: Record<string, string> = {
    'content-type': spec.contentType ?? 'application/json',
  };
  for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name] = value;

  const authType = spec.authType ?? 'bearer';
  if (authType === 'bearer' && account.apiKey) {
    headers['authorization'] = `Bearer ${account.apiKey}`;
  } else if (authType === 'x-api-key' && account.apiKey) {
    headers['x-api-key'] = account.apiKey;
  } else if (authType === 'query' && account.apiKey) {
    target.searchParams.set(spec.authParam ?? 'key', account.apiKey);
  }

  if (!isAllowedUpstreamUrl(target.toString())) {
    throw new GatewayError(400, 'invalid_upstream', '上游地址必须为公网地址');
  }

  const serialized =
    spec.method === 'GET' || spec.method === 'DELETE'
      ? undefined
      : typeof input.body === 'string'
        ? input.body
        : JSON.stringify(input.body ?? {});
  if (serialized === undefined) delete headers['content-type'];

  return {
    url: target.toString(),
    method: (spec.method ?? 'POST') as UpstreamCall['method'],
    headers,
    ...(serialized === undefined ? {} : { body: serialized }),
  };
}

/**
 * `custom` provider 的 adaptor：方言按 OpenAI Chat，但端点与鉴权完全由
 * `options.route` 决定。能力位取保守值（不声明 operations、不注入 stream_options），
 * 因为自定义路由下我们无从得知上游到底支持什么。
 */
export const customRouteAdaptor: ProviderAdaptor = createAdaptor({
  id: 'custom',
  label: '自定义路由',
  protocol: 'openai-chat',
  capabilities: {
    operations: [],
    streaming: true,
    websocket: false,
    customSigning: false,
    toolCalls: true,
    images: false,
    promptCache: false,
    streamUsage: false,
  },
  authHeaders: () => ({}),
  buildRequest: (input) => buildCustomCall(input.account, input),
  preservedFields: [],
});
