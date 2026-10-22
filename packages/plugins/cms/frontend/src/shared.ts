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
  label: string;
  /** Tailwind classes for a small pill. */
  className: string;
}

const STATUS_META: Record<CmsStatus, StatusMeta> = {
  draft: {
    label: '草稿',
    className: 'bg-muted text-muted-foreground',
  },
  scheduled: {
    label: '定时',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  },
  published: {
    label: '已发布',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  archived: {
    label: '已归档',
    className: 'bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
  },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status as CmsStatus] ?? STATUS_META.draft;
}

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

export function kindLabel(kind: CmsKind): string {
  return kind === 'post' ? '文章' : '页面';
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

/** Parse a JSON error body into a human message. */
export async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string; message?: string };
    return body.error ?? body.detail ?? body.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}
