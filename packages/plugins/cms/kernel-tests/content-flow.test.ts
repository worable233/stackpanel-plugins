import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import { initJobs } from '../../src/jobs/index.ts';
import { env } from '../../src/config/env.ts';

const dbAvailable = await checkDbAvailable();

/**
 * The CMS plugin is not a built-in by default (CONTENT-FLOW owns only
 * `packages/plugins/cms/**`); this test installs its built package into the test
 * data dir itself, so it never depends on the shared seed list being changed.
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

// Install before `buildApp()` so the boot scan registers the package.
installCmsPlugin();

describe.skipIf(!dbAvailable)('cms content workflow (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_cms_admin_${Date.now()}@example.com`;
  const userEmail = `it_cms_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';

  const adminHeaders = (): Record<string, string> => ({ authorization: `Bearer ${adminToken}` });
  const userHeaders = (): Record<string, string> => ({ authorization: `Bearer ${userToken}` });

  async function createDraft(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/cms/admin/content/post',
      headers: adminHeaders(),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function patch(id: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/cms/admin/content/post/${id}`,
      headers: adminHeaders(),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  async function publish(id: string): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'POST',
      url: `/cms/admin/content/post/${id}/publish`,
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  beforeAll(async () => {
    // The job backend is attached by `initInfra()` in the real entrypoints; the
    // test harness builds the app directly, so attach the in-process backend
    // (the dev fallback) explicitly to exercise scheduled publishing.
    await initJobs({ redisUrl: null, logger: { info: () => undefined, warn: () => undefined } });
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    // The plugin was installed into data/plugins by `installCmsPlugin()` before
    // `buildApp()`, so the boot scan registered it; activate it explicitly.
    await app.pluginRuntime.activate('cms');
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await app.pluginRuntime.unregister('cms');
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('starts with no published content', async () => {
    const res = await app.inject({ method: 'GET', url: '/cms/posts' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('keeps a draft out of the public list until it is published', async () => {
    const id = await createDraft({ title: '草稿文章', slug: 'draft-post', body: '正文' });

    const draft = await app.inject({
      method: 'GET',
      url: `/cms/admin/content/post/${id}`,
      headers: adminHeaders(),
    });
    expect(draft.statusCode).toBe(200);
    const dto = draft.json() as { status: string; published: boolean };
    expect(dto.status).toBe('draft');
    expect(dto.published).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/cms/posts' });
    expect((list.json() as { total: number }).total).toBe(0);

    const detail = await app.inject({ method: 'GET', url: '/cms/posts/draft-post' });
    expect(detail.statusCode).toBe(404);
  });

  it('records an immutable revision on every save', async () => {
    const id = await createDraft({ title: '版本文章', slug: 'revision-post', body: 'v1' });
    await patch(id, { body: 'v2', note: '第二次修改' });

    const res = await app.inject({
      method: 'GET',
      url: `/cms/admin/content/post/${id}/revisions`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ revisionNumber: number; body: string; note: string | null }>; total: number };
    expect(body.total).toBe(2);
    // Newest first.
    expect(body.items[0]?.revisionNumber).toBe(2);
    expect(body.items[0]?.body).toBe('v2');
    expect(body.items[0]?.note).toBe('第二次修改');
    expect(body.items[1]?.body).toBe('v1');
  });

  it('publishes a draft and serves it at its live slug', async () => {
    const id = await createDraft({ title: '发布文章', slug: 'live-post', body: '上线正文' });
    const published = await publish(id);
    expect(published['published']).toBe(true);
    expect(published['status']).toBe('published');

    const detail = await app.inject({ method: 'GET', url: '/cms/posts/live-post' });
    expect(detail.statusCode).toBe(200);
    const live = detail.json() as { title: string; body: string; path: string };
    expect(live.title).toBe('发布文章');
    expect(live.body).toBe('上线正文');
    expect(live.path).toBe('/blog/live-post');
  });

  it('retires the old slug with a 301 when a published slug changes (F5)', async () => {
    const id = await createDraft({ title: '改名文章', slug: 'old-slug', body: '正文' });
    await publish(id);

    // Rename the working copy, then publish again.
    await patch(id, { slug: 'new-slug' });
    await publish(id);

    const resolved = await app.inject({
      method: 'GET',
      url: '/cms/redirects/resolve?path=/blog/old-slug',
    });
    expect(resolved.statusCode).toBe(200);
    const body = resolved.json() as { found: boolean; target: string; status: number };
    expect(body.found).toBe(true);
    expect(body.status).toBe(301);
    expect(body.target).toBe('/blog/new-slug');

    // The retired slug is no longer directly reachable.
    const old = await app.inject({ method: 'GET', url: '/cms/posts/old-slug' });
    expect(old.statusCode).toBe(404);
    const current = await app.inject({ method: 'GET', url: '/cms/posts/new-slug' });
    expect(current.statusCode).toBe(200);
  });

  it('reports no redirect for an unknown path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/cms/redirects/resolve?path=/blog/never-existed',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { found: boolean }).found).toBe(false);
  });

  it('previews a draft for an authenticated user without publishing it', async () => {
    await createDraft({ title: '预览文章', slug: 'preview-post', body: '预览正文' });

    const preview = await app.inject({
      method: 'GET',
      url: '/cms/preview/post/preview-post',
      headers: userHeaders(),
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json() as { title: string; body: string };
    expect(body.title).toBe('预览文章');
    expect(body.body).toBe('预览正文');

    // The draft is still invisible publicly.
    expect((await app.inject({ method: 'GET', url: '/cms/posts/preview-post' })).statusCode).toBe(404);
  });

  it('takes a published item offline on unpublish', async () => {
    const id = await createDraft({ title: '下架文章', slug: 'unpublish-post', body: '正文' });
    await publish(id);
    expect((await app.inject({ method: 'GET', url: '/cms/posts/unpublish-post' })).statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/cms/admin/content/post/${id}/unpublish`,
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { published: boolean }).published).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/cms/posts/unpublish-post' })).statusCode).toBe(404);
  });

  it('publishes a scheduled item once its time arrives', async () => {
    const id = await createDraft({
      title: '定时文章',
      slug: 'scheduled-post',
      body: '正文',
      status: 'scheduled',
      publishAt: Date.now() + 80,
    });
    expect((await app.inject({ method: 'GET', url: '/cms/posts/scheduled-post' })).statusCode).toBe(404);

    let live = false;
    for (let attempt = 0; attempt < 40 && !live; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      live = (await app.inject({ method: 'GET', url: '/cms/posts/scheduled-post' })).statusCode === 200;
    }
    expect(live).toBe(true);
    void id;
  });

  it('deletes an item and retires its live slug', async () => {
    const id = await createDraft({ title: '待删文章', slug: 'delete-me', body: '正文' });
    await publish(id);

    const del = await app.inject({
      method: 'DELETE',
      url: `/cms/admin/content/post/${id}`,
      headers: adminHeaders(),
    });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/cms/posts/delete-me' })).statusCode).toBe(404);

    const resolved = await app.inject({
      method: 'GET',
      url: '/cms/redirects/resolve?path=/blog/delete-me',
    });
    expect(resolved.statusCode).toBe(200);
    // The target item is gone, so the stale redirect resolves to nothing.
    expect((resolved.json() as { found: boolean }).found).toBe(false);
  });

  it('hides the admin surface from regular users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/cms/admin/content/post',
      headers: userHeaders(),
    });
    expect(res.statusCode).toBe(403);
  });
});
