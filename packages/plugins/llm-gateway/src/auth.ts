/**
 * 鉴权模块（目标一 authentication）。
 *
 * 把「明文 key → 归一化 GatewayKey」这段从旧 gateway.ts 里独立出来：它同时
 * 覆盖内核平台凭证（ApiToken + 插件 key-policy）与 P0.6 迁移前的历史密钥表，
 * 是唯一需要同时认识两种来源的地方。
 *
 * 错误一律返回**稳定 code**（errors.ts 的 GatewayErrorCode），不返回中文文案，
 * 由 relay 统一转成 OpenAI 兼容错误体。
 */

import { GATEWAY_SCOPE, hashKey, toStringArray } from './keys.js';
import { getLegacyByHash, getPolicy } from './repository.js';
import type { GatewayKey, GatewayRuntime } from './runtime.js';

/** 鉴权失败的结构化结果。 */
export interface AuthDenial {
  ok: false;
  status: number;
  code:
    | 'invalid_api_key'
    | 'key_expired'
    | 'insufficient_scope'
    | 'ip_not_allowed'
    | 'permission_revoked';
  message: string;
}

export type AuthResult = { ok: true; key: GatewayKey } | AuthDenial;

function deny(status: number, code: AuthDenial['code'], message: string): AuthDenial {
  return { ok: false, status, code, message };
}

/**
 * 解析明文凭证。
 *
 * 顺序刻意如此：先问内核（平台凭证是唯一真源），失败再兜底查历史表。反过来会
 * 让一把已迁移的 key 继续走旧路径，绕过内核的 IP 白名单与权限变更。
 */
export async function resolveGatewayKey(
  rt: GatewayRuntime,
  plaintext: string,
  clientIp: string | undefined,
): Promise<AuthResult> {
  const inspection = await rt.auth.inspectPlatformToken(plaintext, clientIp).catch(() => null);

  if (inspection) {
    const token = inspection.token;
    if (!inspection.active) return deny(401, 'invalid_api_key', 'API key 无效或已停用');
    if (inspection.expired) return deny(403, 'key_expired', 'API key 已过期');
    if (!token.scopes.includes(GATEWAY_SCOPE)) {
      return deny(403, 'insufficient_scope', '该密钥未授予 模型服务权限');
    }
    if (!inspection.ipAllowed) {
      return deny(403, 'ip_not_allowed', '请求来源 IP 不在白名单内');
    }
    if (!(await rt.auth.hasPermission(token.userId, GATEWAY_SCOPE).catch(() => false))) {
      return deny(403, 'permission_revoked', '当前账号已无权使用 模型服务');
    }
    const policy = await getPolicy(token.id).catch(() => null);
    return {
      ok: true,
      key: {
        id: token.id,
        userId: token.userId,
        name: token.name,
        status: token.status,
        models: toStringArray(policy?.models),
        rpmLimit: policy?.rpmLimit ?? 0,
        concurrencyLimit: policy?.concurrencyLimit ?? 0,
        quotaLimit: policy?.quotaLimit ?? null,
        quotaUsed: policy?.quotaUsed ?? 0,
        quotaWindowHours: policy?.quotaWindowHours ?? 0,
        quotaMaxRequests: policy?.quotaMaxRequests ?? 0,
        quotaMaxTokens: policy?.quotaMaxTokens ?? 0,
        expiresAt: token.expiresAt,
        source: 'token',
      },
    };
  }

  // 双读兜底：P0.6 迁移前的历史密钥。
  const legacy = await getLegacyByHash(hashKey(plaintext)).catch(() => null);
  if (!legacy) return deny(401, 'invalid_api_key', 'API key 无效或已停用');
  if (legacy.status !== 'ACTIVE') {
    return deny(401, 'invalid_api_key', 'API key 无效或已停用');
  }
  if (legacy.expiresAt && new Date(legacy.expiresAt).getTime() <= Date.now()) {
    return deny(403, 'key_expired', 'API key 已过期');
  }
  if (!(await rt.auth.hasPermission(legacy.userId, GATEWAY_SCOPE).catch(() => false))) {
    return deny(403, 'permission_revoked', '当前账号已无权使用 模型服务');
  }
  return {
    ok: true,
    key: {
      id: legacy.id,
      userId: legacy.userId,
      name: legacy.name,
      status: legacy.status,
      models: toStringArray(legacy.models),
      rpmLimit: legacy.rpmLimit,
      concurrencyLimit: legacy.concurrencyLimit,
      quotaLimit: legacy.quotaLimit ?? null,
      quotaUsed: legacy.quotaUsed,
      quotaWindowHours: legacy.quotaWindowHours ?? 0,
      quotaMaxRequests: legacy.quotaMaxRequests ?? 0,
      quotaMaxTokens: legacy.quotaMaxTokens ?? 0,
      expiresAt: legacy.expiresAt ?? null,
      source: 'legacy',
    },
  };
}
