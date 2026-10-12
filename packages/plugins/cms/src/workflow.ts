import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  JobContext,
} from '@stackpanel/sdk';
import {
  CONTENT_KINDS,
  contentModelFor,
  pageModel,
  postModel,
  revisionModel,
  redirectModel,
} from './models.js';
import { ContentError, notReady } from './errors.js';

/** Site default content language; instances without an explicit `locale` belong here. */
export const DEFAULT_CONTENT_LOCALE = 'zh-CN';

/** A content resource instance as stored by the Extension engine. */
export type ContentInstance = ExtensionInstance<Record<string, unknown>>;

/** A live revision, ready to be rendered at a public URL. */
export interface LiveContent {
  kind: string;
  id: string;
  slug: string;
  path: string;
  title: string;
  excerpt: string;
  body: string;
  authorId: string | null;
  publishedAt: string | null;
  updatedAt: string;
  revisionNumber: number;
  locale: string | null;
  translationKey: string | null;
}

/** The 301 target a retired slug resolves to, or `null` when unknown. */
export interface RedirectResolution {
  from: string;
  target: string;
  kind: string;
  id: string;
  status: 301;
}

const PATH_PREFIX: Record<string, string> = {
  [CONTENT_KINDS.post]: '/blog',
  [CONTENT_KINDS.page]: '/',
};

/** Site-relative path for a published content item. */
export function contentPath(kind: string, slug: string): string {
  const prefix = PATH_PREFIX[kind] ?? '/';
  return prefix === '/' ? `/${slug}` : `${prefix}/${slug}`;
}

