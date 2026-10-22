import type { FinderContext, FrontendPackage } from "@stackpanel/sdk";
import { z } from "zod";

const upstreamListSchema = z.object({
  secretsEnabled: z.boolean(),
  upstreams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      protocol: z.enum(["finance", "v10"]),
      currency: z.string(),
      markupBps: z.number(),
      defaultStock: z.number(),
      syncIntervalMinutes: z.number(),
      enabled: z.boolean(),
      lastSyncedAt: z.string().nullable(),
      productCount: z.number(),
      credentialsConfigured: z.boolean(),
    }),
  ),
});

const finders = {
  "zjmf-upstream.upstreams": {
    handler: async (_input: Record<string, unknown>, ctx: FinderContext) =>
      ctx.api.get("/zjmf-upstream/admin/upstreams", upstreamListSchema),
  },
};

export const frontend: FrontendPackage = {
  finders,
  ui: {
    actions: [
      {
        id: "zjmf-upstream.create",
        method: "POST",
        path: "/zjmf-upstream/admin/upstreams",
        permission: "zjmf-upstream.admin",
        input: [
          { name: "name", type: "string", required: true, maxLength: 191 },
          { name: "baseUrl", type: "string", required: true, maxLength: 191 },
          { name: "protocol", type: "string", required: true, maxLength: 8 },
          { name: "username", type: "string", required: true, maxLength: 191 },
          { name: "password", type: "string", required: true, maxLength: 191 },
          { name: "currency", type: "string", required: true, maxLength: 8 },
          {
            name: "markupBps",
            type: "integer",
            required: true,
            min: 0,
            max: 100000,
          },
          {
            name: "defaultStock",
            type: "integer",
            required: true,
            min: 1,
            max: 1000000,
          },
          {
            name: "syncIntervalMinutes",
            type: "integer",
            required: true,
            min: 15,
            max: 1440,
          },
        ],
      },
      {
        id: "zjmf-upstream.sync",
        method: "POST",
        path: "/zjmf-upstream/admin/upstreams/sync",
        permission: "zjmf-upstream.admin",
        input: [
          { name: "sourceId", type: "string", required: true, maxLength: 191 },
        ],
      },
      {
        id: "zjmf-upstream.delete",
        method: "DELETE",
        path: "/zjmf-upstream/admin/upstreams/:id",
        permission: "zjmf-upstream.admin",
        input: [{ name: "id", type: "string", required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: "/overview",
        component: "admin/summary",
        permission: "zjmf-upstream.admin",
        nav: { label: "概览", group: "上游", order: 0 },
        data: [{ finder: "zjmf-upstream.upstreams", as: "upstreams" }],
      },
      {
        path: "/connections",
        component: "admin/overview",
        permission: "zjmf-upstream.admin",
        nav: { label: "上游连接", group: "上游", order: 10 },
        data: [{ finder: "zjmf-upstream.upstreams", as: "upstreams" }],
      },
    ],
  },
};

export default frontend;
