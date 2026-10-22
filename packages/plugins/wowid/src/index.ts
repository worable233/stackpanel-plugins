import { EXTENSION_POINTS, definePlugin } from '@stackpanel/sdk';
import type { AuthIdentity, AuthProvider, PluginContext } from '@stackpanel/sdk';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Mock authorization code accepted only when WOWID_MOCK=true. */
const MOCK_CODE = 'wowid_mock';
const REQUEST_TIMEOUT_MS = 10_000;

interface WowIdConfig {
  mock: boolean;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  jwksUrl: string;
  redirectUri: string;
}

interface WowIdCredential {
  code?: unknown;
  codeVerifier?: unknown;
  nonce?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
}

/**
 * The live integration is intentionally explicit. A production deployment
 * must set WOWID_ISSUER and register the exact redirect URI in Wow ID.
 */
export function wowidConfig(): WowIdConfig | null {
  const mock = (process.env['WOWID_MOCK'] ?? 'false') === 'true';
  const redirectUri =
    process.env['WOWID_REDIRECT_URI'] ?? 'http://127.0.0.1:3000/auth/oauth/wowid/callback';
  if (mock) {
    return {
      mock,
      issuer: 'https://wowid.mock',
      clientId: process.env['WOWID_CLIENT_ID'] ?? 'stackpanel',
      authorizeUrl: redirectUri,
      tokenUrl: 'https://wowid.mock/oauth/token',
      userinfoUrl: 'https://wowid.mock/oauth/userinfo',
      jwksUrl: 'https://wowid.mock/oauth/jwks',
      redirectUri,
    };
  }

  const issuer = canonicalUrl(process.env['WOWID_ISSUER']);
  const clientId = process.env['WOWID_CLIENT_ID'];
  const authorizeUrl = endpoint(process.env['WOWID_AUTHORIZE_URL'], issuer, '/oauth/authorize');
  const tokenUrl = endpoint(process.env['WOWID_TOKEN_URL'], issuer, '/oauth/token');
  const userinfoUrl = endpoint(process.env['WOWID_USERINFO_URL'], issuer, '/oauth/userinfo');
  const jwksUrl = endpoint(process.env['WOWID_JWKS_URL'], issuer, '/oauth/jwks');
  if (
    !issuer ||
    !clientId ||
    !validRedirectUri(redirectUri) ||
    !authorizeUrl ||
    !tokenUrl ||
    !userinfoUrl ||
    !jwksUrl ||
    (process.env['NODE_ENV'] === 'production' &&
      [issuer, authorizeUrl, tokenUrl, userinfoUrl, jwksUrl].some(
        (url) => new URL(url).protocol !== 'https:',
      ))
  ) {
    return null;
  }
  return {
    mock,
    issuer,
    clientId,
    ...(process.env['WOWID_CLIENT_SECRET']
      ? { clientSecret: process.env['WOWID_CLIENT_SECRET'] }
      : {}),
    authorizeUrl,
    tokenUrl,
    userinfoUrl,
    jwksUrl,
    redirectUri,
  };
}

function canonicalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function endpoint(
  override: string | undefined,
  issuer: string | null,
  path: string,
): string | null {
  if (override !== undefined && override !== '') return canonicalUrl(override);
  return issuer ? `${issuer}${path}` : null;
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (process.env['NODE_ENV'] === 'production') return url.protocol === 'https:';
    return (
      url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    );
  } catch {
    return false;
  }
}

function validCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null;
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function exchangeCode(
  credential: WowIdCredential,
  config: WowIdConfig,
  jwks: JWTVerifyGetKey,
): Promise<AuthIdentity | null> {
  if (!validCodeVerifier(credential.codeVerifier) || !validNonce(credential.nonce)) return null;
  if (typeof credential.code !== 'string' || credential.code.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        ...(config.clientSecret
          ? {
              authorization: `Basic ${Buffer.from(
                `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
              ).toString('base64')}`,
            }
          : {}),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: credential.code,
        code_verifier: credential.codeVerifier,
        redirect_uri: config.redirectUri,
        ...(config.clientSecret ? {} : { client_id: config.clientId }),
      }),
      signal: controller.signal,
    });
    const tokens = (await jsonResponse(response)) as TokenResponse | null;
    if (
      !tokens ||
      tokens.token_type !== 'Bearer' ||
      typeof tokens.access_token !== 'string' ||
      typeof tokens.id_token !== 'string'
    ) {
      return null;
    }

    const verified = await jwtVerify(tokens.id_token, jwks, {
      audience: config.clientId,
      issuer: config.issuer,
    }).catch(() => null);
    if (
      !verified ||
      verified.payload.token_use !== 'id_token' ||
      verified.payload.nonce !== credential.nonce ||
      typeof verified.payload.sub !== 'string'
    ) {
      return null;
    }

    const userinfoResponse = await fetch(config.userinfoUrl, {
      headers: { accept: 'application/json', authorization: `Bearer ${tokens.access_token}` },
      redirect: 'error',
      signal: controller.signal,
    });
    const claims = await jsonResponse(userinfoResponse);
    if (!claims || claims['sub'] !== verified.payload.sub) return null;
    return {
      externalId: verified.payload.sub,
      ...(typeof claims['email'] === 'string' ? { email: claims['email'] } : {}),
      ...(typeof claims['name'] === 'string'
        ? { displayName: claims['name'] }
        : typeof claims['preferred_username'] === 'string'
          ? { displayName: claims['preferred_username'] }
          : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function wowidProvider(config: WowIdConfig): AuthProvider {
  const jwks = config.mock ? null : createRemoteJWKSet(new URL(config.jwksUrl));
  return {
    id: 'wowid',
    name: 'Wow ID',

    authorizeUrl(state, options) {
      if (config.mock) {
        const url = new URL(config.redirectUri);
        url.searchParams.set('code', MOCK_CODE);
        url.searchParams.set('state', state);
        return url.toString();
      }
      if (!options?.codeChallenge || !options.nonce) return undefined;
      const url = new URL(config.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', 'openid profile email');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', options.nonce);
      url.searchParams.set('code_challenge', options.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },

    async authenticate(credential: unknown): Promise<AuthIdentity | null> {
      const parsed = credential as WowIdCredential;
      if (config.mock) {
        if (parsed.code !== MOCK_CODE) return null;
        return {
          externalId: 'wowid_demo_user',
          email: 'demo@wowid.example',
          displayName: 'WowID Demo',
        };
      }
      if (!jwks) return null;
      return exchangeCode(parsed, config, jwks);
    },
  };
}

export const wowidPlugin = definePlugin({
  manifest: {
    id: 'wowid',
    name: 'WowID 登录',
    version: '0.1.0',
    description: '符合标准的 WowID OpenID Connect 第三方认证提供商。',
    provides: [EXTENSION_POINTS.authProvider],
  },
  onActivate: (ctx: PluginContext) => {
    const config = wowidConfig();
    if (!config) {
      ctx.logger.warn('wowid: disabled because OIDC configuration is incomplete');
      return;
    }
    ctx.registerExtension<AuthProvider>(EXTENSION_POINTS.authProvider, wowidProvider(config));
    ctx.logger.info(`wowid: activated for ${config.issuer}`);
  },
  onDeactivate: (ctx) => ctx.logger.info('wowid: deactivated'),
});

export default wowidPlugin;
