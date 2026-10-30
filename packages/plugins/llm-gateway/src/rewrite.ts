/**
 * 参数/头改写与状态码映射（C4）。
 *
 * 有些上游「说是 OpenAI 兼容，其实不是」：某字段直接 400、某头必须换名、
 * 某状态码含义与 OpenAI 相反。新-api 的做法是给每个渠道写一段可执行的
 * 参数覆盖；我们刻意把能力收窄成**四种白名单操作**：
 *
 * | 操作 | 形态 | 例子 |
 * | --- | --- | --- |
 * | `set` | 点路径 → 常量 | `temperature = 0.2` |
 * | `unset` | 点路径列表 | 删掉上游不认的 `stream_options` |
 * | `rename` | 旧点路径 → 新点路径 | `max_tokens → max_completion_tokens` |
 * | `setHeaders` / `unsetHeaders` | 头名 → 值 | 换 `api-key` 头名 |
 *
 * 为什么不做通用 JSONPath / JSONata / JS：**改写器直接坐在计费链路上**。
 * 一个「能做任意计算」的改写器，等于给改配置的人一个改动计费入参的执行面；
 * 而且真正的转换需求（协议差异）已经由 adaptor + codec 承担，这里要解决的
 * 只是边角料。收窄到「写常量、删字段、改名」，副作用可以被静态说清楚，
 * 也才能把每次改写如实写进用量流水。
 *
 * 两条纪律：
 * 1. **默认关闭**。账号上 `rewrites.enabled !== true` 时整条链路不做任何改写，
 *    老账号行为完全不变。
 * 2. **每次改写都留痕**。`applied` 列表随用量流水落库（`rewrites` 列），
 *    事后能回答「这笔请求当时到底被改了什么」。
 */

/** 允许写进请求体的标量（对象/数组要显式给出，避免无意塞入整个结构）。 */
export type RewriteScalar = string | number | boolean | null;

export interface AccountRewriteConfig {
  /** 总开关；不给或 false = 不改写（默认关闭）。 */
  enabled?: boolean;
  /** 点路径 → 常量。 */
  set?: Record<string, RewriteScalar>;
  /** 要删除的点路径。 */
  unset?: string[];
  /** 旧点路径 → 新点路径。 */
  rename?: Record<string, string>;
  /** 头名（大小写不敏感）→ 值。 */
  setHeaders?: Record<string, string>;
  /** 要删除的头名（大小写不敏感）。 */
  unsetHeaders?: string[];
  /** 上游状态码 → 对客户端暴露的状态码，例如 `{ "529": 503 }`。 */
  statusMap?: Record<string, number>;
}

export interface RewriteResult<T> {
  value: T;
  /** 人类可读的改写痕迹，例如 `body.set:temperature`。 */
  applied: string[];
}

/** 每类操作的条数上限：改写表是人工维护的边角配置，不该长成脚本。 */
export const MAX_REWRITE_OPS = 20;
/** 点路径最大层数：`a.b.c` 足够了，更深的要么是 adaptor 该管的事，要么是滥用。 */
export const MAX_PATH_DEPTH = 3;
/** 落进流水 `rewrites` 列的最大长度（超出截断，避免一条请求写爆一列）。 */
const MAX_TRACE_LENGTH = 200;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * 路径校验：只允许标识符式段，禁止原型链污染与数组下标。
 *
 * 数组下标（`messages.0.role`）被刻意排除：一旦允许按下标改写，改写表就
 * 变成了「按位置猜请求结构」的脆弱脚本，上游一改顺序就静默改错东西。
 */
export function isSafePath(path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false;
  const segments = path.split('.');
  if (segments.length > MAX_PATH_DEPTH) return false;
  return segments.every(
    (segment) => /^[A-Za-z0-9_-]+$/.test(segment) && !FORBIDDEN_SEGMENTS.has(segment.toLowerCase()),
  );
}

