import type {
  HttpReply,
  HttpRequest,
  PluginRoute,
  RawHttpReply,
  RawHttpRequest,
} from '@stackpanel/sdk';
import { kernelFetch, kernelJson, MediaLibraryError, requireSessionToken } from './kernel.js';
import {
  listQuerySchema,
  optimizeBodySchema,
  patchBodySchema,
  rebuildBodySchema,
} from './schemas.js';

/**
 * Admin consent: these routes are the console's whole surface, so they all
 * require an ADMIN session (`platform.admin`). The kernel still re-checks the
 * forwarded token on every call, which is what makes the bridge safe — a plugin
 * bug cannot widen the caller's authority.
 */
const ADMIN_ROUTE = { auth: 'admin', permission: 'platform.admin' } as const;

/** Upstream headers worth passing through to the browser for media previews. */
const FORWARDED_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'content-security-policy',
  'cache-control',
  'etag',
  'last-modified',
]);

function invalidParams(message = '参数无效'): MediaLibraryError {
  return new MediaLibraryError(400, 'mediaLibrary.invalidParams', message);
}

function attachmentId(params: Record<string, string>): string {
  const id = params['id']?.trim();
  if (!id) throw invalidParams('缺少附件 id');
  return id;
}

/** Uniform error → response mapping for JSON handlers. */
function guarded<Result>(
  handler: (request: HttpRequest) => Promise<Result>,
): (request: HttpRequest, reply: HttpReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof MediaLibraryError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  };
}

export function createRoutes(): PluginRoute[] {
  return [
    {
      ...ADMIN_ROUTE,
      method: 'GET',
      path: '/media-library/items',
      handler: guarded(async (request) => {
        const parsed = listQuerySchema.safeParse(request.query);
        if (!parsed.success) throw invalidParams();
        const token = requireSessionToken(request.sessionToken);

        const query = new URLSearchParams({
          page: String(parsed.data.page),
          pageSize: String(parsed.data.pageSize),
        });
        for (const key of ['visibility', 'kind', 'q', 'ownerId'] as const) {
          const value = parsed.data[key];
          if (value) query.set(key, value);
        }
        return kernelJson('/media/admin/attachments', { query, sessionToken: token });
      }),
    },
    {
      ...ADMIN_ROUTE,
      method: 'GET',
      path: '/media-library/stats',
      handler: guarded(async (request) =>
        kernelJson('/media/admin/stats', {
          sessionToken: requireSessionToken(request.sessionToken),
        }),
      ),
    },
    {
      ...ADMIN_ROUTE,
      method: 'PATCH',
      path: '/media-library/items/:id',
      handler: guarded(async (request) => {
        const parsed = patchBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) throw invalidParams(parsed.error.issues[0]?.message);
        return kernelJson(`/media/${encodeURIComponent(attachmentId(request.params))}`, {
          method: 'PATCH',
          body: parsed.data,
          sessionToken: requireSessionToken(request.sessionToken),
        });
      }),
    },
    {
      ...ADMIN_ROUTE,
      method: 'DELETE',
      path: '/media-library/items/:id',
      handler: guarded(async (request) =>
        kernelJson(`/media/${encodeURIComponent(attachmentId(request.params))}`, {
          method: 'DELETE',
          sessionToken: requireSessionToken(request.sessionToken),
        }),
      ),
    },
    {
      ...ADMIN_ROUTE,
      method: 'POST',
      path: '/media-library/variants/rebuild',
      handler: guarded(async (request) => {
        const parsed = rebuildBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) throw invalidParams();
        return kernelJson('/media/admin/variants/rebuild', {
          method: 'POST',
          body: parsed.data,
          sessionToken: requireSessionToken(request.sessionToken),
        });
      }),
    },
    {
      ...ADMIN_ROUTE,
      method: 'POST',
      path: '/media-library/optimize',
      handler: guarded(async (request) => {
        const parsed = optimizeBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) throw invalidParams();
        return kernelJson('/media/admin/optimize', {
          method: 'POST',
          body: parsed.data,
          sessionToken: requireSessionToken(request.sessionToken),
        });
      }),
    },
    {
      ...ADMIN_ROUTE,
      kind: 'raw',
      method: 'GET',
      // The browser only reaches plugin paths, so thumbnails have to be proxied
      // here instead of pointing <img> at the kernel's /media/:id/content.
      path: '/media-library/items/:id/content',
      handler: proxyContent,
    },
  ];
}
/**
 * Stream an attachment (or one of its variants) to the browser.
 *
 * Raw + streaming rather than buffering: a 20 MiB original must not become a
 * 20 MiB heap allocation inside both the plugin process and the kernel. The
 * kernel has already applied its visibility/ownership rules and its CSP for
 * active content, so the only job here is a faithful byte-for-byte relay.
 */
async function proxyContent(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  try {
    const id = request.params['id']?.trim();
    if (!id) throw invalidParams('缺少附件 id');

    const query = new URLSearchParams();
    const variant = request.query.get('variant');
    if (variant) query.set('variant', variant);
    // Content revision: forwarded so the kernel can upgrade this response to
    // `immutable` caching. A missing or stale value is not an identity check —
    // the kernel still answers with the current bytes under the same link.
    const revision = request.query.get('v');
    if (revision) query.set('v', revision);

    const upstream = await kernelFetch(`/media/${encodeURIComponent(id)}/content`, {
      query,
      sessionToken: requireSessionToken(request.sessionToken),
    });

    reply.status(upstream.status);
    for (const [name, value] of upstream.headers) {
      if (FORWARDED_HEADERS.has(name.toLowerCase())) reply.header(name, value);
    }
    if (!upstream.body) {
      reply.end();
      return;
    }

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (!reply.write(value)) await reply.drain();
    }
    reply.end();
  } catch (error) {
    if (error instanceof MediaLibraryError) {
      reply
        .status(error.status)
        .header('content-type', 'application/json; charset=utf-8')
        .end(JSON.stringify({ error: error.message, code: error.code }));
      return;
    }
    throw error;
  }
}
