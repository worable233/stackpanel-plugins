'use client';
import { SectionTitle } from '@stackpanel/ui';

import { FeatureOverview } from '@stackpanel/ui';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Clock,
  Eye,
  FileText,
  Globe,
  History,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import { renderMarkdown } from './markdown.js';
import {
  CMS_API_BASE,
  type CmsContent,
  type CmsKind,
  type CmsList,
  type CmsRedirect,
  type CmsRedirectList,
  type CmsRevisionList,
  formatDateTime,
  failure,
  kindKey,
  listQuery,
  readErrorMessage,
  slugify,
  statusMeta,
  type Translate,
} from './shared.js';
import { t } from './i18n.js';

/* ------------------------------------------------------------------ */
/* BFF client                                                          */
/* ------------------------------------------------------------------ */

async function bff<T>(path: string, tr: Translate, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CMS_API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, tr));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function fetchList(
  kind: CmsKind,
  params: { status: string; q: string; page: number },
  tr: Translate,
): Promise<CmsList> {
  return bff<CmsList>(`/cms/admin/content/${kind}?${listQuery(params)}`, tr);
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function StatusPill({ status, tr }: { status: string; tr: Translate }): ReactElement {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {tr(meta.messageKey)}
    </span>
  );
}

function Empty({ text, children }: { text: string; children?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <FileText className="size-5" />
      </span>
      <p className="mt-4 text-sm font-medium">{text}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }): ReactElement | null {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

function Pager({
  page,
  pageSize,
  total,
  onPage,
  tr,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  tr: Translate;
}): ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{tr('pager.summary', { total, page, pages })}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {tr('pager.prev')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          {tr('pager.next')}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mutations (imperative BFF writes)                                   */
/* ------------------------------------------------------------------ */

async function mutate(
  kind: CmsKind,
  id: string,
  op: 'publish' | 'unpublish' | 'revert',
  tr: Translate,
): Promise<void> {
  await bff(`/cms/admin/content/${kind}/${encodeURIComponent(id)}/${op}`, tr, {
    method: 'POST',
  });
}

async function removeContent(kind: CmsKind, id: string, tr: Translate): Promise<void> {
  await bff(`/cms/admin/content/${kind}/${encodeURIComponent(id)}`, tr, {
    method: 'DELETE',
  });
}

/* ------------------------------------------------------------------ */
/* Content list (posts / pages)                                        */
/* ------------------------------------------------------------------ */

interface ContentListPageProps {
  kind: CmsKind;
  initial: CmsList | null;
  locale?: string;
}

function ContentListPage({ kind, initial, locale }: ContentListPageProps): ReactElement {
  const tr = t(locale);
  const label = tr(kindKey(kind));
  const [items, setItems] = useState<CmsList | null>(initial);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(
    async (next: { status: string; q: string; page: number }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setItems(await fetchList(kind, next, tr));
      } catch (loadError) {
        setError(failure(loadError, tr('error.loadFailed')));
      } finally {
        setLoading(false);
      }
    },
    [kind],
  );

  // Whenever the filters change, re-read from the server (single source of truth).
  useEffect(() => {
    const timer = setTimeout(() => {
      void reload({ status, q: search.trim(), page });
    }, 200);
    return () => clearTimeout(timer);
  }, [kind, status, search, page, reload]);

  async function runAction(id: string, op: 'publish' | 'unpublish' | 'revert'): Promise<void> {
    setPending(id);
    setError(null);
    try {
      await mutate(kind, id, op, tr);
      await reload({ status, q: search.trim(), page });
    } catch (actionError) {
      setError(failure(actionError, tr('error.actionFailed')));
    } finally {
      setPending(null);
    }
  }

  async function runDelete(id: string): Promise<void> {
    setPending(id);
    setError(null);
    try {
      await removeContent(kind, id, tr);
      await reload({ status, q: search.trim(), page });
    } catch (actionError) {
      setError(failure(actionError, tr('error.deleteFailed')));
    } finally {
      setPending(null);
    }
  }

  const rows = items?.items ?? [];

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={label}
        actions={
          <Button
            nativeButton={false}
            render={<Link href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/new`} />}
            className="gap-1.5"
          >
            <Plus className="size-4" />
            {tr('list.newContent', { kind: label })}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={tr('list.searchPlaceholder', { kind: label })}
            className="pl-8"
            aria-label={tr('list.searchPlaceholder', { kind: label })}
          />
        </div>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          className="w-36"
          aria-label={tr('list.filterAria')}
        >
          <option value="">{tr('list.allStatuses')}</option>
          <option value="draft">{tr('status.draft')}</option>
          <option value="scheduled">{tr('status.scheduled')}</option>
          <option value="published">{tr('status.published')}</option>
          <option value="archived">{tr('status.archived')}</option>
        </Select>
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <ErrorBanner message={error} />

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{tr('list.colTitle')}</th>
                <th className="px-4 py-2.5 font-medium">{tr('list.colStatus')}</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">slug</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">
                  {tr('list.colLocale')}
                </th>
                <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">
                  {tr('list.colUpdatedAt')}
                </th>
                <th className="px-4 py-2.5 text-right font-medium">{tr('list.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/${item.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {item.title || tr('list.untitled')}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>r{item.currentRevisionNumber}</span>
                      {item.published ? (
                        <span className="inline-flex items-center gap-1">
                          <Globe className="size-3" />
                          {item.publishedSlug ?? item.slug}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={item.status} tr={tr} />
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                    {item.slug || '—'}
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
                    {item.locale ?? tr('list.defaultLocale')}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right text-xs text-muted-foreground lg:table-cell">
                    {formatDateTime(item.updatedAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <RowAction
                        item={item}
                        pending={pending === item.id}
                        onPublish={() => void runAction(item.id, 'publish')}
                        onUnpublish={() => void runAction(item.id, 'unpublish')}
                        onDelete={() => void runDelete(item.id)}
                        tr={tr}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        nativeButton={false}
                        render={
                          <Link
                            href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/${item.id}`}
                            aria-label={tr('list.editAria')}
                          />
                        }
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text={tr('list.empty', { kind: label })}>
          <Button
            nativeButton={false}
            render={<Link href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/new`} />}
            className="gap-1.5"
          >
            <Plus className="size-4" />
            {tr('list.newContent', { kind: label })}
          </Button>
        </Empty>
      )}

      {items ? (
        <Pager
          page={items.page}
          pageSize={items.pageSize}
          total={items.total}
          onPage={setPage}
          tr={tr}
        />
      ) : null}
    </main>
  );
}

function RowAction({
  item,
  pending,
  onPublish,
  onUnpublish,
  onDelete,
  tr,
}: {
  item: CmsContent;
  pending: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  tr: Translate;
}): ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (pending) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  return (
    <>
      {item.published ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onUnpublish}
          aria-label={tr('row.unpublish')}
          title={tr('row.unpublish')}
        >
          <Undo2 className="size-3.5" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onPublish}
          aria-label={tr('row.publish')}
          title={tr('row.publish')}
        >
          <Send className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setConfirmDelete(true)}
        aria-label={tr('row.delete')}
        title={tr('row.delete')}
      >
        <Trash2 className="size-3.5 text-destructive" />
      </Button>
      {confirmDelete ? (
        <Dialog open onOpenChange={(open) => !open && setConfirmDelete(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {tr('delete.title', { title: item.title || tr('list.untitled') })}
              </DialogTitle>
              <DialogDescription>{tr('delete.description')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                {tr('delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                {tr('delete.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Content editor                                                      */
/* ------------------------------------------------------------------ */

type EditorTab = 'write' | 'preview' | 'history';

interface EditorPageProps {
  kind: CmsKind;
  id: string | null;
  /** Interface locale; distinct from the content's own `locale` field. */
  uiLocale?: string;
}

function EditorPage({ kind, id, uiLocale }: EditorPageProps): ReactElement {
  const tr = t(uiLocale);
  const label = tr(kindKey(kind));
  const listHref = `/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}`;
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('write');

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [body, setBody] = useState('');
  const [locale, setLocale] = useState('');
  const [translationKey, setTranslationKey] = useState('');
  const [status, setStatus] = useState<string>('draft');
  const [published, setPublished] = useState(false);
  const [publishAt, setPublishAt] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [revisions, setRevisions] = useState<CmsRevisionList | null>(null);

  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const content = await bff<CmsContent>(
          `/cms/admin/content/${kind}/${encodeURIComponent(id)}`,
          tr,
        );
        if (!active) return;
        setTitle(content.title);
        setSlug(content.slug);
        setExcerpt(content.excerpt);
        setBody(content.body);
        setLocale(content.locale ?? '');
        setTranslationKey(content.translationKey ?? '');
        setStatus(content.status);
        setPublished(content.published);
        setPublishAt(content.publishAt ? toLocalInput(content.publishAt) : '');
        setSlugTouched(true);
      } catch (loadError) {
        if (active) setError(failure(loadError, tr('error.loadFailed')));
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, kind, tr]);

  const effectiveSlug = useMemo(() => slug.trim(), [slug]);

  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      title: title.trim(),
      slug: effectiveSlug,
      body,
      excerpt: excerpt.trim(),
    };
    if (locale.trim()) payload['locale'] = locale.trim();
    if (translationKey.trim()) payload['translationKey'] = translationKey.trim();
    return payload;
  }

  async function save(extra?: { scheduled?: boolean }): Promise<CmsContent | null> {
    setError(null);
    setNotice(null);
    if (!title.trim()) {
      setError(tr('editor.error.titleRequired'));
      return null;
    }
    const finalSlug = effectiveSlug || slugify(title);
    if (!finalSlug) {
      setError(effectiveSlug ? tr('editor.error.slugInvalid') : tr('editor.error.slugRequired'));
      return null;
    }
    if (status === 'scheduled' && !publishAt) {
      setError(tr('editor.error.publishAtRequired'));
      return null;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      payload['slug'] = finalSlug;
      if (status === 'scheduled' || extra?.scheduled) {
        payload['status'] = 'scheduled';
        payload['publishAt'] = new Date(publishAt).getTime();
      }
      const saved = id
        ? await bff<CmsContent>(`/cms/admin/content/${kind}/${encodeURIComponent(id)}`, tr, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await bff<CmsContent>(`/cms/admin/content/${kind}`, tr, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
      setStatus(saved.status);
      setPublished(saved.published);
      if (!id) {
        window.location.href = `${listHref}/${saved.id}`;
        return saved;
      }
      setNotice(tr('editor.notice.saved'));
      return saved;
    } catch (saveError) {
      setError(failure(saveError, tr('error.saveFailed')));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function publishNow(): Promise<void> {
    const saved = await save();
    if (!saved || !saved.id) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bff<CmsContent>(
        `/cms/admin/content/${kind}/${encodeURIComponent(saved.id)}/publish`,
        tr,
        { method: 'POST' },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice(tr('editor.notice.published'));
    } catch (publishError) {
      setError(failure(publishError, tr('error.publishFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function unpublishNow(): Promise<void> {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bff<CmsContent>(
        `/cms/admin/content/${kind}/${encodeURIComponent(id)}/unpublish`,
        tr,
        { method: 'POST' },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice(tr('editor.notice.unpublished'));
    } catch (unpublishError) {
      setError(failure(unpublishError, tr('error.unpublishFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function loadRevisions(): Promise<void> {
    if (!id) return;
    setTab('history');
    try {
      setRevisions(
        await bff<CmsRevisionList>(
          `/cms/admin/content/${kind}/${encodeURIComponent(id)}/revisions?page=1&pageSize=50`,
          tr,
        ),
      );
    } catch (historyError) {
      setError(failure(historyError, tr('error.revisionsFailed')));
    }
  }

  async function publishRevision(revisionNumber: number): Promise<void> {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bff<CmsContent>(
        `/cms/admin/content/${kind}/${encodeURIComponent(id)}/publish`,
        tr,
        { method: 'POST', body: JSON.stringify({ revisionNumber }) },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice(tr('editor.notice.revisionPublished', { revision: revisionNumber }));
    } catch (revisionError) {
      setError(failure(revisionError, tr('error.publishFailed')));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <main className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tr('editor.loading')}
      </main>
    );
  }

  return (
    <main className="w-full space-y-5">
      <PageHeader
        backHref={listHref}
        backLabel={tr('editor.backToList', { kind: label })}
        title={
          id ? tr('editor.title.edit', { kind: label }) : tr('editor.title.new', { kind: label })
        }
        actions={
          <>
            {id ? (
              <Button variant="outline" onClick={() => void loadRevisions()} className="gap-1.5">
                <History className="size-4" />
                {tr('editor.revisions')}
              </Button>
            ) : null}
            {published ? (
              <Button variant="outline" onClick={() => void unpublishNow()} disabled={saving}>
                {tr('editor.unpublish')}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void save()} disabled={saving}>
              {tr('editor.saveDraft')}
            </Button>
            <Button
              onClick={() => void (status === 'scheduled' ? save() : publishNow())}
              disabled={saving}
              className="gap-1.5"
            >
              {status === 'scheduled' ? <Clock className="size-4" /> : <Send className="size-4" />}
              {status === 'scheduled' ? tr('editor.saveScheduled') : tr('editor.publish')}
            </Button>
          </>
        }
      />

      <ErrorBanner message={error} />
      {notice ? (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="flex items-center gap-1 border-b">
            <TabButton
              active={tab === 'write'}
              onClick={() => setTab('write')}
              icon={<Pencil className="size-3.5" />}
            >
              {tr('editor.tab.write')}
            </TabButton>
            <TabButton
              active={tab === 'preview'}
              onClick={() => setTab('preview')}
              icon={<Eye className="size-3.5" />}
            >
              {tr('editor.tab.preview')}
            </TabButton>
            {id ? (
              <TabButton
                active={tab === 'history'}
                onClick={() => void loadRevisions()}
                icon={<History className="size-3.5" />}
              >
                {tr('editor.tab.history')}
              </TabButton>
            ) : null}
          </div>

          {tab === 'write' ? (
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={tr('editor.bodyPlaceholder')}
              spellCheck={false}
              aria-label={tr('editor.bodyAria')}
              className="min-h-[28rem] w-full resize-y rounded-2xl border bg-card p-4 font-mono text-sm leading-6 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          ) : null}

          {tab === 'preview' ? (
            <div className="min-h-[28rem] rounded-2xl border bg-card p-6">
              {body.trim() ? (
                renderMarkdown(body)
              ) : (
                <p className="text-sm text-muted-foreground">{tr('editor.previewEmpty')}</p>
              )}
            </div>
          ) : null}

          {tab === 'history' ? (
            <HistoryPanel
              revisions={revisions}
              onPublish={publishRevision}
              busy={saving}
              current={status === 'published'}
              tr={tr}
            />
          ) : null}
        </div>

        <aside className="space-y-4">
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <SectionTitle>{tr('editor.sectionBasic')}</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-title">{tr('editor.field.title')}</Label>
              <Input
                id="cms-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (!slugTouched) setSlug(slugify(event.target.value));
                }}
                placeholder={tr('editor.field.titlePlaceholder', { kind: label })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cms-slug">slug</Label>
              <Input
                id="cms-slug"
                value={slug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value);
                }}
                onBlur={() => setSlug((current) => slugify(current))}
                placeholder="lowercase-with-hyphens"
              />
              <p className="text-xs text-muted-foreground">{tr('editor.field.slugHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cms-excerpt">{tr('editor.field.excerpt')}</Label>
              <textarea
                id="cms-excerpt"
                value={excerpt}
                onChange={(event) => setExcerpt(event.target.value)}
                rows={3}
                placeholder={tr('editor.field.excerptPlaceholder')}
                className="w-full resize-y rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <SectionTitle>{tr('editor.sectionPublish')}</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-status">{tr('editor.field.status')}</Label>
              <Select
                id="cms-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="draft">{tr('editor.status.draft')}</option>
                <option value="scheduled">{tr('editor.status.scheduled')}</option>
              </Select>
              {published ? (
                <p className="text-xs text-muted-foreground">{tr('editor.publishedHint')}</p>
              ) : null}
            </div>
            {status === 'scheduled' ? (
              <div className="space-y-1.5">
                <Label htmlFor="cms-publish-at">{tr('editor.field.publishAt')}</Label>
                <Input
                  id="cms-publish-at"
                  type="datetime-local"
                  value={publishAt}
                  onChange={(event) => setPublishAt(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <SectionTitle>{tr('editor.sectionLocale')}</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-locale">{tr('editor.field.locale')}</Label>
              <Input
                id="cms-locale"
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
                placeholder={tr('editor.field.localePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cms-translation">{tr('editor.field.translation')}</Label>
              <Input
                id="cms-translation"
                value={translationKey}
                onChange={(event) => setTranslationKey(event.target.value)}
                placeholder={tr('editor.field.translationPlaceholder')}
              />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function HistoryPanel({
  revisions,
  onPublish,
  busy,
  current,
  tr,
}: {
  revisions: CmsRevisionList | null;
  onPublish: (revisionNumber: number) => void;
  busy: boolean;
  current: boolean;
  tr: Translate;
}): ReactElement {
  if (!revisions) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {tr('history.loading')}
      </div>
    );
  }
  if (revisions.items.length === 0) {
    return <p className="py-8 text-sm text-muted-foreground">{tr('history.empty')}</p>;
  }
  return (
    <ol className="space-y-2">
      {revisions.items.map((revision) => (
        <li
          key={revision.id}
          className="flex items-start justify-between gap-4 rounded-2xl border bg-card p-4"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">r{revision.revisionNumber}</span>
              <span className="truncate text-sm">{revision.title}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {revision.note ? `${revision.note} · ` : ''}
              {formatDateTime(revision.createdAt)}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onPublish(revision.revisionNumber)}
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            {tr('history.publish')}
          </Button>
        </li>
      ))}
      {!current ? <p className="pt-2 text-xs text-muted-foreground">{tr('history.hint')}</p> : null}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

function RedirectsPage({
  initial,
  locale,
}: {
  initial: CmsRedirectList | null;
  locale?: string;
}): ReactElement {
  const tr = t(locale);
  const [items, setItems] = useState<CmsRedirectList | null>(initial);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(
    async (nextPage: number): Promise<void> => {
      setError(null);
      try {
        setItems(
          await bff<CmsRedirectList>(`/cms/admin/redirects?page=${nextPage}&pageSize=20`, tr),
        );
      } catch (loadError) {
        setError(failure(loadError, tr('error.loadFailed')));
      }
    },
    [tr],
  );

  useEffect(() => {
    void reload(page);
  }, [page, reload]);

  async function remove(id: string): Promise<void> {
    setPending(id);
    setError(null);
    try {
      await bff(`/cms/admin/redirects/${encodeURIComponent(id)}`, tr, {
        method: 'DELETE',
      });
      await reload(page);
    } catch (deleteError) {
      setError(failure(deleteError, tr('error.deleteFailed')));
    } finally {
      setPending(null);
    }
  }

  const rows: CmsRedirect[] = items?.items ?? [];

  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('redirects.title')} />
      <ErrorBanner message={error} />
      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{tr('redirects.colFrom')}</th>
                <th className="px-4 py-2.5 font-medium">{tr('redirects.colKind')}</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">
                  {tr('redirects.colCreatedAt')}
                </th>
                <th className="px-4 py-2.5 text-right font-medium">{tr('redirects.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-mono text-xs">{row.fromPath}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {tr(row.resourceKind === 'cms/post' ? 'kind.post' : 'kind.page')}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right text-xs text-muted-foreground sm:table-cell">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={pending === row.id}
                      onClick={() => void remove(row.id)}
                      aria-label={tr('row.delete')}
                      title={tr('row.delete')}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text={tr('redirects.empty')} />
      )}
      {items ? (
        <Pager
          page={items.page}
          pageSize={items.pageSize}
          total={items.total}
          onPage={setPage}
          tr={tr}
        />
      ) : null}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Route components                                                    */
/* ------------------------------------------------------------------ */

function asList(value: unknown): CmsList | null {
  return value && typeof value === 'object' && Array.isArray((value as CmsList).items)
    ? (value as CmsList)
    : null;
}

function PostsPage(props: AdminPageComponentProps): ReactElement {
  return <ContentListPage kind="post" initial={asList(props.data.list)} locale={props.locale} />;
}

function PagesPage(props: AdminPageComponentProps): ReactElement {
  return <ContentListPage kind="page" initial={asList(props.data.list)} locale={props.locale} />;
}

function NewPostPage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="post" id={null} uiLocale={props.locale} />;
}

function EditPostPage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="post" id={props.params['id'] ?? null} uiLocale={props.locale} />;
}

function NewPagePage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="page" id={null} uiLocale={props.locale} />;
}

function EditPagePage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="page" id={props.params['id'] ?? null} uiLocale={props.locale} />;
}

function RedirectsRoute(props: AdminPageComponentProps): ReactElement {
  const value = props.data.list;
  const initial =
    value && typeof value === 'object' && Array.isArray((value as CmsRedirectList).items)
      ? (value as CmsRedirectList)
      : null;
  return <RedirectsPage initial={initial} locale={props.locale} />;
}

/** Component ids referenced by `adminRoutes` in `index.tsx`. */
function CmsOverview(props: import('@stackpanel/sdk').AdminPageComponentProps) {
  const tr = t(props.locale);
  type ContentList = {
    total: number;
    items: Array<{ id: string; title: string; published?: boolean }>;
  };
  const posts = props.data.posts as ContentList | undefined;
  const pages = props.data.pages as ContentList | undefined;
  const redirects = props.data.redirects as { total: number } | undefined;
  return (
    <FeatureOverview
      title={tr('overview.title')}
      description={tr('overview.description')}
      unavailable={!posts || !pages || !redirects}
      metrics={[
        { label: tr('overview.posts'), value: posts?.total ?? '—' },
        { label: tr('overview.pages'), value: pages?.total ?? '—' },
        { label: tr('overview.redirects'), value: redirects?.total ?? '—' },
      ]}
      links={[
        {
          label: tr('overview.posts'),
          description: tr('overview.postsLink'),
          href: '/admin/plugin/cms/posts',
        },
        {
          label: tr('overview.pages'),
          description: tr('overview.pagesLink'),
          href: '/admin/plugin/cms/pages',
        },
        {
          label: tr('overview.redirects'),
          description: tr('overview.redirectsLink'),
          href: '/admin/plugin/cms/redirects',
        },
      ]}
      activity={{
        title: tr('overview.recent'),
        items: (posts?.items ?? []).slice(0, 5).map((item) => ({
          label: item.title,
          detail: tr(item.published ? 'status.published' : 'status.draft'),
          href: `/admin/plugin/cms/posts/${item.id}`,
        })),
      }}
    />
  );
}

export const adminPages = {
  'admin/summary': CmsOverview,
  'admin/posts': PostsPage,
  'admin/pages': PagesPage,
  'admin/post-new': NewPostPage,
  'admin/post-edit': EditPostPage,
  'admin/page-new': NewPagePage,
  'admin/page-edit': EditPagePage,
  'admin/redirects': RedirectsRoute,
} as const;