function isScalar(value: unknown): value is RewriteScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** 头名规范化：HTTP 头大小写不敏感，统一小写便于比较与去重。 */
export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RewriteValidation {
  ok: boolean;
  /** 已归一化的配置（`ok` 为 true 时可用）。 */
  config: AccountRewriteConfig;
  /** 拒绝原因（中文，直接可回给管理员）。 */
  issues: string[];
}

/**
 * 校验并归一化改写配置。写入时调用（400 早失败），读路径假定已经合法。
 *
 * 归一化做三件事：头名小写、状态码键转数字串并校验 100–599、去掉空操作。
 */
export function validateRewriteConfig(raw: unknown): RewriteValidation {
  const issues: string[] = [];
  const config: AccountRewriteConfig = { enabled: false };

  if (raw === undefined || raw === null) return { ok: true, config, issues };
  if (!isRecord(raw)) {
    return { ok: false, config, issues: ['改写配置必须是对象'] };
  }

  if (typeof raw['enabled'] === 'boolean') config.enabled = raw['enabled'];
  else if (raw['enabled'] !== undefined) issues.push('enabled 必须是布尔值');

  const set = raw['set'];
  if (set !== undefined) {
    if (!isRecord(set)) {
      issues.push('set 必须是「路径 → 常量」对象');
    } else {
      const entries = Object.entries(set);
      if (entries.length > MAX_REWRITE_OPS) {
        issues.push(`set 最多 ${MAX_REWRITE_OPS} 条`);
      }
      const normalized: Record<string, RewriteScalar> = {};
      for (const [path, value] of entries) {
        if (!isSafePath(path)) {
          issues.push(
            `set 的路径不合法：${path}（最多 ${MAX_PATH_DEPTH} 层，仅字母数字下划线短横）`,
          );
          continue;
        }
        if (!isScalar(value)) {
          issues.push(`set.${path} 只支持字符串/数字/布尔/null`);
          continue;
        }
        normalized[path] = value;
      }
      if (Object.keys(normalized).length > 0) config.set = normalized;
    }
  }

  const unset = raw['unset'];
  if (unset !== undefined) {
    if (!Array.isArray(unset)) {
      issues.push('unset 必须是路径数组');
    } else {
      if (unset.length > MAX_REWRITE_OPS) issues.push(`unset 最多 ${MAX_REWRITE_OPS} 条`);
      const paths = unset.map((item) => (typeof item === 'string' ? item.trim() : ''));
      for (const path of paths) {
        if (!isSafePath(path)) issues.push(`unset 的路径不合法：${path || '(空)'}`);
      }
      const valid = paths.filter((path) => isSafePath(path));
      if (valid.length > 0) config.unset = valid;
    }
  }

  const rename = raw['rename'];
  if (rename !== undefined) {
    if (!isRecord(rename)) {
      issues.push('rename 必须是「旧路径 → 新路径」对象');
    } else {
      const entries = Object.entries(rename);
      if (entries.length > MAX_REWRITE_OPS) issues.push(`rename 最多 ${MAX_REWRITE_OPS} 条`);
      const normalized: Record<string, string> = {};
      for (const [from, to] of entries) {
        const target = typeof to === 'string' ? to.trim() : '';
        if (!isSafePath(from) || !isSafePath(target)) {
          issues.push(`rename 的路径不合法：${from} → ${target || '(空)'}`);
          continue;
        }
        if (from === target) {
          issues.push(`rename 新旧路径相同：${from}`);
          continue;
        }
        normalized[from] = target;
      }
      if (Object.keys(normalized).length > 0) config.rename = normalized;
    }
  }

  for (const field of ['setHeaders', 'unsetHeaders'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (field === 'setHeaders') {
      if (!isRecord(value)) {
        issues.push('setHeaders 必须是「头名 → 值」对象');
        continue;
      }
      const entries = Object.entries(value);
      if (entries.length > MAX_REWRITE_OPS) issues.push(`setHeaders 最多 ${MAX_REWRITE_OPS} 条`);
      const normalized: Record<string, string> = {};
      for (const [name, header] of entries) {
        if (!/^[A-Za-z0-9-]+$/.test(name.trim())) {
          issues.push(`头名不合法：${name}`);
          continue;
        }
        if (!isScalar(header) || header === null) {
          issues.push(`setHeaders.${name} 只能是字符串/数字/布尔`);
          continue;
        }
        normalized[normalizeHeaderName(name)] = String(header);
      }
      if (Object.keys(normalized).length > 0) config.setHeaders = normalized;
    } else {
      if (!Array.isArray(value)) {
        issues.push('unsetHeaders 必须是头名数组');
        continue;
      }
      if (value.length > MAX_REWRITE_OPS) issues.push(`unsetHeaders 最多 ${MAX_REWRITE_OPS} 条`);
      const names: string[] = [];
      for (const name of value) {
        if (typeof name !== 'string' || !/^[A-Za-z0-9-]+$/.test(name.trim())) {
          issues.push(`头名不合法：${typeof name === 'string' ? name : '(非字符串)'}`);
          continue;
        }
        names.push(normalizeHeaderName(name));
      }
      if (names.length > 0) config.unsetHeaders = names;
    }
  }

  const statusMap = raw['statusMap'];
  if (statusMap !== undefined) {
    if (!isRecord(statusMap)) {
      issues.push('statusMap 必须是「状态码 → 状态码」对象');
    } else {
      const entries = Object.entries(statusMap);
      if (entries.length > MAX_REWRITE_OPS) issues.push(`statusMap 最多 ${MAX_REWRITE_OPS} 条`);
      const normalized: Record<string, number> = {};
      for (const [from, to] of entries) {
        const fromCode = Number(from);
        const toCode = typeof to === 'number' ? to : Number(to);
        if (!Number.isInteger(fromCode) || fromCode < 100 || fromCode > 599) {
          issues.push(`statusMap 的源状态码不合法：${from}`);
          continue;
        }
        if (!Number.isInteger(toCode) || toCode < 100 || toCode > 599) {
          issues.push(`statusMap 的目标状态码不合法：${from} → ${String(to)}`);
          continue;
        }
        if (fromCode === toCode) continue;
        normalized[String(fromCode)] = toCode;
      }
      if (Object.keys(normalized).length > 0) config.statusMap = normalized;
    }
  }

  return { ok: issues.length === 0, config, issues };
}

/** 配置是否具备任何实际改写能力（`enabled` 之外还必须有操作）。 */
export function hasRewriteOps(config: AccountRewriteConfig | null | undefined): boolean {
  if (!config) return false;
  return Boolean(
    config.set ||
    config.unset?.length ||
    config.rename ||
    config.setHeaders ||
    config.unsetHeaders?.length ||
    config.statusMap,
  );
}

function readParent(
  root: Record<string, unknown>,
  path: string,
): { parent: Record<string, unknown>; leaf: string } | null {
  const segments = path.split('.');
  let node: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!isRecord(node)) return null;
    const next = node[segments[index] as string];
    // 中间层不是对象就放弃：我们不「修复」客户端的请求结构。
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[segments[index] as string] = created;
      node = created;
      continue;
    }
    if (!isRecord(next)) return null;
    node = next;
  }
  if (!isRecord(node)) return null;
  return { parent: node, leaf: segments[segments.length - 1] as string };
}

