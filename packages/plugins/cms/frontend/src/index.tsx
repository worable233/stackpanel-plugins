import type { FinderProvider, FrontendPackage } from '@stackpanel/sdk';
import { z } from 'zod';
import type { CmsKind } from './shared.js';

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

function selectInput(input: Record<string, unknown>): { status: string; q: string; page: string; pageSize: string } {
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

const cmsFinders: Record<string, FinderProvider> = {
  'cms.adminPosts': adminListFinder('post'),
  'cms.adminPages': adminListFinder('page'),
  'cms.adminRedirects': {
    handler: async (input, ctx) => {
      const page = Number(input.page);
      const pageSize = Number(input.pageSize);
      const search = new URLSearchParams();
      search.set('page', String(Number.isInteger(page) && page > 0 ? page : 1));
      search.set('pageSize', String(Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20));
      return ctx.api.get(`/cms/admin/redirects?${search.toString()}`, redirectListSchema);
    },
  },
};

export const frontend: FrontendPackage = {
  finders: cmsFinders,
  ui: {
    adminRoutes: [
      {
        path: '/posts',
        component: 'admin/posts',
        data: [{ finder: 'cms.adminPosts', as: 'list' }],
        nav: { label: '内容管理 · 文章', group: 'CMS' },
      },
      {
        path: '/pages',
        component: 'admin/pages',
        data: [{ finder: 'cms.adminPages', as: 'list' }],
        nav: { label: '内容管理 · 页面', group: 'CMS' },
      },
      {
        path: '/redirects',
        component: 'admin/redirects',
        data: [{ finder: 'cms.adminRedirects', as: 'list' }],
        nav: { label: '内容管理 · 重定向', group: 'CMS' },
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
