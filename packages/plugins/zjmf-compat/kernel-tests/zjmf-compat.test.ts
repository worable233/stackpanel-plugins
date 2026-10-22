import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

const PRODUCT_TABLE = 'ext_store_product';
const ZJMF_USER = 'zjmf_client';

/** Seed an active product in the store plugin's Extension table. */
async function seedProduct(id: string, name: string, price: number, stock: number): Promise<void> {
  const spec = {
    name,
    description: null,
    price,
    currency: 'CNY',
    cost: null,
    originalPrice: null,
    discount: null,
    stock,
    status: 'ACTIVE',
    metadata: null,
    categoryId: null,
    fulfillmentType: 'manual',
    providerId: null,
    providerProductId: null,
  };
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "${PRODUCT_TABLE}"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_status", "f_stock", "f_categoryId", "f_providerId")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), 'ACTIVE', $3, NULL, NULL)`,
    id,
    JSON.stringify(spec),
    stock,
  );
}

/**
 * zjmf-compat (P4): the ZJMF wire protocol is served by translating into the
 * store plugin's `commerce.operations` outlet. Verifies plugin-owned credential
 * login, envelope shapes, catalog/price projection, cart settlement and host
 * lifecycle mapping against the real commerce domain.
 */
describe.skipIf(!dbAvailable)('zjmf-compat protocol surface (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  let adminToken = '';
  let adminUserId = '';
  let adminEmail = '';
  let token = '';
  let productId = '';

  const form = (body: Record<string, string>) =>
    new URLSearchParams(body).toString();

  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');

    adminEmail = `zjmf-admin-${suffix}@example.com`;
    const admin = await createAdminUser(app, adminEmail, 'password1234');
    adminToken = admin.token;
    adminUserId = admin.userId;

    const prisma = getPrisma();
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enableStore = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableStore.statusCode).toBe(200);

    const enableCompat = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/zjmf-compat',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enableCompat.statusCode).toBe(200);

    productId = `zjmf_prod_${suffix}`;
    await seedProduct(productId, `魔方兼容测试商品 ${suffix}`, 1200, 5);

    const created = await app.inject({
      method: 'POST',
      url: '/zjmf-compat/admin/connections',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: `客户端 ${suffix}`,
        username: ZJMF_USER,
        password: 'client-pass-123',
        userId: adminUserId,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(JSON.stringify(created.json())).not.toContain('passwordHash');
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ext_zjmf-compat_connection" WHERE "f_username" = $1`,
      ZJMF_USER,
    ).catch(() => undefined);
    await app.close();
  });

  it('issues a JWT from plugin-owned credentials and rejects bad passwords', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/zjmf_api_login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ username: ZJMF_USER, password: 'wrong' }),
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ status: 401 });

    const res = await app.inject({
      method: 'POST',
      url: '/zjmf_api_login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ username: ZJMF_USER, password: 'client-pass-123' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: number; jwt: string };
    expect(body.status).toBe(200);
    expect(typeof body.jwt).toBe('string');
    token = body.jwt;
  });

  it('requires a session for catalog reads', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/product/list' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 401 });
  });

  it('projects the commerce catalog into the ZJMF product list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/product/list', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: number;
      data: { list: Array<Record<string, unknown>>; currency_code: string };
    };
    expect(body.status).toBe(200);
    const product = body.data.list.find((item) => item['id'] === productId);
    expect(product).toBeDefined();
    expect(product?.['price']).toBe('12.00');
    expect(product?.['currency_code']).toBe('CNY');
  });

  it('serves product detail, config and totals', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/product/${productId}`,
      headers: auth(),
    });
    expect(
      (detail.json() as { data: { product: { id: string } } }).data.product.id,
    ).toBe(productId);

    const config = await app.inject({
      method: 'GET',
      url: `/cart/set_config?pid=${productId}&billingcycle=monthly`,
      headers: auth(),
    });
    const cycle = (
      config.json() as { data: { product: { cycle: Array<{ product_price: string }> } } }
    ).data.product.cycle[0];
    expect(cycle?.product_price).toBe('12.00');

    const total = await app.inject({
      method: 'POST',
      url: '/cart/get_total',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ pid: productId, qty: '2' }),
    });
    expect((total.json() as { products: { sale_total: string } }).products.sale_total).toBe('24.00');
  });

  it('runs the cart → settle → host flow through commerce', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/cart/add_to_shop',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ pid: productId, qty: '1' }),
    });
    expect((add.json() as { cart_count: number }).cart_count).toBe(1);

    const settle = await app.inject({
      method: 'POST',
      url: '/cart/settle',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    const settled = settle.json() as { data: { invoiceid: string | null; order_ids: string[] } };
    expect(settled.data.order_ids).toHaveLength(1);
    expect(settled.data.invoiceid).toBeTruthy();

    const hosts = await app.inject({ method: 'GET', url: '/host/list', headers: auth() });
    expect((hosts.json() as { status: number }).status).toBe(200);

    const missing = await app.inject({
      method: 'GET',
      url: '/host/header?host_id=does-not-exist',
      headers: auth(),
    });
    expect(missing.json()).toMatchObject({ status: 404 });
  });

  it('maps provision funcs onto lifecycle actions', async () => {
    const unsupported = await app.inject({
      method: 'POST',
      url: '/provision/default',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ id: 'x', func: 'reboot' }),
    });
    expect(unsupported.json()).toMatchObject({ status: 400 });

    const notFound = await app.inject({
      method: 'POST',
      url: '/provision/default',
      headers: { ...auth(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ id: 'missing', func: 'suspend' }),
    });
    expect(notFound.json()).toMatchObject({ status: 404 });
  });

  it('throttles and locks native login after repeated failures (audit M-3)', async () => {
    const lockUser = `zjmf_lock_${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: '/zjmf-compat/admin/connections',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: `锁定测试 ${suffix}`,
        username: lockUser,
        password: 'lock-pass-123',
        userId: adminUserId,
      },
    });
    expect(created.statusCode).toBe(200);

    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/zjmf_api_login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ username: lockUser, password }),
      });

    for (let i = 0; i < 8; i += 1) {
      const bad = await attempt('wrong');
      expect((bad.json() as { status: number }).status).toBe(401);
    }

    // The next attempt — even with the right password — is locked out.
    const locked = await attempt('lock-pass-123');
    expect((locked.json() as { status: number }).status).toBe(429);

    await getPrisma()
      .$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-compat_connection" WHERE "f_username" = $1`,
        lockUser,
      )
      .catch(() => undefined);
  });
});
