import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** 魔方上游实例。 */
export const zjmfUpstreamModel = defineModel({
  kind: 'zjmf-upstream/upstream',
  label: '魔方上游',
  schema: z.object({
    name: z.string(),
    baseUrl: z.string(),
    protocol: z.enum(['finance', 'v10']),
    currency: z.string().default('CNY'),
    markupBps: z.number().int().default(0),
    defaultStock: z.number().int().default(1_000_000),
    syncIntervalMinutes: z.number().int().default(360),
    enabled: z.boolean().default(true),
    syncState: z.enum(['IDLE', 'SYNCING']).default('IDLE'),
    /** 上次同步尝试的 epoch 毫秒（同步锁的陈旧判定依赖数值比较）。 */
    lastAttemptAtMs: z.number().int().nullable().optional(),
    lastSyncedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['enabled'], types: { enabled: 'boolean' } },
    { fields: ['syncState'], types: { syncState: 'string' } },
    { fields: ['lastAttemptAtMs'], types: { lastAttemptAtMs: 'number' } },
  ],
});

/** 本地商品 ↔ 上游商品映射。 */
export const zjmfProductMappingModel = defineModel({
  kind: 'zjmf-upstream/product-mapping',
  label: '魔方商品映射',
  schema: z.object({
    upstreamId: z.string(),
    upstreamProductId: z.string(),
    productId: z.string(),
    sourcePrice: z.number().int().default(0),
    sourceCurrency: z.string().default('CNY'),
    sourceSnapshot: z.unknown().optional(),
    lastSyncedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['upstreamId'], types: { upstreamId: 'string' } },
    { fields: ['productId'], unique: true, types: { productId: 'string' } },
    { fields: ['upstreamProductId'], types: { upstreamProductId: 'string' } },
    {
      fields: ['upstreamId', 'upstreamProductId'],
      unique: true,
      types: { upstreamId: 'string', upstreamProductId: 'string' },
    },
  ],
});

/** 一次同步运行的记录。 */
export const zjmfSyncRunModel = defineModel({
  kind: 'zjmf-upstream/sync-run',
  label: '魔方同步记录',
  schema: z.object({
    upstreamId: z.string(),
    status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']).default('RUNNING'),
    created: z.number().int().default(0),
    updated: z.number().int().default(0),
    skipped: z.number().int().default(0),
    error: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
  }),
  indexes: [{ fields: ['upstreamId'], types: { upstreamId: 'string' } }],
});

/** 上游载荷类型。 */
export interface ZjmfUpstreamData {
  name: string;
  baseUrl: string;
  protocol: 'finance' | 'v10';
  currency: string;
  markupBps: number;
  defaultStock: number;
  syncIntervalMinutes: number;
  enabled: boolean;
  syncState: 'IDLE' | 'SYNCING';
  lastAttemptAtMs?: number | null;
  lastSyncedAt?: string | null;
}

export interface ZjmfProductMappingData {
  upstreamId: string;
  upstreamProductId: string;
  productId: string;
  sourcePrice: number;
  sourceCurrency: string;
  sourceSnapshot?: unknown;
  lastSyncedAt?: string | null;
}

export interface ZjmfSyncRunData {
  upstreamId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  created: number;
  updated: number;
  skipped: number;
  error?: string | null;
  completedAt?: string | null;
}
