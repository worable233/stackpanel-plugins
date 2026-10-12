import { describe, expect, it, vi } from 'vitest';
import { CONTENT_KINDS } from './models.js';
import { createCmsSeoProvider } from './seo.js';
import type { ContentWorkflow, LiveContent } from './workflow.js';

/** Build a live-content fixture with sensible defaults. */
function live(overrides: Partial<LiveContent> = {}): LiveContent {
  const kind = overrides.kind ?? CONTENT_KINDS.post;
  const slug = overrides.slug ?? 'hello';
  return {
    kind,
    id: overrides.id ?? `${kind}:${slug}`,
    slug,
    path: kind === CONTENT_KINDS.post ? `/blog/${slug}` : `/${slug}`,
    title: overrides.title ?? `标题 ${slug}`,
    excerpt: overrides.excerpt ?? `摘要 ${slug}`,
    body: overrides.body ?? `<p>正文 ${slug}</p>`,
    authorId: overrides.authorId ?? null,
    publishedAt: overrides.publishedAt ?? null,
    updatedAt: overrides.updatedAt ?? '2026-01-02T00:00:00.000Z',
    revisionNumber: overrides.revisionNumber ?? 1,
    locale: overrides.locale ?? null,
    translationKey: overrides.translationKey ?? null,
  };
}

/** Minimal fake of the parts of `ContentWorkflow` the SEO provider uses. */
function fakeWorkflow(overrides: {
  all?: Record<string, LiveContent[]>;
  bySlug?: Record<string, LiveContent | null>;
  translations?: Record<string, LiveContent[]>;
}): ContentWorkflow {
  return {
    listAllPublished: vi.fn(async (kind: string) => overrides.all?.[kind] ?? []),
    getPublishedBySlug: vi.fn(
      async (kind: string, slug: string) => overrides.bySlug?.[`${kind}:${slug}`] ?? null,
    ),
    translations: vi.fn(
      async (kind: string, slug: string) => overrides.translations?.[`${kind}:${slug}`] ?? [],
    ),
  } as unknown as ContentWorkflow;
}

describe('cms seo provider', () => {
  it('lists published posts and pages under their public paths', async () => {
    const workflow = fakeWorkflow({
      all: {
        [CONTENT_KINDS.post]: [live({ slug: 'b-post' }), live({ slug: 'a-post' })],
        [CONTENT_KINDS.page]: [live({ kind: CONTENT_KINDS.page, slug: 'about' })],
      },
    });
    const provider = createCmsSeoProvider(workflow);
    const { entries, total } = await provider.listEntries({ page: 1, pageSize: 50 });
    expect(total).toBe(3);
    expect(entries.map((entry) => entry.url)).toEqual(['/about', '/blog/a-post', '/blog/b-post']);
    expect(entries[1]?.changeFrequency).toBe('weekly');
    expect(entries[0]?.changeFrequency).toBe('monthly');
  });

  it('pages deterministically', async () => {
    const workflow = fakeWorkflow({
      all: {
        [CONTENT_KINDS.post]: [live({ slug: 'a' }), live({ slug: 'b' }), live({ slug: 'c' })],
      },
    });
    const provider = createCmsSeoProvider(workflow);
    const first = await provider.listEntries({ page: 1, pageSize: 2 });
    const second = await provider.listEntries({ page: 2, pageSize: 2 });
    expect(first.entries.map((e) => e.url)).toEqual(['/blog/a', '/blog/b']);
    expect(first.total).toBe(3);
    expect(second.entries.map((e) => e.url)).toEqual(['/blog/c']);
  });

  it('groups hreflang alternates by translationKey with an x-default fallback', async () => {
    const zh = live({ slug: 'zh-post', locale: 'zh-CN', translationKey: 'tk-1' });
    const en = live({ slug: 'en-post', locale: 'en-US', translationKey: 'tk-1' });
    const workflow = fakeWorkflow({ all: { [CONTENT_KINDS.post]: [zh, en] } });
    const provider = createCmsSeoProvider(workflow);
    const { entries } = await provider.listEntries({ page: 1, pageSize: 50 });
    const zhEntry = entries.find((entry) => entry.url === '/blog/zh-post');
    expect(zhEntry?.alternates).toEqual([
      { hreflang: 'en-US', href: '/blog/en-post' },
      { hreflang: 'x-default', href: '/blog/zh-post' },
      { hreflang: 'zh-CN', href: '/blog/zh-post' },
    ]);
  });

  it('orders the feed newest first and maps post fields', async () => {
    const workflow = fakeWorkflow({
      all: {
        [CONTENT_KINDS.post]: [
          live({ slug: 'old', updatedAt: '2026-01-01T00:00:00.000Z', authorId: 'u1' }),
          live({ slug: 'new', updatedAt: '2026-03-01T00:00:00.000Z' }),
        ],
      },
    });
    const provider = createCmsSeoProvider(workflow);
    const { entries } = await provider.listFeed!({ page: 1, pageSize: 50 });
    expect(entries.map((entry) => entry.url)).toEqual(['/blog/new', '/blog/old']);
    expect(entries[1]?.author).toBe('u1');
    expect(entries[0]?.content).toBe('<p>正文 new</p>');
  });

  it('resolves entity metadata for a post path', async () => {
    const post = live({ slug: 'meta-post', title: '元数据', excerpt: '摘要' });
    const workflow = fakeWorkflow({ bySlug: { [`${CONTENT_KINDS.post}:meta-post`]: post } });
    const provider = createCmsSeoProvider(workflow);
    const meta = await provider.resolveMeta!({ path: '/blog/meta-post', params: {} });
    expect(meta?.title).toBe('元数据');
    expect(meta?.description).toBe('摘要');
    expect(meta?.canonical).toBe('/blog/meta-post');
    expect(meta?.jsonLd).toMatchObject({ '@type': 'BlogPosting', headline: '元数据' });
  });

  it('resolves a root-level page path but never a nested unknown path', async () => {
    const page = live({ kind: CONTENT_KINDS.page, slug: 'about' });
    const workflow = fakeWorkflow({ bySlug: { [`${CONTENT_KINDS.page}:about`]: page } });
    const provider = createCmsSeoProvider(workflow);
    expect((await provider.resolveMeta!({ path: '/about', params: {} }))?.title).toBe(page.title);
    expect(await provider.resolveMeta!({ path: '/a/b', params: {} })).toBeNull();
    expect(await provider.resolveMeta!({ path: '/', params: {} })).toBeNull();
  });

  it('returns null metadata for content that is not published', async () => {
    const workflow = fakeWorkflow({ bySlug: {} });
    const provider = createCmsSeoProvider(workflow);
    expect(await provider.resolveMeta!({ path: '/blog/missing', params: {} })).toBeNull();
  });
});
