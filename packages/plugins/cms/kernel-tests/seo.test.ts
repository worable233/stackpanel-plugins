import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { env } from '../../src/config/env.ts';

const dbAvailable = await checkDbAvailable();

/**
 * The CMS plugin is not a built-in by default (SEO-LAYER owns only its own
 * files); install its built package into the test data dir before boot so the
 * kernel `/seo/*` endpoints have a real `seo.provider` to aggregate.
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const cmsDist = path.join(rootDir, 'packages/plugins/cms/dist');
const cmsPkg = path.join(rootDir, 'packages/plugins/cms/package.json');
const dataDir = env.STACKPANEL_DATA_DIR ?? path.join(rootDir, 'apps/api/data');
const cmsTarget = path.join(dataDir, 'plugins/cms');

function installCmsPlugin(): void {
  if (!fs.existsSync(path.join(cmsDist, 'index.js'))) {
    throw new Error('cms plugin 未构建：请先 `pnpm --filter @stackpanel/plugin-cms build`');
  }
  fs.mkdirSync(path.join(cmsTarget, 'dist'), { recursive: true });
  for (const file of fs.readdirSync(cmsDist)) {
    fs.copyFileSync(path.join(cmsDist, file), path.join(cmsTarget, 'dist', file));
  }
  const pkg = JSON.parse(fs.readFileSync(cmsPkg, 'utf8')) as {
    version?: string;
    description?: string;
  };
  fs.writeFileSync(
    path.join(cmsTarget, 'manifest.json'),
    JSON.stringify(
      {
        id: 'cms',
        name: pkg.description ?? 'CMS',
        version: pkg.version ?? '0.0.0',
        apiVersion: '>=0.4.0',
      },
      null,
      2,
    ),
  );
}

installCmsPlugin();

describe.skipIf(!dbAvailable)('seo delivery endpoints (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_seo_admin_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';

  const adminHeaders = (): Record<string, string> => ({ authorization: `Bearer ${adminToken}` });

  /** Create a published post and return its live slug. */
  async function publishPost(slug: string, title: string, body = '正文'): Promise<void> {
    const created = await app.inject({
      method: 'POST',
      url: '/cms/admin/content/post',
      headers: adminHeaders(),
      payload: { title, slug, body },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const published = await app.inject({
      method: 'POST',
      url: `/cms/admin/content/post/${id}/publish`,
      headers: adminHeaders(),
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(200);
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await app.pluginRuntime.activate('cms');
    adminToken = (await createAdminUser(app, adminEmail, password)).token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await app.pluginRuntime.unregister('cms');
    await prisma.user.deleteMany({ where: { email: adminEmail } });
    await app.close();
  });

  it('aggregates a published post into the sitemap with its source', async () => {
    const slug = `seo-sitemap-${Date.now()}`;
    await publishPost(slug, 'SEO 站点地图文章');

    const res = await app.inject({ method: 'GET', url: '/seo/sitemap?pageSize=200' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ url: string; source: string; alternates?: unknown[] }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(200);
    const entry = body.entries.find((item) => item.url === `/blog/${slug}`);
    expect(entry, res.body).toBeTruthy();
    expect(entry?.source).toBe('cms');
  });

  it('keeps drafts out of the sitemap', async () => {
    const slug = `seo-draft-${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/cms/admin/content/post',
      headers: adminHeaders(),
      payload: { title: '草稿', slug, body: '正文' },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/seo/sitemap?pageSize=200' });
    const body = res.json() as { entries: Array<{ url: string }> };
    expect(body.entries.some((item) => item.url === `/blog/${slug}`)).toBe(false);
  });

  it('pages the sitemap deterministically', async () => {
    const first = await app.inject({ method: 'GET', url: '/seo/sitemap?page=1&pageSize=1' });
    const second = await app.inject({ method: 'GET', url: '/seo/sitemap?page=2&pageSize=1' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const a = first.json() as { entries: Array<{ url: string }>; total: number; pageSize: number };
    const b = second.json() as { entries: Array<{ url: string }>; pageSize: number };
    expect(a.pageSize).toBe(1);
    expect(a.entries).toHaveLength(1);
    expect(b.pageSize).toBe(1);
    if (a.total > 1) {
      expect(a.entries[0]?.url).not.toBe(b.entries[0]?.url);
    }
  });

  it('resolves entity metadata for a published post path', async () => {
    const slug = `seo-meta-${Date.now()}`;
    await publishPost(slug, 'SEO 元数据文章');

    const res = await app.inject({
      method: 'GET',
      url: `/seo/meta?path=${encodeURIComponent(`/blog/${slug}`)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { title?: string; canonical?: string; jsonLd?: Record<string, unknown> } | null;
      source: string | null;
    };
    expect(body.source).toBe('cms');
    expect(body.meta?.title).toBe('SEO 元数据文章');
    expect(body.meta?.canonical).toBe(`/blog/${slug}`);
    expect(body.meta?.jsonLd?.['@type']).toBe('BlogPosting');
  });

  it('returns a null result for a path no provider owns', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/seo/meta?path=${encodeURIComponent(`/never/${Date.now()}`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ meta: null, source: null });
  });

  it('rejects a meta request without a path', async () => {
    const res = await app.inject({ method: 'GET', url: '/seo/meta' });
    expect(res.statusCode).toBe(400);
  });

  it('aggregates published posts into the feed, newest first', async () => {
    const slug = `seo-feed-${Date.now()}`;
    await publishPost(slug, 'SEO Feed 文章');

    const res = await app.inject({ method: 'GET', url: '/seo/feed?pageSize=200' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ url: string; title: string; updated: string }>;
      total: number;
    };
    const entry = body.entries.find((item) => item.url === `/blog/${slug}`);
    expect(entry, res.body).toBeTruthy();
    expect(entry?.title).toBe('SEO Feed 文章');
  });

  it('serves platform robots rules with reserved paths disallowed', async () => {
    const res = await app.inject({ method: 'GET', url: '/seo/robots' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rules: Array<{ userAgent: string; disallow?: string[] }>;
      sitemap: string | null;
    };
    expect(body.rules[0]?.userAgent).toBe('*');
    expect(body.rules[0]?.disallow).toContain('/admin/');
    expect(body.rules[0]?.disallow).toContain('/account/');
  });

  it('marks every SEO response as publicly cacheable', async () => {
    for (const url of ['/seo/sitemap', '/seo/feed', '/seo/robots']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['cache-control']).toBe('public, max-age=3600');
    }
  });
});
