import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpReply, HttpRequest, RawHttpReply, RawHttpRequest } from '@stackpanel/sdk';
import { createRoutes } from './routes.js';

/**
 * The bridge is the only trust boundary in this plugin: it must forward the
 * caller's token (never a service credential), map kernel failures faithfully,
 * and refuse to answer without a session.
 */
/** `PluginRoute.handler` is a union with the raw streaming variant; the bridge
 * tests only exercise the plain one, so resolve it to that signature once. */
type PlainHandler = (request: HttpRequest, reply: HttpReply) => unknown;

function route(method: string, path: string): { handler: PlainHandler } {
  const found = createRoutes().find((item) => item.method === method && item.path === path);
  if (!found || found.kind === 'raw') throw new Error(`route not found: ${method} ${path}`);
  return { handler: found.handler as PlainHandler };
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    sessionToken: 'sess_test',
    ...overrides,
  } as HttpRequest;
}

/** Same as {@link request}, minus the session: `exactOptionalPropertyTypes`
 * forbids passing `undefined` explicitly for an optional string. */
function anonymous(): HttpRequest {
  const value = { ...request() } as { sessionToken?: string };
  delete value.sessionToken;
  return value as HttpRequest;
}

function reply(): HttpReply & { statusCode: number; payload: unknown } {
  const state = {
    statusCode: 200,
    payload: undefined as unknown,
    code(status: number) {
      state.statusCode = status;
      return state;
    },
    send(payload?: unknown) {
      state.payload = payload;
    },
  };
  return state as unknown as HttpReply & { statusCode: number; payload: unknown };
}

/** Minimal `RawHttpReply` that records what the streaming proxy wrote. */
function rawReply(): {
  state: { status: number; headers: Record<string, string>; chunks: Uint8Array[]; ended: boolean };
  reply: RawHttpReply;
} {
  const state = {
    status: 200,
    headers: {} as Record<string, string>,
    chunks: [] as Uint8Array[],
    ended: false,
  };
  const fake = {
    status(code: number) {
      state.status = code;
      return fake;
    },
    header(name: string, value: string | string[]) {
      state.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      return fake;
    },
    write(chunk: string | Uint8Array) {
      state.chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      return true;
    },
    async drain() {
      return undefined;
    },
    end(body?: string | Uint8Array) {
      if (body !== undefined) fake.write(body);
      state.ended = true;
    },
  };
  return { state, reply: fake as unknown as RawHttpReply };
}

interface Call {
  url: string;
  init: RequestInit;
}

const calls: Call[] = [];

function stubKernel(handler: (url: string) => { status?: number; body: unknown }): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const result = handler(url);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('media-library bridge routes', () => {
  it('forwards list filters and the caller session token', async () => {
    stubKernel(() => ({ body: { items: [], total: 0, page: 2, pageSize: 5 } }));
    const result = await route('GET', '/media-library/items').handler(
      request({ query: { page: '2', pageSize: '5', kind: 'image', q: ' logo ' } }),
      reply(),
    );
    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 5 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/media/admin/attachments');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('5');
    expect(url.searchParams.get('kind')).toBe('image');
    expect(url.searchParams.get('q')).toBe('logo');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sess_test');
  });

  it('rejects an invalid facet instead of forwarding it', async () => {
    stubKernel(() => ({ body: {} }));
    const response = reply();
    await route('GET', '/media-library/items').handler(
      request({ query: { kind: 'nope' } }),
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses to call the kernel without a session token', async () => {
    stubKernel(() => ({ body: {} }));
    const response = reply();
    await route('GET', '/media-library/stats').handler(anonymous(), response);
    expect(response.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('keeps the kernel status and message for a reference-guarded delete', async () => {
    stubKernel(() => ({
      status: 409,
      body: { error: '附件仍被内容引用，无法删除', code: 'media.in_use' },
    }));
    const response = reply();
    await route('DELETE', '/media-library/items/:id').handler(
      request({ params: { id: 'att_1' } }),
      response,
    );
    expect(response.statusCode).toBe(409);
    expect(response.payload).toEqual({
      error: '附件仍被内容引用，无法删除',
      code: 'media.in_use',
    });
    expect((calls[0]?.init as RequestInit).method).toBe('DELETE');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/media/att_1');
  });

  it('forwards a visibility patch as-is', async () => {
    stubKernel(() => ({ body: { attachment: { id: 'att_1', visibility: 'public' } } }));
    await route('PATCH', '/media-library/items/:id').handler(
      request({ params: { id: 'att_1' }, body: { visibility: 'public' } }),
      reply(),
    );
    expect(JSON.parse(String((calls[0]?.init as RequestInit).body))).toEqual({
      visibility: 'public',
    });
  });

  it('requires at least one field on patch', async () => {
    stubKernel(() => ({ body: {} }));
    const response = reply();
    await route('PATCH', '/media-library/items/:id').handler(
      request({ params: { id: 'att_1' }, body: {} }),
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('targets the whole library when rebuild has no attachment id', async () => {
    stubKernel(() => ({ body: { requeued: 3, ids: ['a', 'b', 'c'] } }));
    const result = await route('POST', '/media-library/variants/rebuild').handler(
      request({ body: {} }),
      reply(),
    );
    expect(result).toEqual({ requeued: 3, ids: ['a', 'b', 'c'] });
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/media/admin/variants/rebuild');
  });

  it('forwards the WebP batch to the kernel with the caller token', async () => {
    stubKernel(() => ({ body: { optimized: 2, skipped: 1, savedBytes: 4096, ids: ['a', 'b'] } }));
    const result = await route('POST', '/media-library/optimize').handler(
      request({ body: {} }),
      reply(),
    );
    expect(result).toEqual({ optimized: 2, skipped: 1, savedBytes: 4096, ids: ['a', 'b'] });
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/media/admin/optimize');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it('keeps a targeted WebP conversion inside the kernel contract', async () => {
    stubKernel(() => ({ body: { optimized: 1, skipped: 0, savedBytes: 512, ids: ['att_1'] } }));
    await route('POST', '/media-library/optimize').handler(
      request({ body: { attachmentId: 'att_1' } }),
      reply(),
    );
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/media/admin/optimize');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ attachmentId: 'att_1' });
  });

  it('streams content with its variant and content revision intact', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: {
          'content-type': 'image/webp',
          etag: 'W/"rev-thumb"',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
      });
    });
    const found = createRoutes().find(
      (item) => item.method === 'GET' && item.path === '/media-library/items/:id/content',
    );
    if (!found || found.kind !== 'raw') throw new Error('raw content route missing');

    const { state, reply: raw } = rawReply();
    await found.handler(
      {
        params: { id: 'att_1' },
        query: new URLSearchParams('variant=thumb&v=rev-thumb'),
        headers: {},
        sessionToken: 'sess_test',
      } as unknown as RawHttpRequest,
      raw,
    );

    const call = new URL(calls[0]?.url ?? '');
    expect(call.pathname).toBe('/media/att_1/content');
    expect(call.searchParams.get('variant')).toBe('thumb');
    // The revision must survive the hop, or the console would lose `immutable`.
    expect(call.searchParams.get('v')).toBe('rev-thumb');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sess_test',
    );
    expect(state.status).toBe(200);
    // Validators travel back, so the browser can revalidate through the proxy.
    expect(state.headers['etag']).toBe('W/"rev-thumb"');
    expect(state.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(state.chunks).toHaveLength(1);
    expect(state.ended).toBe(true);
  });
});
