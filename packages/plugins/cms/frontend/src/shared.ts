/**
 * Shared client/server types and helpers for the CMS frontend package.
 *
 * Kept free of React and zod so both the server finder entry (`index.tsx`) and
 * the client admin entry (`admin.tsx`) can import it without pulling either in.
 */

/** A content working copy as serialised by `toContentDto`. */
export interface CmsContent {
  id: string;
  kind: string;
  status: CmsStatus;
  published: boolean;
  slug: string;
  publishedSlug: string | null;
  title: string;
  excerpt: string;
  body: string;
  authorId: string | null;
  publishAt: number | null;
  locale: string | null;
  translationKey: string | null;
  currentRevisionNumber: number;
  publishedRevisionNumber: number;
  path: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CmsStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface CmsList {
  items: CmsContent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CmsRevision {
  id: string;
  kind: string;
  revisionNumber: number;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  note: string | null;
  createdAt: string;
}

export interface CmsRevisionList {
  items: CmsRevision[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CmsRedirect {
  id: string;
  fromPath: string;
  resourceKind: string;
  resourceId: string;
  active: boolean;
  createdAt: string;
}

export interface CmsRedirectList {
  items: CmsRedirect[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * BFF origin for plugin HTTP routes. The kernel proxy strips exactly
 * `/api/plugins`, so a caller path of `/cms/admin/content/post` becomes the
 * upstream `/cms/admin/content/post`.
 */
export const CMS_API_BASE = '/api/plugins';

export type CmsKind = 'post' | 'page';

export interface StatusMeta {
  /** Message id in the package catalog (ADR-0016 §5). */
  messageKey: string;
  /** Tailwind classes for a small pill. */
  className: string;
}

const STATUS_META: Record<CmsStatus, StatusMeta> = {
  draft: {
    messageKey: 'status.draft',
    className: 'bg-muted text-muted-foreground',
  },
  scheduled: {
    messageKey: 'status.scheduled',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  },
  published: {
    messageKey: 'status.published',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  archived: {
    messageKey: 'status.archived',
    className: 'bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
  },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status as CmsStatus] ?? STATUS_META.draft;
}

/** Minimal translator shape, so this module stays free of React and the SDK. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** `2026-10-04T12:00:00.000Z` → `2026-10-04 12:00`. */
export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Message id for a content kind; resolve it with the package translator. */
export function kindKey(kind: CmsKind): string {
  return kind === 'post' ? 'kind.post' : 'kind.page';
}

/** Turn a title into a slug accepted by the backend (`[a-z0-9-]+`). */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 191);
}

/** Paged query string, omitting empty values. */
export function listQuery(params: {
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.q) search.set('q', params.q);
  search.set('page', String(params.page ?? 1));
  search.set('pageSize', String(params.pageSize ?? 20));
  return search.toString();
}

/**
 * 反馈只能显示已本地化的文案，绝不显示原始异常正文。
 *
 * `Error.message` 里是服务端/上游的英文原文（`fetch failed`、
 * `SignatureDoesNotMatch`、SQL 片段……），既未本地化也可能泄漏内部细节。
 * 这里只把它写进控制台，界面拿到调用方选定的 `tr(...)` 文案。
 */
export function failure(cause: unknown, message: string): string {
  console.error('[cms] request failed', cause);
  return message;
}

/** Parse a JSON error body into a human message in the caller's locale. */
export async function readErrorMessage(response: Response, tr: Translate): Promise<string> {
  const fallback = tr('error.requestFailed', { status: response.status });
  try {
    const body = (await response.json()) as { error?: string; detail?: string; message?: string };
    return body.error ?? body.detail ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}
