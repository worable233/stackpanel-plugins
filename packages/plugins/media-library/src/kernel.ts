/**
 * Kernel media bridge.
 *
 * Attachments are a kernel-owned domain (ADR-0014 §2): the plugin must never
 * touch the attachments table, the storage driver or the image policy itself.
 * Its routes therefore forward to the kernel's own media endpoints **with the
 * caller's session token**, which keeps exactly one authorization path — the
 * console can never do more than the admin who opened it, and no new privileged
 * capability has to be handed to plugins.
 *
 * The hop is loopback (the plugin process lives next to the kernel), so it costs
 * a socket round-trip and buys strict ownership boundaries.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** A failure that must reach the browser as-is (status + code preserved). */
export class MediaLibraryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MediaLibraryError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Loopback origin of the kernel API.
 *
 * `API_BASE_URL` is the *public* origin and may point at a reverse proxy or a
 * TLS terminator that is not reachable from inside the deployment; the plugin
 * runs in the same process tree as the API, so `API_HOST`:`API_PORT` is the
 * correct target. `STACKPANEL_INTERNAL_API_URL` overrides both for exotic
 * topologies (e.g. a sidecar network).
 */
export function kernelBaseUrl(): string {
  const explicit = process.env['STACKPANEL_INTERNAL_API_URL']?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = process.env['API_HOST']?.trim() || '127.0.0.1';
  const port = process.env['API_PORT']?.trim() || '3001';
  // A wildcard bind is not a reachable address.
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${target}:${port}`;
}

/** Route auth already guarantees a session; this keeps the failure explicit. */
export function requireSessionToken(sessionToken: string | undefined): string {
  if (!sessionToken) {
    throw new MediaLibraryError(401, 'mediaLibrary.unauthenticated', '未登录或会话已过期');
  }
  return sessionToken;
}

export interface KernelRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: URLSearchParams;
  body?: unknown;
  sessionToken?: string;
}

/** Issue a kernel request and translate failures into user-facing errors. */
export async function kernelFetch(
  path: string,
  options: KernelRequestOptions = {},
): Promise<Response> {
  const url = new URL(path, `${kernelBaseUrl()}/`);
  if (options.query) url.search = options.query.toString();

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.sessionToken) headers['authorization'] = `Bearer ${options.sessionToken}`;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MediaLibraryError(
      502,
      'mediaLibrary.kernelUnreachable',
      `无法连接内核：${(error as Error).message}`,
    );
  }

  if (!response.ok) throw await toUpstreamError(response);
  return response;
}

/** Same as {@link kernelFetch} but parses the JSON body. */
export async function kernelJson<T>(path: string, options: KernelRequestOptions = {}): Promise<T> {
  const response = await kernelFetch(path, options);
  return (await response.json()) as T;
}

async function toUpstreamError(response: Response): Promise<MediaLibraryError> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  return new MediaLibraryError(
    response.status,
    payload?.code ?? 'mediaLibrary.upstreamFailed',
    payload?.error ?? `内核返回 ${response.status}`,
  );
}
