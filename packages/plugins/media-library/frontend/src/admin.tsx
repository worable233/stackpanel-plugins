'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SectionTitle,
  Select,
} from '@stackpanel/ui';
import {
  Eye,
  ImageOff,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Trash2,
  Unlock,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from './i18n.js';

/** Same-origin BFF namespace: the browser only reaches plugin-declared paths. */
const API = '/api/plugins/media-library';
const PAGE_SIZE = 24;

type Visibility = 'public' | 'private';
type MediaKind = 'image' | 'document' | 'archive' | 'video' | 'audio' | 'text' | 'other';
const KINDS: readonly MediaKind[] = [
  'image',
  'document',
  'archive',
  'video',
  'audio',
  'text',
  'other',
];

interface MediaVariant {
  name: string;
  status?: string;
  width?: number;
  height?: number;
  /** Content revision of this variant's bytes; see `contentUrl`. */
  rev?: string;
}

interface MediaItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  visibility: Visibility;
  ownerId: string | null;
  variants: MediaVariant[];
  /** Content revision of the stored original; changes when the bytes are rewritten. */
  rev?: string;
  createdAt: string;
}

interface ListResponse {
  items: MediaItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface StatsResponse {
  stats: {
    total: number;
    bytes: number;
    byVisibility: { public: number; private: number };
    byKind: Record<string, number>;
    variants: { pending: number; ready: number; failed: number };
  };
  encoder: { available: boolean; error?: string };
}

class ApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function api<Result>(path: string, init?: RequestInit): Promise<Result> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    throw new ApiError(
      payload?.error ?? `HTTP ${response.status}`,
      payload?.code ?? 'mediaLibrary.requestFailed',
    );
  }
  return payload as Result;
}

