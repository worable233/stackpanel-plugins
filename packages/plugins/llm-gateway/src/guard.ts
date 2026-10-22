import { isPublicHttpUrl } from '@stackpanel/net-guard';

/** 生产环境启用上游 SSRF 防护（审计 M-2）。延迟读取，便于测试切换。 */
export function upstreamGuardEnabled(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * 上游地址是否可接受：生产要求为公网地址；开发/测试保留本机上游，便于用本地
 * mock 联调。
 */
export function isAllowedUpstreamUrl(value: string): boolean {
  return !upstreamGuardEnabled() || isPublicHttpUrl(value, { allowHttp: true });
}
