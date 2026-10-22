import { ArticleBody, ErrorPage } from '@stackpanel/ui';
import type { FinderProvider, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import { z } from 'zod';
import type { CmsKind } from './shared.js';
import { messages } from './i18n.js';

/**
 * CMS admin console — server-side finders and route/action declarations.
 *
 * The kernel renders an admin page by resolving its `adminRoutes` entry, running
 * the declared finders (server-side data providers), and mounting the matching
 * client component from `admin.tsx`. Interactive mutations that the platform
 * must audit flow through declared `actions`; read/write list operations that
 * carry arbitrary text (title/body) go straight to the authenticated BFF from
 * the client component.
 */

const contentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  published: z.boolean(),
  slug: z.string(),
  publishedSlug: z.string().nullable(),
  title: z.string(),
  excerpt: z.string(),
  body: z.string(),
  authorId: z.string().nullable(),
  publishAt: z.number().nullable(),
  locale: z.string().nullable(),
  translationKey: z.string().nullable(),
  currentRevisionNumber: z.number(),
  publishedRevisionNumber: z.number(),
  path: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listSchema = z.object({
  items: z.array(contentSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const redirectSchema = z.object({
  id: z.string(),
  fromPath: z.string(),
  resourceKind: z.string(),
  resourceId: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
});

const redirectListSchema = z.object({
  items: z.array(redirectSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

function selectInput(input: Record<string, unknown>): {
  status: string;
  q: string;
  page: string;
  pageSize: string;
} {
  const page = Number(input.page);
  const pageSize = Number(input.pageSize);
  return {
    status: typeof input.status === 'string' ? input.status : '',
    q: typeof input.q === 'string' ? input.q.trim() : '',
    page: String(Number.isInteger(page) && page > 0 ? page : 1),
    pageSize: String(Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20),
  };
}

function adminListFinder(kind: CmsKind): FinderProvider {
  return {
    handler: async (input, ctx) => {
      const { status, q, page, pageSize } = selectInput(input);
      const search = new URLSearchParams();
      if (status) search.set('status', status);
      if (q) search.set('q', q);
      search.set('page', page);
      search.set('pageSize', pageSize);
      return ctx.api.get(`/cms/admin/content/${kind}?${search.toString()}`, listSchema);
    },
  };
}

const postSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  body: z.string(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});

function PublicArticle(props: FrontendPageProps) {
  const result = props.data.article as
    { post?: z.infer<typeof postSchema>; missing?: boolean } | undefined;
  if (!result?.post) return <ErrorPage kind={result?.missing ? 'not-found' : 'server-error'} />;
  return (
    <article className="mx-auto max-w-3xl px-6 py-32">
      <h1 className="mb-8 text-4xl font-semibold">{result.post.title}</h1>
      <ArticleBody body={result.post.body} />
    </article>
  );
}

const cmsFinders: Record<string, FinderProvider> = {
  'cms.publicPost': {
    handler: async (input, ctx) => {
      try {
        return {
          post: await ctx.api.get(
            `/cms/posts/${encodeURIComponent(String(input.slug ?? ''))}`,
            postSchema,
          ),
        };
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404)
          return { missing: true };
        throw error;
      }
    },
  },
  'cms.adminPosts': adminListFinder('post'),
  'cms.adminPages': adminListFinder('page'),
  'cms.adminRedirects': {
    handler: async (input, ctx) => {
      const page = Number(input.page);
      const pageSize = Number(input.pageSize);
      const search = new URLSearchParams();
      search.set('page', String(Number.isInteger(page) && page > 0 ? page : 1));
      search.set(
        'pageSize',
        String(Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20),
      );
      return ctx.api.get(`/cms/admin/redirects?${search.toString()}`, redirectListSchema);
    },
  },
};

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  finders: cmsFinders,
  pages: [
    {
      path: '/blog/:slug',
      component: 'article',
      data: [{ finder: 'cms.publicPost', as: 'article', input: { slug: ':slug' } }],
    },
  ],
  pageComponents: { article: PublicArticle },
  ui: {
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/summary',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        data: [
          { finder: 'cms.adminPosts', as: 'posts' },
          { finder: 'cms.adminPages', as: 'pages' },
          { finder: 'cms.adminRedirects', as: 'redirects' },
        ],
      },
      {
        path: '/posts',
        component: 'admin/posts',
        data: [{ finder: 'cms.adminPosts', as: 'list' }],
        nav: { labelKey: 'nav.posts', groupKey: 'nav.group', order: 10 },
      },
      {
        path: '/pages',
        component: 'admin/pages',
        data: [{ finder: 'cms.adminPages', as: 'list' }],
        nav: { labelKey: 'nav.pages', groupKey: 'nav.group', order: 20 },
      },
      {
        path: '/redirects',
        component: 'admin/redirects',
        data: [{ finder: 'cms.adminRedirects', as: 'list' }],
        nav: { labelKey: 'nav.redirects', groupKey: 'nav.group', order: 30 },
      },
      // `/new` must precede `/:id` so it is not captured as an id.
      { path: '/posts/new', component: 'admin/post-new' },
      { path: '/pages/new', component: 'admin/page-new' },
      { path: '/posts/:id', component: 'admin/post-edit' },
      { path: '/pages/:id', component: 'admin/page-edit' },
    ],
  },
};

export default frontend;
