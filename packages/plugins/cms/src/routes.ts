import type { PluginRoute } from '@stackpanel/sdk';
import { CONTENT_KINDS } from './models.js';
import type { ContentInstance, ContentWorkflow } from './workflow.js';
import { ContentError, notReady } from './errors.js';
import { normalizePath } from './workflow.js';

/** Short URL segment (`post` / `page`) → model kind (`cms/post`). */
const SHORT_KINDS: Record<string, string> = {
  post: CONTENT_KINDS.post,
  page: CONTENT_KINDS.page,
};

function kindFromShort(value: string | undefined): string {
  const kind = value ? SHORT_KINDS[value] : undefined;
  if (!kind) throw new ContentError('cms.unknown_kind', 404, `未知的内容类型：${value ?? ''}`);
  return kind;
}

function readPermission(kind: string): string {
  return `custom.${kind.replace('/', '.')}.read`;
}

function writePermission(kind: string): string {
  return `custom.${kind.replace('/', '.')}.write`;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pageParams(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(query['page']) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(query['pageSize']) || 20)));
  return { page, pageSize };
}

/** Serialise a stored content instance into the editor-facing DTO. */
function toContentDto(kind: string, instance: ContentInstance): Record<string, unknown> {
  const spec = instance.spec as Record<string, unknown>;
  const slug = asString(spec['publishedSlug']) || asString(spec['slug']);
  return {
    id: instance.name,
    kind,
    status: spec['status'] ?? 'draft',
    published: spec['published'] === true,
    slug: asString(spec['slug']),
    publishedSlug: spec['publishedSlug'] ?? null,
    title: asString(spec['title']),
    excerpt: asString(spec['excerpt']),
    body: asString(spec['body']),
    authorId: spec['authorId'] ?? null,
    publishAt: spec['publishAt'] ?? null,
    locale: spec['locale'] ?? null,
    translationKey: spec['translationKey'] ?? null,
    currentRevisionNumber: Number(spec['currentRevisionNumber'] ?? 0),
    publishedRevisionNumber: Number(spec['publishedRevisionNumber'] ?? 0),
    path: slug ? `/${kind === CONTENT_KINDS.post ? 'blog/' : ''}${slug}` : null,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

function toRevisionDto(kind: string, instance: ContentInstance): Record<string, unknown> {
  const spec = instance.spec as Record<string, unknown>;
  return {
    id: instance.name,
    kind,
    revisionNumber: Number(spec['revisionNumber'] ?? 0),
    title: asString(spec['title']),
    slug: asString(spec['slug']),
    excerpt: asString(spec['excerpt']),
    body: asString(spec['body']),
    note: spec['note'] ?? null,
    createdAt: instance.createdAt.toISOString(),
  };
}

/**
 * Every HTTP route the CMS plugin exposes. Built per activation so the handlers
 * close over that activation's {@link ContentWorkflow} (the extension client is
 * bound to the plugin's active models).
 */
export function createRoutes(getWorkflow: () => ContentWorkflow | null): PluginRoute[] {
  const workflow = (): ContentWorkflow => {
    const current = getWorkflow();
    if (!current) throw notReady();
    return current;
  };

  return [
    // ---- public read surface -------------------------------------------------
    {
      method: 'GET',
      path: '/cms/posts',
      auth: 'public',
      handler: async (request) =>
        workflow().listPublished(
          CONTENT_KINDS.post,
          ...pageTuple(request.query),
          asOptionalString(request.query['locale']),
        ),
    },
    {
      method: 'GET',
      path: '/cms/pages',
      auth: 'public',
      handler: async (request) =>
        workflow().listPublished(
          CONTENT_KINDS.page,
          ...pageTuple(request.query),
          asOptionalString(request.query['locale']),
        ),
    },
    {
      method: 'GET',
      path: '/cms/posts/:slug',
      auth: 'public',
      handler: async (request, reply) => {
        const item = await workflow().getPublishedBySlug(
          CONTENT_KINDS.post,
          request.params['slug'] ?? '',
        );
        if (!item) {
          reply.code(404).send({ error: '内容不存在' });
          return undefined;
        }
        return item;
      },
    },
    {
      method: 'GET',
      path: '/cms/pages/:slug',
      auth: 'public',
      handler: async (request, reply) => {
        const item = await workflow().getPublishedBySlug(
          CONTENT_KINDS.page,
          request.params['slug'] ?? '',
        );
        if (!item) {
          reply.code(404).send({ error: '内容不存在' });
          return undefined;
        }
        return item;
      },
    },
    {
      method: 'GET',
      path: '/cms/posts/:slug/translations',
      auth: 'public',
      handler: async (request, reply) => {
        const translations = await workflow().translations(
          CONTENT_KINDS.post,
          request.params['slug'] ?? '',
        );
        if (translations.length === 0) {
          reply.code(404).send({ error: '内容不存在' });
          return undefined;
        }
        return { translations };
      },
    },
    {
      method: 'GET',
      path: '/cms/pages/:slug/translations',
      auth: 'public',
      handler: async (request, reply) => {
        const translations = await workflow().translations(
          CONTENT_KINDS.page,
          request.params['slug'] ?? '',
        );
        if (translations.length === 0) {
          reply.code(404).send({ error: '内容不存在' });
          return undefined;
        }
        return { translations };
      },
    },
    {
      method: 'GET',
      path: '/cms/redirects/resolve',
      auth: 'public',
      handler: async (request) => {
        const path = asString(request.query['path']);
        if (!path) throw new ContentError('cms.redirect.path_required', 400, '缺少 path 参数');
        const resolution = await workflow().resolveRedirect(path);
        if (!resolution) {
          return { found: false, from: normalizePath(path), target: null, status: 404 };
        }
        return { found: true, ...resolution };
      },
    },

    // ---- authenticated draft preview ----------------------------------------
    {
      method: 'GET',
      path: '/cms/preview/:kind/:slug',
      auth: 'user',
      handler: async (request, reply) => {
        const kind = kindFromShort(request.params['kind']);
        const slug = request.params['slug'] ?? '';
        const revisionNumber = Number(request.query['revision']) || undefined;
        const preview = await workflow().preview(kind, slug, revisionNumber);
        if (!preview) {
          reply.code(404).send({ error: '内容不存在' });
          return undefined;
        }
        return preview;
      },
    },

    // ---- admin authoring surface --------------------------------------------
    {
      method: 'GET',
      path: '/cms/admin/content/:kind',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const { page, pageSize } = pageParams(request.query);
        const status = asString(request.query['status']);
        const query = asString(request.query['q']);
        const result = await workflow().listAdmin(kind, {
          ...(status ? { status } : {}),
          ...(query ? { query } : {}),
          page,
          pageSize,
        });
        return {
          items: result.items.map((instance) => toContentDto(kind, instance)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        };
      },
    },
    {
      method: 'GET',
      path: '/cms/admin/content/:kind/:id',
      auth: 'admin',
      handler: async (request, reply) => {
        const kind = kindFromShort(request.params['kind']);
        try {
          const instance = await workflow().getContent(kind, request.params['id'] ?? '');
          return toContentDto(kind, instance);
        } catch (error) {
          if (error instanceof ContentError) {
            reply.code(error.status).send({ error: error.detail ?? '内容不存在' });
            return undefined;
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/cms/admin/content/:kind',
      auth: 'admin',
      handler: async (request, reply) => {
        const kind = kindFromShort(request.params['kind']);
        const created = await workflow().createDraft(kind, asRecord(request.body), request.user?.id);
        reply.code(201);
        return toContentDto(kind, created);
      },
    },
    {
      method: 'PATCH',
      path: '/cms/admin/content/:kind/:id',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const body = asRecord(request.body);
        const note = asString(body['note']) || undefined;
        const { note: _note, ...input } = body;
        const updated = await workflow().saveRevision(
          kind,
          request.params['id'] ?? '',
          input,
          request.user?.id,
          note,
        );
        return toContentDto(kind, updated);
      },
    },
    {
      method: 'POST',
      path: '/cms/admin/content/:kind/:id/publish',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const body = asRecord(request.body);
        const revisionNumber = Number(body['revisionNumber']) || undefined;
        const published = await workflow().publish(kind, request.params['id'] ?? '', {
          ...(revisionNumber !== undefined ? { revisionNumber } : {}),
          ...(request.user?.id ? { actorId: request.user.id } : {}),
        });
        return toContentDto(kind, published);
      },
    },
    {
      method: 'POST',
      path: '/cms/admin/content/:kind/:id/unpublish',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const updated = await workflow().unpublish(
          kind,
          request.params['id'] ?? '',
          request.user?.id,
        );
        return toContentDto(kind, updated);
      },
    },
    {
      method: 'POST',
      path: '/cms/admin/content/:kind/:id/revert',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const updated = await workflow().revertToDraft(
          kind,
          request.params['id'] ?? '',
          request.user?.id,
        );
        return toContentDto(kind, updated);
      },
    },
    {
      method: 'DELETE',
      path: '/cms/admin/content/:kind/:id',
      auth: 'admin',
      handler: async (request, reply) => {
        const kind = kindFromShort(request.params['kind']);
        await workflow().deleteContent(kind, request.params['id'] ?? '');
        reply.code(204).send();
        return undefined;
      },
    },
    {
      method: 'GET',
      path: '/cms/admin/content/:kind/:id/revisions',
      auth: 'admin',
      handler: async (request) => {
        const kind = kindFromShort(request.params['kind']);
        const { page, pageSize } = pageParams(request.query);
        const result = await workflow().listRevisions(
          request.params['id'] ?? '',
          page,
          pageSize,
        );
        return {
          items: result.items.map((instance) => toRevisionDto(kind, instance)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        };
      },
    },
    {
      method: 'GET',
      path: '/cms/admin/redirects',
      auth: 'admin',
      handler: async (request) => {
        const { page, pageSize } = pageParams(request.query);
        const result = await workflow().listRedirects(page, pageSize);
        return {
          items: result.items.map((instance) => {
            const spec = instance.spec as Record<string, unknown>;
            return {
              id: instance.name,
              fromPath: asString(spec['fromPath']),
              resourceKind: asString(spec['resourceKind']),
              resourceId: asString(spec['resourceId']),
              active: spec['active'] === true,
              createdAt: instance.createdAt.toISOString(),
            };
          }),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        };
      },
    },
    {
      method: 'DELETE',
      path: '/cms/admin/redirects/:id',
      auth: 'admin',
      handler: async (request, reply) => {
        await workflow().deleteRedirect(request.params['id'] ?? '');
        reply.code(204).send();
        return undefined;
      },
    },
  ];
}

function pageTuple(query: Record<string, unknown>): [number, number] {
  const { page, pageSize } = pageParams(query);
  return [page, pageSize];
}

/** Re-exported so the manifest can advertise per-kind permissions. */
export const CMS_PERMISSIONS = [
  readPermission(CONTENT_KINDS.post),
  writePermission(CONTENT_KINDS.post),
  readPermission(CONTENT_KINDS.page),
  writePermission(CONTENT_KINDS.page),
];