/** Browsers cannot load the kernel's own /media URL: it is not a plugin path. */
function contentUrl(item: MediaItem, variant?: string): string {
  const base = `${API}/items/${encodeURIComponent(item.id)}/content`;
  const params = new URLSearchParams();
  if (variant) params.set('variant', variant);
  // Same link, moving bytes: the revision is what tells the browser that the copy
  // it cached before 「无损转 WebP」 is out of date. Old links (without `v`) keep
  // working — the kernel treats a mismatch as "revalidate", never as "not found".
  const rev = variant
    ? (item.variants.find((candidate) => candidate.name === variant)?.rev ?? item.rev)
    : item.rev;
  if (rev) params.set('v', rev);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function hasThumb(item: MediaItem): boolean {
  return item.variants.some(
    (variant) =>
      variant.name === 'thumb' && (variant.status === undefined || variant.status === 'ready'),
  );
}

/** Thumbnail with graceful degradation: variant → original → placeholder. */
function Thumbnail({ item, tr }: { item: MediaItem; tr: (key: string) => string }) {
  const [failed, setFailed] = useState(false);
  const [useVariant, setUseVariant] = useState(hasThumb(item));

  if (!item.mime.startsWith('image/') || failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
        <ImageOff className="size-6" aria-hidden />
        <span className="text-[11px]">{tr('state.imageUnavailable')}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- the host does not expose next/image to plugin packages
    <img
      src={contentUrl(item, useVariant ? 'thumb' : undefined)}
      alt={item.filename}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => {
        if (useVariant) setUseVariant(false);
        else setFailed(true);
      }}
    />
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-muted/40 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold leading-none">{value}</span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function MediaLibraryPage(props: AdminPageComponentProps) {
  const tr = useMemo(() => t(props.locale), [props.locale]);

  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kind, setKind] = useState('');
  const [visibility, setVisibility] = useState('');
  const [payload, setPayload] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (kind) params.set('kind', kind);
      if (visibility) params.set('visibility', visibility);
      const [list, stats] = await Promise.all([
        api<ListResponse>(`/items?${params.toString()}`),
        api<StatsResponse>('/stats'),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setPayload(stats);
    } catch (err) {
      const failure = err as ApiError;
      setError({ message: failure.message || tr('error.load'), code: failure.code ?? '' });
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, kind, visibility, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const stats = payload?.stats ?? null;
  const encoder = payload?.encoder ?? null;
  const failedVariants = stats?.variants.failed ?? 0;

  const report = useCallback(
    (key: string, err: unknown) => {
      const failure = err as ApiError;
      if (failure.code === 'media.in_use') {
        setError({ message: tr('error.inUse'), code: failure.code });
        return;
      }
      setError({ message: failure.message || tr(key), code: failure.code ?? '' });
    },
    [tr],
  );

  const changeVisibility = useCallback(
    async (item: MediaItem) => {
      const next: Visibility = item.visibility === 'public' ? 'private' : 'public';
      setBusyId(item.id);
      setError(null);
      try {
        await api(`/items/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ visibility: next }),
        });
        await load();
      } catch (err) {
        report('error.update', err);
      } finally {
        setBusyId(null);
      }
    },
    [load, report],
  );

  const remove = useCallback(async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    setError(null);
    try {
      await api(`/items/${encodeURIComponent(pendingDelete.id)}`, { method: 'DELETE' });
      setPendingDelete(null);
      await load();
    } catch (err) {
      setPendingDelete(null);
      report('error.delete', err);
    } finally {
      setBusyId(null);
    }
  }, [pendingDelete, load, report]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ requeued: number }>('/variants/rebuild', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(tr('action.rebuildDone', { count: String(result.requeued) }));
      await load();
    } catch (err) {
      report('error.rebuild', err);
    } finally {
      setRebuilding(false);
    }
  }, [load, report, tr]);

  const optimize = useCallback(async () => {
    setOptimizing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ optimized: number; skipped: number; savedBytes: number }>(
        '/optimize',
        { method: 'POST', body: JSON.stringify({}) },
      );
      setNotice(
        result.optimized > 0
          ? tr('action.optimizeDone', {
              count: String(result.optimized),
              saved: formatBytes(result.savedBytes),
            })
          : tr('action.optimizeNone'),
      );
      await load();
    } catch (err) {
      report('error.optimize', err);
    } finally {
      setOptimizing(false);
    }
  }, [load, report, tr]);

  return (
    <section className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle>{tr('page.title')}</SectionTitle>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {tr('action.refresh')}
        </Button>
      </div>

      {encoder && !encoder.available ? (
        <div role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm">
          <p className="font-medium text-destructive">{tr('encoder.unavailable')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{tr('encoder.hint')}</p>
          {encoder.error ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{encoder.error}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 p-3 text-sm"
        >
          <span className="text-destructive">{error.message}</span>
          <Button variant="ghost" size="xs" onClick={() => void load()}>
            {tr('action.retry')}
          </Button>
        </div>
      ) : null}

      {notice ? (
        <div role="status" className="rounded-xl bg-muted/40 p-3 text-sm">
          {notice}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={tr('stats.total')} value={String(stats?.total ?? 0)} />
        <StatCard label={tr('stats.storage')} value={formatBytes(stats?.bytes ?? 0)} />
        <StatCard
          label={tr('stats.visibility')}
          value={`${stats?.byVisibility.public ?? 0} / ${stats?.byVisibility.private ?? 0}`}
          hint={`${tr('visibility.public')} / ${tr('visibility.private')}`}
        />
        <StatCard
          label={tr('stats.failed')}
          value={String(failedVariants)}
          hint={`${tr('stats.pending')} ${stats?.variants.pending ?? 0} · ${tr('stats.ready')} ${stats?.variants.ready ?? 0}`}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl bg-muted/40 p-4">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="media-library-search">{tr('filter.searchLabel')}</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="media-library-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tr('filter.searchPlaceholder')}
              className="pl-8"
            />
          </div>
        </div>
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="media-library-kind">{tr('filter.kind')}</Label>
          <Select
            id="media-library-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{tr('filter.allKinds')}</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {tr(`kind.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-40 flex-col gap-1.5">
          <Label htmlFor="media-library-visibility">{tr('filter.visibility')}</Label>
          <Select
            id="media-library-visibility"
            value={visibility}
            onChange={(event) => {
              setVisibility(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{tr('filter.allVisibility')}</option>
            <option value="public">{tr('visibility.public')}</option>
            <option value="private">{tr('visibility.private')}</option>
          </Select>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void rebuild()}
          disabled={rebuilding || failedVariants === 0}
          title={tr('action.rebuildHint')}
        >
          {rebuilding ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Wand2 className="size-3.5" aria-hidden />
          )}
          {tr('action.rebuild')}
          {failedVariants > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">({failedVariants})</span>
          ) : null}
        </Button>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {tr('state.loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-2xl bg-muted/40 py-12 text-center">
          <p className="text-sm font-medium">{tr('state.empty')}</p>
          <p className="text-xs text-muted-foreground">{tr('state.emptyHint')}</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col overflow-hidden rounded-2xl bg-muted/40 p-1.5"
            >
              <div className="aspect-[4/3] w-full overflow-hidden rounded-xl bg-muted">
                <Thumbnail item={item} tr={tr} />
              </div>
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-medium" title={item.filename}>
                    {item.filename}
                  </p>
                  <Badge variant={item.visibility === 'public' ? 'outline' : 'secondary'}>
                    {item.visibility === 'public' ? (
                      <Unlock className="size-3" aria-hidden />
                    ) : (
                      <Lock className="size-3" aria-hidden />
                    )}
                    {tr(`visibility.${item.visibility}`)}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {item.mime} · {formatBytes(item.size)}
                  {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setPreview(item)}>
                    <Eye className="size-3.5" aria-hidden />
                    {tr('action.preview')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busyId === item.id}
                    onClick={() => void changeVisibility(item)}
                  >
                    {item.visibility === 'public' ? (
                      <Lock className="size-3.5" aria-hidden />
                    ) : (
                      <Unlock className="size-3.5" aria-hidden />
                    )}
                    {item.visibility === 'public'
                      ? tr('action.makePrivate')
                      : tr('action.makePublic')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={busyId === item.id}
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {tr('action.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {tr('pagination.summary', { page: String(page), pages: String(pages) })}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            {tr('pagination.prev')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            {tr('pagination.next')}
          </Button>
        </div>
      </div>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => (open ? undefined : setPreview(null))}
      >
        <DialogContent closeLabel={tr('action.close')} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tr('dialog.title')}</DialogTitle>
            <DialogDescription className="truncate">{preview?.filename ?? ''}</DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="flex flex-col gap-3">
              {preview.mime.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element -- host ABI has no next/image
                <img
                  src={contentUrl(preview)}
                  alt={preview.filename}
                  className="max-h-[50vh] w-full rounded-xl bg-muted object-contain"
                />
              ) : null}
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{tr('dialog.filename')}</dt>
                <dd className="truncate">{preview.filename}</dd>
                <dt className="text-muted-foreground">{tr('dialog.mime')}</dt>
                <dd>{preview.mime}</dd>
                <dt className="text-muted-foreground">{tr('dialog.size')}</dt>
                <dd>{formatBytes(preview.size)}</dd>
                <dt className="text-muted-foreground">{tr('dialog.dimensions')}</dt>
                <dd>
                  {preview.width && preview.height ? `${preview.width}×${preview.height}` : '—'}
                </dd>
                <dt className="text-muted-foreground">{tr('dialog.visibility')}</dt>
                <dd>{tr(`visibility.${preview.visibility}`)}</dd>
                <dt className="text-muted-foreground">{tr('dialog.owner')}</dt>
                <dd className="truncate font-mono text-xs">
                  {preview.ownerId ?? tr('meta.anonymousOwner')}
                </dd>
                <dt className="text-muted-foreground">{tr('dialog.createdAt')}</dt>
                <dd>{formatDate(preview.createdAt)}</dd>
                <dt className="text-muted-foreground">{tr('dialog.id')}</dt>
                <dd className="truncate font-mono text-xs">{preview.id}</dd>
              </dl>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPreview(null)}>
              {tr('action.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
      >
        <DialogContent closeLabel={tr('delete.cancel')}>
          <DialogHeader>
            <DialogTitle>{tr('delete.title')}</DialogTitle>
            <DialogDescription>
              {tr('delete.description', { name: pendingDelete?.filename ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
              {tr('delete.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void remove()}>
              {tr('delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export const adminPages = { 'admin/library': MediaLibraryPage };
