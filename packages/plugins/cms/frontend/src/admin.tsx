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
  kindLabel,
  listQuery,
  readErrorMessage,
  slugify,
  statusMeta,
} from './shared.js';

/* ------------------------------------------------------------------ */
/* BFF client                                                          */
/* ------------------------------------------------------------------ */

async function bff<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CMS_API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function fetchList(
  kind: CmsKind,
  params: { status: string; q: string; page: number },
): Promise<CmsList> {
  return bff<CmsList>(`/cms/admin/content/${kind}?${listQuery(params)}`);
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function StatusPill({ status }: { status: string }): ReactElement {
  const meta = statusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
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
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}): ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">
        共 {total} 条 · 第 {page} / {pages} 页
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
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
): Promise<void> {
  await bff(`/cms/admin/content/${kind}/${encodeURIComponent(id)}/${op}`, {
    method: 'POST',
  });
}

async function removeContent(kind: CmsKind, id: string): Promise<void> {
  await bff(`/cms/admin/content/${kind}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/* ------------------------------------------------------------------ */
/* Content list (posts / pages)                                        */
/* ------------------------------------------------------------------ */

interface ContentListPageProps {
  kind: CmsKind;
  initial: CmsList | null;
}

function ContentListPage({ kind, initial }: ContentListPageProps): ReactElement {
  const label = kindLabel(kind);
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
        setItems(await fetchList(kind, next));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '加载失败');
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
      await mutate(kind, id, op);
      await reload({ status, q: search.trim(), page });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
    } finally {
      setPending(null);
    }
  }

  async function runDelete(id: string): Promise<void> {
    setPending(id);
    setError(null);
    try {
      await removeContent(kind, id);
      await reload({ status, q: search.trim(), page });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '删除失败');
    } finally {
      setPending(null);
    }
  }

  const rows = items?.items ?? [];

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={label === '文章' ? '文章' : '页面'}
        actions={
          <Button
            nativeButton={false}
            render={<Link href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/new`} />}
            className="gap-1.5"
          >
            <Plus className="size-4" />
            新建{label}
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
            placeholder={`搜索${label}标题`}
            className="pl-8"
            aria-label={`搜索${label}标题`}
          />
        </div>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          className="w-36"
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="scheduled">定时</option>
          <option value="published">已发布</option>
          <option value="archived">已归档</option>
        </Select>
        {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <ErrorBanner message={error} />

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">标题</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">slug</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">语言</th>
                <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">
                  更新时间
                </th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
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
                      {item.title || '（无标题）'}
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
                    <StatusPill status={item.status} />
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                    {item.slug || '—'}
                  </td>
                  <td className="hidden px-4 py-2.5 text-muted-foreground md:table-cell">
                    {item.locale ?? '默认'}
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
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        nativeButton={false}
                        render={
                          <Link
                            href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/${item.id}`}
                            aria-label="编辑"
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
        <Empty text={`还没有${label}`}>
          <Button
            nativeButton={false}
            render={<Link href={`/admin/plugin/cms/${kind === 'post' ? 'posts' : 'pages'}/new`} />}
            className="gap-1.5"
          >
            <Plus className="size-4" />
            新建{label}
          </Button>
        </Empty>
      )}

      {items ? (
        <Pager page={items.page} pageSize={items.pageSize} total={items.total} onPage={setPage} />
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
}: {
  item: CmsContent;
  pending: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}): ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (pending) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  return (
    <>
      {item.published ? (
        <Button variant="ghost" size="icon-sm" onClick={onUnpublish} aria-label="下架" title="下架">
          <Undo2 className="size-3.5" />
        </Button>
      ) : (
        <Button variant="ghost" size="icon-sm" onClick={onPublish} aria-label="发布" title="发布">
          <Send className="size-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setConfirmDelete(true)}
        aria-label="删除"
        title="删除"
      >
        <Trash2 className="size-3.5 text-destructive" />
      </Button>
      {confirmDelete ? (
        <Dialog open onOpenChange={(open) => !open && setConfirmDelete(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除「{item.title || '（无标题）'}」？</DialogTitle>
              <DialogDescription>
                删除后内容与修订版本将移除；已发布的 slug 会保留 301 重定向。此操作不可撤销。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                确定删除
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
}

function EditorPage({ kind, id }: EditorPageProps): ReactElement {
  const label = kindLabel(kind);
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
        if (active) setError(loadError instanceof Error ? loadError.message : '加载失败');
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, kind]);

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
      setError('请填写标题');
      return null;
    }
    const finalSlug = effectiveSlug || slugify(title);
    if (!finalSlug) {
      setError(
        effectiveSlug
          ? 'slug 只能包含小写字母、数字和连字符'
          : '请填写 slug：标题没有可用于自动生成 slug 的字符',
      );
      return null;
    }
    if (status === 'scheduled' && !publishAt) {
      setError('定时发布需要选择时间');
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
        ? await bff<CmsContent>(`/cms/admin/content/${kind}/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await bff<CmsContent>(`/cms/admin/content/${kind}`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
      setStatus(saved.status);
      setPublished(saved.published);
      if (!id) {
        window.location.href = `${listHref}/${saved.id}`;
        return saved;
      }
      setNotice('已保存');
      return saved;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
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
        { method: 'POST' },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice('已发布');
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '发布失败');
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
        { method: 'POST' },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice('已下架');
    } catch (unpublishError) {
      setError(unpublishError instanceof Error ? unpublishError.message : '下架失败');
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
        ),
      );
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : '版本加载失败');
    }
  }

  async function publishRevision(revisionNumber: number): Promise<void> {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bff<CmsContent>(
        `/cms/admin/content/${kind}/${encodeURIComponent(id)}/publish`,
        { method: 'POST', body: JSON.stringify({ revisionNumber }) },
      );
      setStatus(result.status);
      setPublished(result.published);
      setNotice(`已发布版本 r${revisionNumber}`);
    } catch (revisionError) {
      setError(revisionError instanceof Error ? revisionError.message : '发布失败');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return (
      <main className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载中…
      </main>
    );
  }

  return (
    <main className="w-full space-y-5">
      <PageHeader
        backHref={listHref}
        backLabel={`返回${label}列表`}
        title={id ? `编辑${label}` : `新建${label}`}
        actions={
          <>
            {id ? (
              <Button variant="outline" onClick={() => void loadRevisions()} className="gap-1.5">
                <History className="size-4" />
                版本
              </Button>
            ) : null}
            {published ? (
              <Button variant="outline" onClick={() => void unpublishNow()} disabled={saving}>
                下架
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void save()} disabled={saving}>
              保存草稿
            </Button>
            <Button
              onClick={() => void (status === 'scheduled' ? save() : publishNow())}
              disabled={saving}
              className="gap-1.5"
            >
              {status === 'scheduled' ? <Clock className="size-4" /> : <Send className="size-4" />}
              {status === 'scheduled' ? '保存定时' : '发布'}
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
              编写
            </TabButton>
            <TabButton
              active={tab === 'preview'}
              onClick={() => setTab('preview')}
              icon={<Eye className="size-3.5" />}
            >
              预览
            </TabButton>
            {id ? (
              <TabButton
                active={tab === 'history'}
                onClick={() => void loadRevisions()}
                icon={<History className="size-3.5" />}
              >
                版本历史
              </TabButton>
            ) : null}
          </div>

          {tab === 'write' ? (
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="用 Markdown 撰写正文…"
              spellCheck={false}
              aria-label="正文"
              className="min-h-[28rem] w-full resize-y rounded-2xl border bg-card p-4 font-mono text-sm leading-6 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          ) : null}

          {tab === 'preview' ? (
            <div className="min-h-[28rem] rounded-2xl border bg-card p-6">
              {body.trim() ? (
                renderMarkdown(body)
              ) : (
                <p className="text-sm text-muted-foreground">还没有内容，切换到「编写」开始。</p>
              )}
            </div>
          ) : null}

          {tab === 'history' ? (
            <HistoryPanel
              revisions={revisions}
              onPublish={publishRevision}
              busy={saving}
              current={status === 'published'}
            />
          ) : null}
        </div>

        <aside className="space-y-4">
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <SectionTitle>基础</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-title">标题</Label>
              <Input
                id="cms-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (!slugTouched) setSlug(slugify(event.target.value));
                }}
                placeholder={`${label}标题`}
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
              <p className="text-xs text-muted-foreground">仅小写字母、数字和连字符。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cms-excerpt">摘要</Label>
              <textarea
                id="cms-excerpt"
                value={excerpt}
                onChange={(event) => setExcerpt(event.target.value)}
                rows={3}
                placeholder="列表与 SEO 使用的简短描述"
                className="w-full resize-y rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <SectionTitle>发布</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-status">状态</Label>
              <Select
                id="cms-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="draft">草稿</option>
                <option value="scheduled">定时发布</option>
              </Select>
              {published ? (
                <p className="text-xs text-muted-foreground">当前已发布；保存不会改动线上内容。</p>
              ) : null}
            </div>
            {status === 'scheduled' ? (
              <div className="space-y-1.5">
                <Label htmlFor="cms-publish-at">发布时间</Label>
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
            <SectionTitle>多语言</SectionTitle>
            <div className="space-y-1.5">
              <Label htmlFor="cms-locale">语言</Label>
              <Input
                id="cms-locale"
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
                placeholder="zh-CN（留空为默认）"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cms-translation">翻译分组</Label>
              <Input
                id="cms-translation"
                value={translationKey}
                onChange={(event) => setTranslationKey(event.target.value)}
                placeholder="同一内容的多语言共用"
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
}: {
  revisions: CmsRevisionList | null;
  onPublish: (revisionNumber: number) => void;
  busy: boolean;
  current: boolean;
}): ReactElement {
  if (!revisions) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载版本…
      </div>
    );
  }
  if (revisions.items.length === 0) {
    return <p className="py-8 text-sm text-muted-foreground">还没有修订版本。</p>;
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
            发布此版本
          </Button>
        </li>
      ))}
      {!current ? (
        <p className="pt-2 text-xs text-muted-foreground">
          提示：发布某个版本会把该版本内容设为线上内容。
        </p>
      ) : null}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

