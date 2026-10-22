import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The stale-lock sync test must fail deterministically without touching the
// network. Mock DNS resolution so `assertPublicUpstreamUrl` fails fast with
// 502 instead of hanging on a real resolver (billing.example.com can hang
// >5s in some networks and blow the default test timeout).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockRejectedValue(new Error("DNS unavailable (test mock)")),
}));
import { buildApp } from "../../src/app.ts";
import { getPrisma } from "../../src/plugins/prisma.ts";
import { checkDbAvailable } from "../helpers.ts";
import { createAdminUser } from "../auth-helpers.ts";

const dbAvailable = await checkDbAvailable();

/** 直接读写引擎物理表，模拟另一个副本持有的同步锁。 */
async function setSyncState(
  id: string,
  syncState: string,
  lastAttemptAtMs: number | null,
) {
  await getPrisma().$executeRawUnsafe(
    `UPDATE "ext_zjmf-upstream_upstream"
       SET "spec" = "spec" || $2::jsonb,
           "f_syncState" = $3,
           "f_lastAttemptAtMs" = $4
     WHERE "id" = $1`,
    id,
    JSON.stringify({ syncState, lastAttemptAtMs }),
    syncState,
    lastAttemptAtMs,
  );
}

async function readSyncState(
  id: string,
): Promise<{ syncState: string; lastAttemptAtMs: number | null }> {
  const rows = await getPrisma().$queryRawUnsafe<
    Array<{ f_syncState: string; f_lastAttemptAtMs: number | null }>
  >(
    `SELECT "f_syncState", "f_lastAttemptAtMs" FROM "ext_zjmf-upstream_upstream" WHERE "id" = $1`,
    id,
  );
  const row = rows[0];
  return {
    syncState: row?.f_syncState ?? "",
    lastAttemptAtMs: row?.f_lastAttemptAtMs ?? null,
  };
}

