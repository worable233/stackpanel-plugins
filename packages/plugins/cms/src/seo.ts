import type {
  SeoAlternate,
  SeoEntityMeta,
  SeoFeedEntry,
  SeoProvider,
  SeoUrlEntry,
} from '@stackpanel/sdk';
import { CONTENT_KINDS } from './models.js';
import {
  DEFAULT_CONTENT_LOCALE,
  contentPath,
  type ContentWorkflow,
  type LiveContent,
} from './workflow.js';

/**
 * CMS 的 `seo.provider` 实现（ADR-0011 实施顺序 §7 样板）。
 *
 * 内容归属与公开 URL 语义由内容拥有者决定：本 provider 只暴露**已发布**
 * 文章/页面的站点相对路径、更新时间与跨语言替代链接；平台负责聚合与输出。
 * 零裸 DB —— 一切经 `ContentWorkflow`（扩展引擎）。
 */

/** 按 `translationKey` 把同种内容的各语言版本归组，供 hreflang 使用。 */
function groupTranslations(items: LiveContent[]): Map<string, LiveContent[]> {
  const groups = new Map<string, LiveContent[]>();
  for (const item of items) {
    const key = item.translationKey;
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  return groups;
}

/** 构建某条内容的 hreflang 替代链接（含自身；`x-default` 指向默认内容语言）。 */
function buildAlternates(item: LiveContent, groups: Map<string, LiveContent[]>): SeoAlternate[] {
  const siblings = item.translationKey ? (groups.get(item.translationKey) ?? [item]) : [item];
  const alternates: SeoAlternate[] = siblings
    .filter((entry) => entry.slug)
    .map((entry) => ({
      hreflang: entry.locale ?? DEFAULT_CONTENT_LOCALE,
      href: contentPath(entry.kind, entry.slug),
    }));
  // x-default：站点默认内容语言的版本，缺失时退回自身。
  const fallback =
    siblings.find((entry) => (entry.locale ?? DEFAULT_CONTENT_LOCALE) === DEFAULT_CONTENT_LOCALE) ??
    item;
  if (fallback.slug) {
    alternates.push({
      hreflang: 'x-default',
      href: contentPath(fallback.kind, fallback.slug),
    });
  }
  // 稳定排序：先语言标签，再 URL。
  return alternates.sort(
    (a, b) => a.hreflang.localeCompare(b.hreflang) || a.href.localeCompare(b.href),
  );
}

function toUrlEntry(item: LiveContent, groups: Map<string, LiveContent[]>): SeoUrlEntry {
  return {
    url: contentPath(item.kind, item.slug),
    lastModified: item.updatedAt,
    changeFrequency: item.kind === CONTENT_KINDS.post ? 'weekly' : 'monthly',
    alternates: buildAlternates(item, groups),
  };
}

/** 已发布文章 + 页面，按路径稳定排序。 */
async function allPublishedEntries(workflow: ContentWorkflow): Promise<LiveContent[]> {
  const [posts, pages] = await Promise.all([
    workflow.listAllPublished(CONTENT_KINDS.post),
    workflow.listAllPublished(CONTENT_KINDS.page),
  ]);
  return [...posts, ...pages]
    .filter((item) => item.slug)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 从站点路径解析出内容类型与 slug：`/blog/:slug` → post，`/:slug` → page。 */
function parseContentPath(path: string): { kind: string; slug: string } | null {
  const clean = path.replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === 'blog' && segments.length === 2) {
    return { kind: CONTENT_KINDS.post, slug: segments[1] as string };
  }
  if (segments.length === 1) {
    return { kind: CONTENT_KINDS.page, slug: segments[0] as string };
  }
  return null;
}

/** 由激活中的 {@link ContentWorkflow} 构建 provider；未激活时返回 `null`。 */
export function createCmsSeoProvider(workflow: ContentWorkflow): SeoProvider {
  return {
    id: 'cms',
    async listEntries({ page, pageSize }) {
      const items = await allPublishedEntries(workflow);
      const groups = groupTranslations(items);
      const entries = items.map((item) => toUrlEntry(item, groups));
      const start = (page - 1) * pageSize;
      return { entries: entries.slice(start, start + pageSize), total: entries.length };
    },
    async listFeed({ page, pageSize }) {
      const posts = (await workflow.listAllPublished(CONTENT_KINDS.post))
        .filter((item) => item.slug)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const entries: SeoFeedEntry[] = posts.map((post) => ({
        url: contentPath(post.kind, post.slug),
        title: post.title,
        updated: post.updatedAt,
        summary: post.excerpt,
        content: post.body,
        ...(post.authorId ? { author: post.authorId } : {}),
      }));
      const start = (page - 1) * pageSize;
      return { entries: entries.slice(start, start + pageSize), total: entries.length };
    },
    async resolveMeta({ path }) {
      const parsed = parseContentPath(path);
      if (!parsed) return null;
      const item = await workflow.getPublishedBySlug(parsed.kind, parsed.slug);
      if (!item) return null;
      const siblings = item.translationKey
        ? await workflow.translations(parsed.kind, parsed.slug)
        : [item];
      const groups = groupTranslations(siblings);
      const alternates = buildAlternates(item, groups);
      const meta: SeoEntityMeta = {
        title: item.title,
        ...(item.excerpt ? { description: item.excerpt } : {}),
        canonical: contentPath(item.kind, item.slug),
        alternates,
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': item.kind === CONTENT_KINDS.post ? 'BlogPosting' : 'WebPage',
          headline: item.title,
          ...(item.excerpt ? { description: item.excerpt } : {}),
          ...(item.locale ? { inLanguage: item.locale } : {}),
          ...(item.authorId ? { author: { '@type': 'Person', name: item.authorId } } : {}),
        },
      };
      return meta;
    },
  };
}