/**
 * 应用请求体改写。返回值是**新对象**（浅拷贝到改动层），不改调用方入参。
 *
 * 顺序固定为 `rename → unset → set`：先搬（用旧值满足新字段），再删（清掉
 * 上游不认的残留），最后写常量（常量优先级最高，人的显式配置压过上游回显）。
 */
export function applyBodyRewrites(
  body: unknown,
  config: AccountRewriteConfig | null | undefined,
): RewriteResult<unknown> {
  const applied: string[] = [];
  if (!config?.enabled || !isRecord(body)) return { value: body, applied };
  if (!hasRewriteOps(config)) return { value: body, applied };

  const clone: Record<string, unknown> = { ...body };

  for (const [from, to] of Object.entries(config.rename ?? {})) {
    const source = readParent(clone, from);
    if (!source || !(source.leaf in source.parent)) continue;
    const value = source.parent[source.leaf];
    delete source.parent[source.leaf];
    const target = readParent(clone, to);
    if (!target) continue;
    target.parent[target.leaf] = value;
    applied.push(`body.rename:${from}>${to}`);
  }

  for (const path of config.unset ?? []) {
    const target = readParent(clone, path);
    if (!target || !(target.leaf in target.parent)) continue;
    delete target.parent[target.leaf];
    applied.push(`body.unset:${path}`);
  }

  for (const [path, value] of Object.entries(config.set ?? {})) {
    const target = readParent(clone, path);
    if (!target) continue;
    if (target.parent[target.leaf] === value) continue;
    target.parent[target.leaf] = value;
    applied.push(`body.set:${path}`);
  }

  return { value: applied.length > 0 ? clone : body, applied };
}