/** Normalise a caller-supplied path to a leading-slash, no-trailing-slash form. */
export function normalizePath(value: string): string {
  const trimmed = value.trim();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toLive(kind: string, instance: ContentInstance): LiveContent {
  const spec = instance.spec as Record<string, unknown>;
  const slug = asString(spec['publishedSlug']) || asString(spec['slug']);
  return {
    kind,
    id: instance.name,
    slug,
    path: contentPath(kind, slug),
    title: asString(spec['publishedTitle']),
    excerpt: asString(spec['publishedExcerpt']),
    body: asString(spec['publishedBody']),
    authorId: asOptionalString(spec['authorId']) ?? null,
    publishedAt: null,
    updatedAt: instance.updatedAt.toISOString(),
    revisionNumber: Number(spec['publishedRevisionNumber'] ?? 0),
    locale: asOptionalString(spec['locale']) ?? null,
    translationKey: asOptionalString(spec['translationKey']) ?? null,
  };
}

/**
 * The content workflow: drafts, revisions, publish/schedule, preview and
 * slug-change redirects. Pure over an {@link ExtensionClient} + {@link JobContext}
 * so it can be unit-tested without HTTP or a database.
 */
export class ContentWorkflow {
  constructor(
    private readonly extensions: ExtensionClient,
    private readonly jobs: JobContext,
  ) {}

  private modelFor(kind: string): CustomModelDefinition {
    const model = contentModelFor(kind);
    if (!model) throw new ContentError('cms.unknown_kind', 404, `未知的内容类型：${kind}`);
    return model;
  }

  /** Resolve a resource by id, or fail with a stable 404. */
  async getContent(kind: string, id: string): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const instance = await this.extensions.get<Record<string, unknown>>(model, id);
    if (!instance) throw new ContentError('cms.content.not_found', 404, '内容不存在');
    return instance;
  }

  /** Create a working copy in `draft`, optionally scheduling it immediately. */
  async createDraft(
    kind: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const now = new Date();
    const scheduled = input['status'] === 'scheduled';
    const spec: Record<string, unknown> = {
      ...input,
      status: scheduled ? 'scheduled' : 'draft',
      published: false,
      publishedRevisionNumber: 0,
      currentRevisionNumber: 0,
      ...(actorId ? { authorId: asOptionalString(input['authorId']) ?? actorId } : {}),
      ...(actorId ? { updatedBy: actorId } : {}),
    };
    const created = await this.extensions.create<Record<string, unknown>>(model, spec);
    // Record revision #1 so history starts at draft creation.
    const revision = await this.extensions.create<Record<string, unknown>>(revisionModel, {
      resourceKind: kind,
      resourceId: created.name,
      revisionNumber: 1,
      title: asString(spec['title']),
      slug: asString(spec['slug']),
      excerpt: asString(spec['excerpt']),
      body: asString(spec['body']),
      ...(asOptionalString(spec['authorId']) ? { authorId: spec['authorId'] } : {}),
      note: '初始版本',
    });
    const saved = await this.extensions.update<Record<string, unknown>>(model, created.name, {
      ...spec,
      currentRevisionId: revision.name,
      currentRevisionNumber: 1,
      currentRevisionAt: now.toISOString(),
    });
    if (scheduled) await this.scheduleIfDue(kind, saved);
    return saved;
  }

  /**
   * Save the working copy. Every save writes a new immutable revision; it never
   * changes the live snapshot, so a published item keeps serving until
   * {@link publish} is called.
   */
  async saveRevision(
    kind: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
    note?: string,
  ): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const current = await this.getContent(kind, id);
    const spec = current.spec as Record<string, unknown>;
    const working = { ...spec, ...input };
    // A working-copy save may set/clear the schedule, but never the live state.
    const status = working['status'];
    const nextStatus =
      status === 'scheduled' || status === 'draft' || status === 'archived'
        ? status
        : (spec['status'] as string) === 'published'
          ? 'published'
          : 'draft';
    const revisionNumber = Number(spec['currentRevisionNumber'] ?? 0) + 1;
    const revision = await this.extensions.create<Record<string, unknown>>(revisionModel, {
      resourceKind: kind,
      resourceId: id,
      revisionNumber,
      title: asString(working['title']),
      slug: asString(working['slug']),
      excerpt: asString(working['excerpt']),
      body: asString(working['body']),
      ...(asOptionalString(working['authorId']) ? { authorId: working['authorId'] } : {}),
      ...(note ? { note } : {}),
    });
    const updated = await this.extensions.update<Record<string, unknown>>(model, id, {
      ...working,
      status: nextStatus,
      currentRevisionId: revision.name,
      currentRevisionNumber: revisionNumber,
      ...(actorId ? { updatedBy: actorId } : {}),
    });
    if (nextStatus === 'scheduled') await this.scheduleIfDue(kind, updated);
    return updated;
  }

  /**
   * Promote the working copy (or a specific revision) to live. A slug change
   * retires the previous slug: a 301 redirect row is written so old links keep
   * working (F5).
   */
  async publish(
    kind: string,
    id: string,
    options: { revisionNumber?: number; actorId?: string } = {},
  ): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const current = await this.getContent(kind, id);
    const spec = current.spec as Record<string, unknown>;

    let title = asString(spec['title']);
    let slug = asString(spec['slug']);
    let excerpt = asString(spec['excerpt']);
    let body = asString(spec['body']);
    let revisionNumber = Number(spec['currentRevisionNumber'] ?? 0);
    let revisionId = asOptionalString(spec['currentRevisionId']);

    if (options.revisionNumber !== undefined) {
      const revision = await this.findRevision(id, options.revisionNumber);
      if (!revision) throw new ContentError('cms.revision.not_found', 404, '版本不存在');
      const rspec = revision.spec as Record<string, unknown>;
      title = asString(rspec['title']);
      slug = asString(rspec['slug']);
      excerpt = asString(rspec['excerpt']);
      body = asString(rspec['body']);
      revisionNumber = Number(rspec['revisionNumber']);
      revisionId = revision.name;
    }

    const previousSlug = asOptionalString(spec['publishedSlug']);
    if (previousSlug && previousSlug !== slug) {
      await this.retireSlug(kind, id, previousSlug);
    }

    const published = await this.extensions.update<Record<string, unknown>>(model, id, {
      ...spec,
      status: 'published',
      published: true,
      publishAt: undefined,
      publishedSlug: slug,
      publishedTitle: title,
      publishedExcerpt: excerpt,
      publishedBody: body,
      publishedRevisionId: revisionId,
      publishedRevisionNumber: revisionNumber,
      ...(options.actorId ? { updatedBy: options.actorId } : {}),
    });
    return published;
  }

  /** Take a published item offline without discarding its live snapshot. */
  async unpublish(kind: string, id: string, actorId?: string): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const current = await this.getContent(kind, id);
    const spec = current.spec as Record<string, unknown>;
    return this.extensions.update<Record<string, unknown>>(model, id, {
      ...spec,
      status: 'draft',
      published: false,
      publishAt: undefined,
      ...(actorId ? { updatedBy: actorId } : {}),
    });
  }

  /** Return the working copy to edit (a published item stays live meanwhile). */
  async revertToDraft(kind: string, id: string, actorId?: string): Promise<ContentInstance> {
    const model = this.modelFor(kind);
    const current = await this.getContent(kind, id);
    const spec = current.spec as Record<string, unknown>;
    return this.extensions.update<Record<string, unknown>>(model, id, {
      ...spec,
      status: 'draft',
      publishAt: undefined,
      ...(actorId ? { updatedBy: actorId } : {}),
    });
  }

  /** Delete a content item. Its slug is retired so old links 301 while it can. */
  async deleteContent(kind: string, id: string): Promise<void> {
    const model = this.modelFor(kind);
    const current = await this.getContent(kind, id);
    const spec = current.spec as Record<string, unknown>;
    const liveSlug = asOptionalString(spec['publishedSlug']);
    if (liveSlug) await this.retireSlug(kind, id, liveSlug);
    // Revisions are owned by the item; remove them explicitly (no cascade in the
    // Extension engine). Best-effort: a failure must not block the delete.
    const revisions = await this.extensions.listAll<Record<string, unknown>>(revisionModel, {
      where: { resourceId: { eq: id } },
    });
    await this.extensions.delete(model, id);
    for (const revision of revisions) {
      await this.extensions.delete(revisionModel, revision.name).catch(() => undefined);
    }
  }

  /** Paged history for the editor, newest first. */
  async listRevisions(
    id: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: ContentInstance[]; total: number; page: number; pageSize: number }> {
    const result = await this.extensions.list<Record<string, unknown>>(revisionModel, {
      where: { resourceId: { eq: id } },
      orderBy: { field: 'revisionNumber', desc: true },
      page,
      pageSize,
    });
    return result;
  }

  /** One revision by its number within an item. */
  async findRevision(
    id: string,
    revisionNumber: number,
  ): Promise<ContentInstance | null> {
    const pageSize = 20;
    let page = 1;
    for (;;) {
      const result = await this.extensions.list<Record<string, unknown>>(revisionModel, {
        where: { resourceId: { eq: id }, revisionNumber: { eq: revisionNumber } },
        page,
        pageSize,
      });
      if (result.items[0]) return result.items[0];
      if (page * pageSize >= result.total) return null;
      page += 1;
    }
  }

  /**
   * A preview of a draft or of a specific revision, keyed by slug. Never touches
   * the live snapshot, so previewing a draft that renames the slug cannot break
   * the published page.
   */
  async preview(
    kind: string,
    slug: string,
    revisionNumber?: number,
  ): Promise<LiveContent | null> {
    const model = this.modelFor(kind);
    const working = await this.extensions.listAll<Record<string, unknown>>(model, {
      where: { slug: { eq: slug } },
      orderBy: { field: 'updatedAt', desc: true },
    });
    const instance = working[0];
    if (!instance) return null;
    const spec = instance.spec as Record<string, unknown>;

    if (revisionNumber !== undefined) {
      const revision = await this.findRevision(instance.name, revisionNumber);
      if (!revision) throw new ContentError('cms.revision.not_found', 404, '版本不存在');
      const rspec = revision.spec as Record<string, unknown>;
      return {
        kind,
        id: instance.name,
        slug,
        path: contentPath(kind, slug),
        title: asString(rspec['title']),
        excerpt: asString(rspec['excerpt']),
        body: asString(rspec['body']),
        authorId: asOptionalString(rspec['authorId']) ?? null,
        publishedAt: null,
        updatedAt: instance.updatedAt.toISOString(),
        revisionNumber: Number(rspec['revisionNumber']),
        locale: asOptionalString(spec['locale']) ?? null,
        translationKey: asOptionalString(spec['translationKey']) ?? null,
      };
    }

    return {
      kind,
      id: instance.name,
      slug,
      path: contentPath(kind, slug),
      title: asString(spec['title']),
      excerpt: asString(spec['excerpt']),
      body: asString(spec['body']),
      authorId: asOptionalString(spec['authorId']) ?? null,
      publishedAt: null,
      updatedAt: instance.updatedAt.toISOString(),
      revisionNumber: Number(spec['currentRevisionNumber'] ?? 0),
      locale: asOptionalString(spec['locale']) ?? null,
      translationKey: asOptionalString(spec['translationKey']) ?? null,
    };
  }

  /** Retire a slug: record a 301 from its path to the item's current location. */
  async retireSlug(kind: string, id: string, slug: string): Promise<void> {
    const fromPath = contentPath(kind, slug);
    const existing = await this.extensions.listAll<Record<string, unknown>>(redirectModel, {
      where: { fromPath: { eq: fromPath } },
    });
    if (existing[0]) {
      const spec = existing[0].spec as Record<string, unknown>;
      if (spec['resourceId'] === id && spec['active'] === true) return;
      await this.extensions.update<Record<string, unknown>>(redirectModel, existing[0].name, {
        ...spec,
        resourceId: id,
        resourceKind: kind,
        active: true,
      });
      return;
    }
    await this.extensions.create<Record<string, unknown>>(redirectModel, {
      fromPath,
      resourceKind: kind,
      resourceId: id,
      active: true,
    });
  }

  /** Resolve a retired path to a 301 target, or `null` when there is none. */
  async resolveRedirect(path: string): Promise<RedirectResolution | null> {
    const from = normalizePath(path);
    const rows = await this.extensions.listAll<Record<string, unknown>>(redirectModel, {
      where: { fromPath: { eq: from } },
    });
    const row = rows.find((entry) => (entry.spec as Record<string, unknown>)['active'] === true);
    if (!row) return null;
    const spec = row.spec as Record<string, unknown>;
    const kind = asString(spec['resourceKind']);
    const id = asString(spec['resourceId']);
    const model = contentModelFor(kind);
    if (!model) return null;
    const target = await this.extensions.get<Record<string, unknown>>(model, id);
    if (!target) return null;
    const targetSpec = target.spec as Record<string, unknown>;
    const slug = asString(targetSpec['publishedSlug']) || asString(targetSpec['slug']);
    return { from, target: contentPath(kind, slug), kind, id, status: 301 };
  }

  /** Paged list of redirects for the admin view. */
  async listRedirects(
    page: number,
    pageSize: number,
  ): Promise<{ items: ContentInstance[]; total: number; page: number; pageSize: number }> {
    return this.extensions.list<Record<string, unknown>>(redirectModel, {
      orderBy: { field: 'createdAt', desc: true },
      page,
      pageSize,
    });
  }

  /** Remove one redirect. */
  async deleteRedirect(id: string): Promise<void> {
    await this.extensions.delete(redirectModel, id);
  }

  /**
   * Paged admin list of working copies, newest first. Optionally narrow by
   * lifecycle status and/or a case-insensitive title substring.
   */
  async listAdmin(
    kind: string,
    options: { status?: string; query?: string; page: number; pageSize: number },
  ): Promise<{ items: ContentInstance[]; total: number; page: number; pageSize: number }> {
    const model = this.modelFor(kind);
    const query = options.query?.trim();
    const where: Record<string, { eq?: unknown; contains?: string }> = {};
    if (options.status) where['status'] = { eq: options.status };
    if (query) where['title'] = { contains: query };
    return this.extensions.list<Record<string, unknown>>(model, {
      ...(Object.keys(where).length > 0 ? { where } : {}),
      orderBy: { field: 'updatedAt', desc: true },
      page: options.page,
      pageSize: options.pageSize,
    });
  }

  /**
   * Published items of a kind, newest first (public list). When `locale` is
   * given (and not the site default), only that locale is returned; an empty
   * result falls back to the default content language (ADR-0016 §4).
   */
  async listPublished(
    kind: string,
    page: number,
    pageSize: number,
    locale?: string,
  ): Promise<{ items: LiveContent[]; total: number; page: number; pageSize: number }> {
    const model = this.modelFor(kind);
    const ordered = { orderBy: { field: 'createdAt' as const, desc: true }, page, pageSize };
    let result = await this.extensions.list<Record<string, unknown>>(model, {
      where: locale
        ? { published: { eq: true }, locale: { eq: locale } }
        : { published: { eq: true } },
      ...ordered,
    });
    if (locale && locale !== DEFAULT_CONTENT_LOCALE && result.total === 0) {
      result = await this.extensions.list<Record<string, unknown>>(model, {
        where: { published: { eq: true }, locale: { eq: DEFAULT_CONTENT_LOCALE } },
        ...ordered,
      });
    }
    return {
      items: result.items.map((instance) => toLive(kind, instance)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /** One published item by its live slug (public detail). */
  async getPublishedBySlug(kind: string, slug: string): Promise<LiveContent | null> {
    const model = this.modelFor(kind);
    const matches = await this.extensions.listAll<Record<string, unknown>>(model, {
      where: { publishedSlug: { eq: slug } },
    });
    const instance = matches.find((entry) => (entry.spec as Record<string, unknown>)['published'] === true);
    return instance ? toLive(kind, instance) : null;
  }

  /**
   * Every published item of a kind across all locales, newest first. Used by the
   * SEO provider (`listEntries`), which pages deterministically over the full
   * set so hreflang siblings can be grouped in one pass without N+1 queries.
   */
  async listAllPublished(kind: string): Promise<LiveContent[]> {
    const model = this.modelFor(kind);
    const instances = await this.extensions.listAll<Record<string, unknown>>(model, {
      where: { published: { eq: true } },
      orderBy: { field: 'createdAt', desc: true },
    });
    return instances
      .filter((entry) => (entry.spec as Record<string, unknown>)['published'] === true)
      .map((entry) => toLive(kind, entry));
  }

  /**
   * Published siblings of `slug` across locales (hreflang / language switch).
   * Every published instance sharing the source's `translationKey` is a sibling;
   * an instance without a key is its own single-language group.
   */
  async translations(kind: string, slug: string): Promise<LiveContent[]> {
    const model = this.modelFor(kind);
    const matches = await this.extensions.listAll<Record<string, unknown>>(model, {
      where: { publishedSlug: { eq: slug } },
    });
    const live = matches.filter(
      (entry) => (entry.spec as Record<string, unknown>)['published'] === true,
    );
    const source = live[0];
    if (!source) return [];
    const key = asOptionalString((source.spec as Record<string, unknown>)['translationKey']);
    if (!key) return [toLive(kind, source)];
    const siblings = await this.extensions.listAll<Record<string, unknown>>(model, {
      where: { translationKey: { eq: key } },
    });
    return siblings
      .filter((entry) => (entry.spec as Record<string, unknown>)['published'] === true)
      .map((entry) => toLive(kind, entry));
  }

  /** Publish every item of a kind whose schedule is due; returns how many went live. */
  async publishDue(now = Date.now()): Promise<number> {
    let count = 0;
    for (const model of [postModel, pageModel]) {
      const kind = model.kind;
      const due = await this.extensions.listAll<Record<string, unknown>>(model, {
        where: { status: { eq: 'scheduled' } },
      });
      for (const instance of due) {
        const spec = instance.spec as Record<string, unknown>;
        const publishAt = Number(spec['publishAt'] ?? Number.POSITIVE_INFINITY);
        if (publishAt <= now) {
          await this.publish(kind, instance.name);
          count += 1;
        }
      }
    }
    return count;
  }

  /** Materialise scheduling: a worker job is armed for the earliest due item. */
  private async scheduleIfDue(kind: string, instance: ContentInstance): Promise<void> {
    const spec = instance.spec as Record<string, unknown>;
    const publishAt = Number(spec['publishAt'] ?? 0);
    if (!Number.isFinite(publishAt) || publishAt <= 0) return;
    const delayMs = Math.max(0, publishAt - Date.now());
    // Per-item job id so a rescheduled item replaces its pending publish.
    await this.jobs.enqueue('publish-due', undefined, { delayMs, jobId: `publish:${instance.name}` });
    void kind;
  }
}

/** Build a workflow bound to an activation's extension client + job context. */
export function createWorkflow(extensions: ExtensionClient, jobs: JobContext): ContentWorkflow {
  if (!extensions) throw notReady();
  return new ContentWorkflow(extensions, jobs);
}
