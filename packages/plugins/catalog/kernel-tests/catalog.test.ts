import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** 删除指定 store 商品对应的目录上架记录（Extension 引擎表）。 */
async function deleteCatalogProductEntries(productIds: readonly string[]): Promise<void> {
  if (productIds.length === 0) return;
  await getPrisma().$executeRawUnsafe(
    `DELETE FROM "ext_catalog_product" WHERE "spec"->>'productId' = ANY($1::text[])`,
    [...productIds],
  );
}

async function createCategory(
  app: FastifyInstance,
  adminToken: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/catalog/admin/categories',
    headers: { authorization: `Bearer ${adminToken}` },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { category: { id: string } }).category.id;
}

describe.skipIf(!dbAvailable)('catalog plugin integration (single tree, real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_cat_admin_${Date.now()}@example.com`;
  const userEmail = `it_cat_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let productId = '';
  let rootId = '';
  let childId = '';
  let secondRootId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    await prisma.plugin.deleteMany({ where: { id: { in: ['catalog', 'store'] } } });

    for (const pluginId of ['store', 'catalog']) {
      const enable = await app.inject({
        method: 'PATCH',
        url: `/admin/plugins/${pluginId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { enabled: true },
      });
      expect(enable.statusCode).toBe(200);
    }

    const product = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'VPS-2C', price: 19900, stock: 7, description: '2 vCPU / 2GB RAM' },
    });
    expect(product.statusCode).toBe(201);
    productId = (product.json() as { product: { id: string } }).product.id;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await deleteCatalogProductEntries([productId]);
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_catalog_category"`);
    if (productId) {
      await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "id" = $1`, productId);
    }
    await prisma.plugin.deleteMany({ where: { id: { in: ['catalog', 'store'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('lets anyone browse the public catalog routes', async () => {
    expect((await app.inject({ method: 'GET', url: '/catalog/categories' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/catalog/products' })).statusCode).toBe(200);
  });

  it('rejects non-admin access to catalog admin routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/catalog/admin/categories',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets an admin create a root category that appears in the public tree', async () => {
    rootId = await createCategory(app, adminToken, {
      name: '云计算',
      slug: 'cloud',
      icon: '☁️',
      sortOrder: 10,
    });

    const tree = await app.inject({ method: 'GET', url: '/catalog/categories' });
    const root = (
      tree.json() as { categories: Array<{ id: string; name: string; icon: string | null }> }
    ).categories.find((category) => category.id === rootId);
    expect(root?.name).toBe('云计算');
    expect(root?.icon).toBe('☁️');
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/admin/categories',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: '另一个云计算', slug: 'cloud' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('creates a child category and returns it nested under the root', async () => {
    childId = await createCategory(app, adminToken, {
      name: '轻量服务器',
      slug: 'vps',
      parentId: rootId,
      sortOrder: 1,
    });

    const admin = await app.inject({
      method: 'GET',
      url: '/catalog/admin/categories',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const root = (
      admin.json() as { categories: Array<{ id: string; children: unknown[] }> }
    ).categories.find((category) => category.id === rootId);
    expect(root?.children).toHaveLength(1);
    expect((root?.children as Array<{ id: string }> | undefined)?.[0]?.id).toBe(childId);
  });

  it('creates a second root category for ordering tests', async () => {
    secondRootId = await createCategory(app, adminToken, {
      name: '对象存储',
      slug: 'storage',
      sortOrder: 1,
    });
  });

  it('prevents moving a category into itself or its own subtree', async () => {
    const intoSelf = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/categories/${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { parentId: rootId },
    });
    expect(intoSelf.statusCode).toBe(400);
    expect(intoSelf.headers['content-type']).toContain('application/problem+json');
    expect((intoSelf.json() as { code: string }).code).toBe('catalog.category.move_into_self');

    const intoChild = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/categories/${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { parentId: childId },
    });
    expect(intoChild.statusCode).toBe(400);
    expect((intoChild.json() as { code: string }).code).toBe(
      'catalog.category.move_into_descendant',
    );
  });

  it('renames a category and its icon', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/categories/${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: '云计算与网络', icon: '🌐' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { category: { name: string; icon: string | null } };
    expect(body.category.name).toBe('云计算与网络');
    expect(body.category.icon).toBe('🌐');
  });

  it('refuses to delete a category that still has children', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/catalog/admin/categories/${rootId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('reorders categories via parallel arrays and updates parent/order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/admin/categories/reorder',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        ids: [secondRootId, rootId, childId],
        parentIds: ['', '', secondRootId],
        sortOrders: [0, 1, 2],
      },
    });
    expect(res.statusCode).toBe(200);

    const admin = await app.inject({
      method: 'GET',
      url: '/catalog/admin/categories',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const categories = (admin.json() as { categories: Array<{ id: string; parentId: string | null; sortOrder: number; children: unknown[] }> }).categories;
    expect(categories.map((c) => c.id)).toEqual([secondRootId, rootId]);
    const second = categories.find((c) => c.id === secondRootId);
    if (!second) throw new Error('缺少第二个根分类');
    expect(second.children).toHaveLength(1);
    expect((second.children as Array<{ id: string }>)[0]?.id).toBe(childId);
  });

  it('rejects reorder with unknown ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/catalog/admin/categories/reorder',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ids: ['missing'], parentIds: [''], sortOrders: [0] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('catalog.sort.category_missing');
  });

  it('assigns a product to multiple categories and browses by subtree', async () => {
    const publicBefore = await app.inject({ method: 'GET', url: `/catalog/products` });
    expect((publicBefore.json() as { total: number }).total).toBe(0);

    const shelf = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/products/${productId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { categoryIds: [childId], shelfStatus: 'ON', stock: 7, sortOrder: 5 },
    });
    expect(shelf.statusCode).toBe(200);
    expect(
      (shelf.json() as { catalog: { categoryIds: string[] } }).catalog.categoryIds,
    ).toContain(childId);

    // 默认展示第一个子分类：此时第二个根（storage）在前，其子 childId 被选为默认。
    const listed = await app.inject({ method: 'GET', url: '/catalog/products' });
    const body = listed.json() as { total: number; categoryId: string | null };
    expect(body.total).toBe(1);
    expect(body.categoryId).toBe(childId);
  });

  it('browses by a parent category subtree', async () => {
    const subtree = await app.inject({
      method: 'GET',
      url: `/catalog/products?categoryId=${secondRootId}`,
    });
    expect((subtree.json() as { total: number }).total).toBe(1);
  });

  it('hides OFF-shelf products from the public list but keeps them in admin', async () => {
    const off = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/products/${productId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { shelfStatus: 'OFF' },
    });
    expect(off.statusCode).toBe(200);

    const publicList = await app.inject({ method: 'GET', url: '/catalog/products' });
    const found = (
      publicList.json() as { products: Array<{ product: { id: string } }> }
    ).products.some((entry) => entry.product.id === productId);
    expect(found).toBe(false);

    const adminList = await app.inject({
      method: 'GET',
      url: '/catalog/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const entry = (
      adminList.json() as {
        products: Array<{ product: { id: string }; catalog: { shelfStatus: string } | null }>;
      }
    ).products.find((candidate) => candidate.product.id === productId);
    expect(entry?.catalog?.shelfStatus).toBe('OFF');
  });

  it('updates stock through the catalog admin endpoint', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/products/${productId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { stock: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { product: { stock: number } }).product.stock).toBe(3);
  });

  it('shows all products when showAll is enabled', async () => {
    // 重新上架后，商品在 storage 分类下。
    await app.inject({
      method: 'PATCH',
      url: `/catalog/admin/products/${productId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { shelfStatus: 'ON' },
    });
    const res = await app.inject({ method: 'GET', url: '/catalog/products?showAll=1' });
    const body = res.json() as {
      total: number;
      categoryId: string | null;
      products: Array<{ product: { id: string } }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.categoryId).toBeNull();
    expect(body.products.some((entry) => entry.product.id === productId)).toBe(true);
  });

  it('detaches a product from its category when the category is deleted', async () => {
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/catalog/admin/categories/${childId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const adminList = await app.inject({
      method: 'GET',
      url: '/catalog/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const entry = (
      adminList.json() as {
        products: Array<{
          product: { id: string };
          catalog: { categoryIds: string[] } | null;
        }>;
      }
    ).products.find((candidate) => candidate.product.id === productId);
    expect(entry?.catalog?.categoryIds).not.toContain(childId);
  });

  it('paginates a category product list', async () => {
    const catId = await createCategory(app, adminToken, {
      name: '分页分类',
      slug: `page-${Date.now()}`,
    });

    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/store/admin/products',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: `VPS-分页-${index}`,
          price: 1000 + index,
          stock: 1,
          description: 'paginate',
        },
      });
      const id = (res.json() as { product: { id: string } }).product.id;
      created.push(id);
      await app.inject({
        method: 'PATCH',
        url: `/catalog/admin/products/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { categoryIds: [catId], shelfStatus: 'ON', sortOrder: 0 },
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/catalog/products?categoryId=${catId}&page=1&pageSize=2`,
    });
    const body1 = page1.json() as {
      products: Array<{ product: { id: string } }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body1.products).toHaveLength(2);
    expect(body1.total).toBe(3);
    expect(body1.page).toBe(1);

    const page2 = await app.inject({
      method: 'GET',
      url: `/catalog/products?categoryId=${catId}&page=2&pageSize=2`,
    });
    const body2 = page2.json() as {
      products: Array<{ product: { id: string } }>;
      page: number;
      pageSize: number;
    };
    expect(body2.products).toHaveLength(1);
    expect(body2.page).toBe(2);

    const seen = [...body1.products, ...body2.products].map((entry) => entry.product.id);
    for (const id of created) expect(seen).toContain(id);

    await deleteCatalogProductEntries(created);
    for (const id of created) {
      await getPrisma().$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "id" = $1`, id);
    }
    await getPrisma().$executeRawUnsafe(`DELETE FROM "ext_catalog_category" WHERE "id" = $1`, catId);
  });

  it('returns 404 for catalog routes once the plugin is disabled', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/catalog',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/catalog/categories' })).statusCode).toBe(404);
  });
});