function RedirectsPage({ initial }: { initial: CmsRedirectList | null }): ReactElement {
  const [items, setItems] = useState<CmsRedirectList | null>(initial);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(async (nextPage: number): Promise<void> => {
    setError(null);
    try {
      setItems(await bff<CmsRedirectList>(`/cms/admin/redirects?page=${nextPage}&pageSize=20`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload(page);
  }, [page, reload]);

  async function remove(id: string): Promise<void> {
    setPending(id);
    setError(null);
    try {
      await bff(`/cms/admin/redirects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await reload(page);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setPending(null);
    }
  }

  const rows: CmsRedirect[] = items?.items ?? [];

  return (
    <main className="w-full space-y-6">
      <PageHeader title="重定向" />
      <ErrorBanner message={error} />
      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">原路径</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">
                  创建时间
                </th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5 font-mono text-xs">{row.fromPath}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {row.resourceKind === 'cms/post' ? '文章' : '页面'}
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
                      aria-label="删除"
                      title="删除"
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
        <Empty text="还没有重定向记录。" />
      )}
      {items ? (
        <Pager page={items.page} pageSize={items.pageSize} total={items.total} onPage={setPage} />
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
  return <ContentListPage kind="post" initial={asList(props.data.list)} />;
}

function PagesPage(props: AdminPageComponentProps): ReactElement {
  return <ContentListPage kind="page" initial={asList(props.data.list)} />;
}

function NewPostPage(): ReactElement {
  return <EditorPage kind="post" id={null} />;
}

function EditPostPage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="post" id={props.params['id'] ?? null} />;
}

function NewPagePage(): ReactElement {
  return <EditorPage kind="page" id={null} />;
}

function EditPagePage(props: AdminPageComponentProps): ReactElement {
  return <EditorPage kind="page" id={props.params['id'] ?? null} />;
}

function RedirectsRoute(props: AdminPageComponentProps): ReactElement {
  const value = props.data.list;
  const initial =
    value && typeof value === 'object' && Array.isArray((value as CmsRedirectList).items)
      ? (value as CmsRedirectList)
      : null;
  return <RedirectsPage initial={initial} />;
}

/** Component ids referenced by `adminRoutes` in `index.tsx`. */
function CmsOverview(props: import('@stackpanel/sdk').AdminPageComponentProps) {
  type ContentList = {
    total: number;
    items: Array<{ id: string; title: string; published?: boolean }>;
  };
  const posts = props.data.posts as ContentList | undefined;
  const pages = props.data.pages as ContentList | undefined;
  const redirects = props.data.redirects as { total: number } | undefined;
  return (
    <FeatureOverview
      title="概览"
      description="管理站点内容与访问路径。"
      unavailable={!posts || !pages || !redirects}
      metrics={[
        { label: '文章', value: posts?.total ?? '—' },
        { label: '页面', value: pages?.total ?? '—' },
        { label: '重定向', value: redirects?.total ?? '—' },
      ]}
      links={[
        {
          label: '文章',
          description: '撰写与发布文章。',
          href: '/admin/plugin/cms/posts',
        },
        {
          label: '页面',
          description: '维护站点独立页面。',
          href: '/admin/plugin/cms/pages',
        },
        {
          label: '重定向',
          description: '管理内容迁移后的访问路径。',
          href: '/admin/plugin/cms/redirects',
        },
      ]}
      activity={{
        title: '最近文章',
        items: (posts?.items ?? []).slice(0, 5).map((item) => ({
          label: item.title,
          detail: item.published ? '已发布' : '草稿',
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