async function countSyncRuns(upstreamId: string): Promise<number> {
  const rows = await getPrisma().$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*)::bigint AS count FROM "ext_zjmf-upstream_sync-run" WHERE "spec"->>'upstreamId' = $1`,
    upstreamId,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Seed a store product bound to an upstream via its metadata (no mapping table). */
async function seedBoundProduct(input: {
  upstreamId: string;
  upstreamProductId: string;
  productId: string;
}): Promise<void> {
  await getPrisma().$executeRawUnsafe(
    `INSERT INTO "ext_store_product"
       ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
        "created_at", "updated_at", "f_status", "f_stock", "f_categoryId", "f_providerId")
     VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
             now(), now(), 'ACTIVE', 50, NULL, 'zjmf')`,
    input.productId,
    JSON.stringify({
      name: "Bound-VPS",
      description: null,
      price: 5000,
      currency: "CNY",
      cost: null,
      originalPrice: null,
      discount: null,
      stock: 50,
      status: "ACTIVE",
      metadata: {
        upstream: {
          providerId: "zjmf",
          sourceRef: input.upstreamId,
          productId: input.upstreamProductId,
          sourcePrice: 4000,
        },
      },
      categoryId: null,
      fulfillmentType: "cloud_server",
      providerId: "zjmf",
      providerProductId: input.upstreamProductId,
    }),
  );
}

describe.skipIf(!dbAvailable)(
  "zjmf upstream plugin integration (real DB)",
  () => {
    let app: FastifyInstance;
    const email = `it_zjmf_${Date.now()}@example.com`;
    const password = "IntegrationPass123";
    let token = "";
    let upstreamId = "";

    beforeAll(async () => {
      app = buildApp();
      await app.ready();
      await app.pluginRuntime.activate("login");
      const prisma = getPrisma();
      const admin = await createAdminUser(app, email, password);
      token = admin.token;
      await prisma.plugin.deleteMany({
        where: { id: { in: ["store", "zjmf-upstream"] } },
      });
      const enable = await app.inject({
        method: "PATCH",
        url: "/admin/plugins/zjmf-upstream",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true },
      });
      expect(enable.statusCode).toBe(200);
    });

    afterAll(async () => {
      const prisma = getPrisma();
      await prisma.$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-upstream_sync-run"`,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-upstream_upstream"`,
      );
      await prisma.secret.deleteMany({
        where: { key: { startsWith: "plugin.zjmf-upstream." } },
      });
      await prisma.plugin.deleteMany({
        where: { id: { in: ["store", "zjmf-upstream"] } },
      });
      await prisma.user.deleteMany({ where: { email } });
      await app.close();
    });

    it("requires administrator authentication for upstream configuration", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/zjmf-upstream/admin/upstreams",
      });
      expect(response.statusCode).toBe(401);
    });

    it("stores V10 credentials encrypted and never returns them", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/zjmf-upstream/admin/upstreams",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Example supplier",
          baseUrl: "https://upstream.invalid/",
          protocol: "v10",
          username: "supplier-user",
          password: "supplier-password",
          markupBps: 250,
          defaultStock: 100,
          syncIntervalMinutes: 60,
        },
      });
      expect(response.statusCode).toBe(200);
      upstreamId = (response.json() as { upstream: { id: string } }).upstream
        .id;

      const list = await app.inject({
        method: "GET",
        url: "/zjmf-upstream/admin/upstreams",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).toContain("credentialsConfigured");
      expect(list.body).not.toContain("supplier-user");
      expect(list.body).not.toContain("supplier-password");

      const secret = await getPrisma().secret.findFirstOrThrow({
        where: { key: `plugin.zjmf-upstream.credentials.${upstreamId}` },
      });
      expect(secret.ciphertext).not.toContain("supplier-user");
      expect(secret.ciphertext).not.toContain("supplier-password");
    });

    it("rejects a sync while another instance holds the database lock", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/zjmf-upstream/admin/upstreams",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Locked supplier",
          baseUrl: "https://upstream.invalid/",
          protocol: "finance",
          username: "u",
          password: "p",
          markupBps: 0,
          defaultStock: 100,
          syncIntervalMinutes: 60,
        },
      });
      expect(created.statusCode).toBe(200);
      const id = (created.json() as { upstream: { id: string } }).upstream.id;

      await setSyncState(id, "SYNCING", Date.now());

      const sync = await app.inject({
        method: "POST",
        url: `/zjmf-upstream/admin/upstreams/${id}/sync`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sync.statusCode).toBe(409);
      expect(sync.json()).toMatchObject({
        detail: "上游同步正在进行中",
        code: "zjmf.sync_in_progress",
      });

      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-upstream_upstream" WHERE "id" = $1`,
        id,
      );
    });

    it("takes over a stale sync lock and releases it after a failed sync", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/zjmf-upstream/admin/upstreams",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Stale supplier",
          baseUrl: "https://upstream.invalid/",
          protocol: "finance",
          username: "u",
          password: "p",
          markupBps: 0,
          defaultStock: 100,
          syncIntervalMinutes: 60,
        },
      });
      expect(created.statusCode).toBe(200);
      const id = (created.json() as { upstream: { id: string } }).upstream.id;

      await setSyncState(id, "SYNCING", Date.now() - 30 * 60 * 1000);

      const sync = await app.inject({
        method: "POST",
        url: `/zjmf-upstream/admin/upstreams/${id}/sync`,
        headers: { authorization: `Bearer ${token}` },
      });

      const after = await readSyncState(id);
      expect(after.syncState).toBe("IDLE");
      expect(await countSyncRuns(id)).toBeGreaterThan(0);
      expect(sync.statusCode).toBe(502);

      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-upstream_sync-run" WHERE "spec"->>'upstreamId' = $1`,
        id,
      );
      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "ext_zjmf-upstream_upstream" WHERE "id" = $1`,
        id,
      );
    });

    it("deletes an upstream and its credentials without touching bound products", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/zjmf-upstream/admin/upstreams",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "Delete supplier",
          baseUrl: "https://upstream.invalid/",
          protocol: "finance",
          username: "del-user",
          password: "del-password",
          markupBps: 0,
          defaultStock: 50,
          syncIntervalMinutes: 60,
        },
      });
      expect(created.statusCode).toBe(200);
      const id = (created.json() as { upstream: { id: string } }).upstream.id;

      const prisma = getPrisma();
      const productId = `prod_del_${Date.now()}`;
      await seedBoundProduct({
        upstreamId: id,
        upstreamProductId: "up-1",
        productId,
      });

      const del = await app.inject({
        method: "DELETE",
        url: `/zjmf-upstream/admin/upstreams/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toMatchObject({ deleted: true });

      const upstreamRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "ext_zjmf-upstream_upstream" WHERE "id" = $1`,
        id,
      );
      expect(upstreamRows).toEqual([]);
      // 商品不随上游删除：绑定在商品 metadata，商品保留由管理员处置。
      const productRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "ext_store_product" WHERE "id" = $1`,
        productId,
      );
      expect(productRows).toEqual([{ id: productId }]);
      expect(
        await prisma.secret.findFirst({
          where: { key: `plugin.zjmf-upstream.credentials.${id}` },
        }),
      ).toBeNull();

      const repeat = await app.inject({
        method: "DELETE",
        url: `/zjmf-upstream/admin/upstreams/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(repeat.statusCode).toBe(404);
      expect(repeat.json()).toMatchObject({ code: "zjmf.upstream_not_found" });

      await prisma.$executeRawUnsafe(
        `DELETE FROM "ext_store_product" WHERE "id" = $1`,
        productId,
      );
    });
  },
);
