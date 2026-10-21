import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * 网关凭证工具。
 *
 * P0.6 起，网关密钥归并到内核平台凭证 `ApiToken`：明文、哈希、前缀与内核
 * `apps/api/src/lib/api-tokens.ts` 完全一致，插件只负责策略层（`GatewayKeyPolicy`）。
 * 明文格式：`${prefix}${base64url(24 bytes)}`，同一枚凭证在内核开放 API 与网关之间通用。
 */

/** 网关调用所需 scope；同时是网关的权限键。 */
export const GATEWAY_SCOPE = 'llm-gateway.use';

/** 与内核同源：读取 `STACKPANEL_API_TOKEN_PREFIX`，默认 `sp_`。 */
export function apiTokenPrefix(): string {
  return process.env['STACKPANEL_API_TOKEN_PREFIX'] ?? 'sp_';
}

export interface GeneratedApiToken {
  /** 明文凭证；只在创建时返回一次，不入库。 */
  plaintext: string;
  /** sha256(明文)，用于查找。 */
  keyHash: string;
  /** 展示用打码前缀。 */
  keyPrefix: string;
}

/** 生成一枚平台凭证（与内核 `generateApiToken` 同构）。 */
export function generateApiToken(): GeneratedApiToken {
  const plaintext = `${apiTokenPrefix()}${randomBytes(24).toString('base64url')}`;
  return {
    plaintext,
    keyHash: hashKey(plaintext),
    keyPrefix: `${plaintext.slice(0, 12)}…`,
  };
}

/** 计算凭证哈希（高熵随机串，sha256 即可）。 */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** 稳定的资源 id（用于账号行，先于 secret 写入需要它）。 */
export function newId(): string {
  return randomUUID();
}

/* ------------------------------ IP 白名单匹配 ------------------------------ */

/** 将 IPv4 解析成 32 位整数；失败返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** 将 IPv6 解析成 128 位 BigInt；失败返回 null。 */
function ipv6ToBigInt(ip: string): bigint | null {
  const text = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (text.length === 0 || !text.includes(':')) return null;
  const dbl = text.indexOf('::');
  let head: string[];
  let tail: string[];
  if (dbl >= 0) {
    head = text
      .slice(0, dbl)
      .split(':')
      .filter((s) => s.length > 0);
    tail = text
      .slice(dbl + 2)
      .split(':')
      .filter((s) => s.length > 0);
  } else {
    head = text.split(':');
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** 单个 allowlist 条目是否匹配客户端 IP（支持单 IP 与 CIDR，v4/v6）。 */
function entryMatches(entry: string, ip: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === ip) return true;
  const slash = trimmed.indexOf('/');
  if (slash < 0) return false;
  const network = trimmed.slice(0, slash);
  const bits = Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(bits)) return false;
  const v4 = ipv4ToInt(network);
  const v4ip = ipv4ToInt(ip);
  if (v4 !== null && v4ip !== null) {
    if (bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (v4ip & mask) === (v4 & mask);
  }
  const v6 = ipv6ToBigInt(network);
  const v6ip = ipv6ToBigInt(ip);
  if (v6 !== null && v6ip !== null) {
    if (bits < 0 || bits > 128) return false;
    if (bits === 0) return true;
    const shift = 128n - BigInt(bits);
    return v6ip >> shift === v6 >> shift;
  }
  return false;
}

/** 宽松地把 Json 字段读成 string[]。 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 客户端 IP 是否被 allowlist 允许；空列表表示不限制。 */
export function ipAllowed(allowlist: unknown, ip: string | undefined): boolean {
  const list = toStringArray(allowlist);
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((entry) => entryMatches(entry, ip));
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * 从请求头里取用户凭证：
 * 优先 `Authorization: Bearer …`，其次 `x-api-key`（Anthropic），再 `x-goog-api-key`（Gemini）。
 */
export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const auth = firstHeader(headers['authorization']);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1]?.trim() ?? null;
  }
  const apiKey = firstHeader(headers['x-api-key']);
  if (apiKey) return apiKey.trim();
  const googleKey = firstHeader(headers['x-goog-api-key']);
  return googleKey ? googleKey.trim() : null;
}
