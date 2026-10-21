/**
 * AWS SigV4 签名（Bedrock 用）。
 *
 * 目标三要求 Bedrock 支持。Bedrock 的鉴权不是静态 API key，而是 SigV4：
 * 用 access key / secret key 对「方法 + 路径 + 查询 + 头 + body 哈希」做
 * HMAC-SHA256 链式派生。这里的实现只覆盖 Bedrock Runtime 需要的部分：
 * `POST` + `application/json` + `bedrock` service + 单 region。
 *
 * 刻意手写而非引入 `@aws-sdk/*`：插件包不能因为支持一个 provider 就把整个
 * AWS SDK 拖进 bundle（当前 bundle 是 esbuild 单文件）。算法本身稳定，30 行够用。
 */

import { createHash, createHmac } from 'node:crypto';
import type { AdaptorAccount } from './types.js';
import { registerBedrockSigner } from './anthropic.js';

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** 从账号 options 读取 AWS 凭证。 */
function credentialsOf(account: AdaptorAccount): AwsCredentials | null {
  const accessKeyId = account.options['accessKeyId'];
  const secretAccessKey = account.options['secretAccessKey'];
  if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
    // 允许把一对 key 写在同一字段里（管理端表单更简单）：`AKIA…:secret…`
    const combined = account.apiKey;
    const sep = combined.indexOf(':');
    if (sep > 0) {
      return {
        accessKeyId: combined.slice(0, sep),
        secretAccessKey: combined.slice(sep + 1),
      };
    }
    return null;
  }
  const sessionToken = account.options['sessionToken'];
  return {
    accessKeyId,
    secretAccessKey,
    ...(typeof sessionToken === 'string' && sessionToken.length > 0 ? { sessionToken } : {}),
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** RFC3986 编码（SigV4 要求，与 encodeURIComponent 有差异）。 */
function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += char;
    } else {
      out += [...Buffer.from(char, 'utf8')]
        .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('');
    }
  }
  return out;
}

/**
 * 生成 SigV4 头。返回需要合并进请求的头（含 `authorization`）。
 */
export function signAwsRequest(
  credentials: AwsCredentials,
  input: {
    method: string;
    /** 完整 URL。 */
    url: string;
    /** 参与签名的头（会补 `host` 与 `x-amz-date`）。 */
    headers: Record<string, string>;
    body: string;
    service: string;
    region: string;
    now?: Date;
  },
): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = `${now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '')
    .slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(input.body);
  const canonicalUri =
    url.pathname
      .split('/')
      .map((segment) => uriEncode(segment, false))
      .join('/') || '/';

  // 查询串按 key 排序后重新编码。
  const queryPairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => queryPairs.push([key, value]));
  queryPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = queryPairs
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');

  const signedHeaders: Record<string, string> = {
    ...input.headers,
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken) {
    signedHeaders['x-amz-security-token'] = credentials.sessionToken;
  }

  const headerNames = Object.keys(signedHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = headerNames
    .map((name) => {
      const value =
        signedHeaders[name] ??
        signedHeaders[Object.keys(signedHeaders).find((k) => k.toLowerCase() === name) ?? ''] ??
        '';
      return `${name}:${String(value).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaderList = headerNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
    '\n',
  );

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...signedHeaders,
    authorization: `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  };
}

/** 注册 Bedrock 签名器（模块加载时执行一次）。 */
export function installAwsSigner(): void {
  registerBedrockSigner(async (account, call) => {
    const credentials = credentialsOf(account);
    if (!credentials) {
      // 交给调用方转成 GatewayError；这里只拒绝签名。
      throw new Error('Bedrock 账号缺少 AWS 凭证（accessKeyId/secretAccessKey）');
    }
    const region =
      typeof account.options['region'] === 'string' && account.options['region'].length > 0
        ? account.options['region']
        : 'us-east-1';
    return signAwsRequest(credentials, {
      method: call.method,
      url: call.url,
      headers: call.headers,
      body: call.body,
      service: 'bedrock',
      region,
    });
  });
}

installAwsSigner();