/**
 * 应用请求头改写。头名大小写不敏感，所以先平铺成小写键再重建。
 *
 * 刻意不允许改写这些头：鉴权与协议完整性由 adaptor 掌握，改写它们等于
 * 让配置绕过我们的凭证注入与流式契约。
 */
const HEADER_REWRITE_DENYLIST = new Set([
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
  'content-encoding',
]);

export function applyHeaderRewrites(
  headers: Record<string, string>,
  config: AccountRewriteConfig | null | undefined,
): RewriteResult<Record<string, string>> {
  const applied: string[] = [];
  if (!config?.enabled) return { value: headers, applied };
  if (!config.setHeaders && !config.unsetHeaders?.length) return { value: headers, applied };

  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[normalizeHeaderName(name)] = value;

  for (const name of config.unsetHeaders ?? []) {
    if (!(name in lower)) continue;
    if (HEADER_REWRITE_DENYLIST.has(name)) {
      applied.push(`header.skip-unset:${name}`);
      continue;
    }
    delete lower[name];
    applied.push(`header.unset:${name}`);
  }

  for (const [name, value] of Object.entries(config.setHeaders ?? {})) {
    if (HEADER_REWRITE_DENYLIST.has(name)) {
      applied.push(`header.skip-set:${name}`);
      continue;
    }
    if (lower[name] === value) continue;
    lower[name] = value;
    applied.push(`header.set:${name}`);
  }

  return { value: applied.length > 0 ? lower : headers, applied };
}

/** 上游状态码 → 对外状态码。命中时返回改写痕迹，未命中返回 null。 */
export function mapStatus(
  status: number,
  config: AccountRewriteConfig | null | undefined,
): { status: number; trace: string } | null {
  if (!config?.enabled) return null;
  const mapped = config.statusMap?.[String(status)];
  if (mapped === undefined || mapped === status) return null;
  return { status: mapped, trace: `status.${status}>${mapped}` };
}

/** 把改写痕迹压成一行：长度受控，空的返回空串。 */
export function traceOf(applied: readonly string[]): string {
  const joined = applied.filter(Boolean).join(',');
  if (joined.length <= MAX_TRACE_LENGTH) return joined;
  return `${joined.slice(0, MAX_TRACE_LENGTH - 1)}…`;
}

/**
 * 从账号行里取出改写配置。写路径已校验过，这里只做轻量门禁：
 * 不是对象、或 `enabled !== true`，一律返回 null（**默认关闭**）。
 */
export function rewriteConfigOf(raw: unknown): AccountRewriteConfig | null {
  if (!isRecord(raw)) return null;
  if (raw['enabled'] !== true) return null;
  return raw as unknown as AccountRewriteConfig;
}
