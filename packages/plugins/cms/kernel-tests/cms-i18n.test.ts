import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser } from '../auth-helpers.ts';

/**
 * I18N-3 / ADR-0016 §4–§5 end-to-end:
 *  - content i18n: cms post/page carry `locale` + `translationKey`; public reads
 *    filter by `?locale=` and fall back to the default content language;
 *  - `/translations` returns the cross-locale siblings that hreflang needs;
 *  - manifest `locales`: a plugin's declared interface languages survive
 *    seeding and surface on the admin plugin list.
 */
const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('cms content i18n + manifest locales (real DB)', () => {
  let app: FastifyInstance;
  const email = `it_i18n3_${Date.now()}@example.com`;
  const password = 'test_password_123456';
  let adminToken: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
    // Install the cms plugin from the local market (source build is present).
    const install = await app.inject({
      method: 'POST',
      url: '/admin/market/plugins/cms/install',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(install.statusCode).toBe(201);
    // Grant the custom-model permissions to the admin group so writes pass.
    const prisma = getPrisma();
    for (const key of [
      'custom.cms/post.read',
      'custom.cms/post.write',
      'custom.cms/page.read',
      'custom.cms.page.write',
    ]) {
      const permission = await prisma.permission.upsert({
        where: { key },
        create: { key, name: key },
        update: {},
      });
      await prisma.groupPermission.upsert({
        where: { groupId_permissionId: { groupId: 'group_admin', permissionId: permission.id } },
        create: { groupId: 'group_admin', permissionId: permission.id },
        update: {},
      });
    }
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    await app.pluginRuntime.unregister('cms');
    await app.close();
  });

  /** Author a post through the generic Extension REST, then publish it live. */
  async function createPost(data: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/custom/cms/post',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const publish = await app.inject({
      method: 'POST',
      url: `/cms/admin/content/post/${id}/publish`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(publish.statusCode).toBe(200);
    return id;
  }

  it('returns only the requested locale, falling back to the default', async () => {
    await createPost({ title: '中文文章', slug: 'i18n-post', body: '正文', locale: 'zh-CN' });
    await createPost({ title: 'English post', slug: 'i18n-post-en', body: 'Body', locale: 'en-US' });

    const zh = await app.inject({ method: 'GET', url: '/cms/posts?locale=zh-CN' });
    expect(zh.statusCode).toBe(200);
    const zhTitles = (zh.json() as { items: Array<{ title: string }> }).items.map((i) => i.title);
    expect(zhTitles).toContain('中文文章');
    expect(zhTitles).not.toContain('English post');

    const en = await app.inject({ method: 'GET', url: '/cms/posts?locale=en-US' });
    const enTitles = (en.json() as { items: Array<{ title: string }> }).items.map((i) => i.title);
    expect(enTitles).toContain('English post');
    expect(enTitles).not.toContain('中文文章');

    // A locale with no content falls back to the default content language.
    const de = await app.inject({ method: 'GET', url: '/cms/posts?locale=de-DE' });
    const deTitles = (de.json() as { items: Array<{ title: string }> }).items.map((i) => i.title);
    expect(deTitles).toContain('中文文章');
  });

  it('groups translations by translationKey for hreflang consumers', async () => {
    await createPost({
      title: 'Grouped ZH',
      slug: 'grouped-zh',
      body: 'A',
      locale: 'zh-CN',
      translationKey: 'grouped',
    });
    await createPost({
      title: 'Grouped EN',
      slug: 'grouped-en',
      body: 'B',
      locale: 'en-US',
      translationKey: 'grouped',
    });

    const res = await app.inject({ method: 'GET', url: '/cms/posts/grouped-zh/translations' });
    expect(res.statusCode).toBe(200);
    const translations = (
      res.json() as { translations: Array<{ locale: string | null; slug: string }> }
    ).translations;
    expect(translations).toHaveLength(2);
    expect(translations.map((t) => t.locale).sort()).toEqual(['en-US', 'zh-CN']);
  });

  it('treats a single-language post as its own translation group', async () => {
    await createPost({ title: 'Solo', slug: 'solo-zh', body: 'A', locale: 'zh-CN' });
    const res = await app.inject({ method: 'GET', url: '/cms/posts/solo-zh/translations' });
    expect(res.statusCode).toBe(200);
    const translations = (res.json() as { translations: unknown[] }).translations;
    expect(translations).toHaveLength(1);
  });

  it('404s translations for an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/cms/posts/nope-missing/translations' });
    expect(res.statusCode).toBe(404);
  });

  it('exposes declared interface locales on the admin plugin list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const plugins = (res.json() as { plugins: Array<{ id: string; locales: string[] }> }).plugins;
    const cms = plugins.find((p) => p.id === 'cms');
    expect(cms).toBeDefined();
    expect(cms?.locales).toEqual(['zh-CN', 'en-US']);
  });
});
