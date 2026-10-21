import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** Durable request fence. Never expires automatically: timeouts may have remote effects. */
export const provisioningJournalModel = defineModel({
  kind: 'zjmf-upstream/provisioning-journal',
  label: '上游开通请求记录',
  schema: z.object({
    upstreamId: z.string(),
    reference: z.string(),
    fingerprint: z.string(),
    sourceFingerprint: z.string().optional(),
    state: z.string(),
    providerServiceId: z.string().nullable(),
    invoiceId: z.string().nullable(),
    runtime: z.record(z.string(), z.unknown()),
  }),
  indexes: [{ fields: ['upstreamId'], types: { upstreamId: 'string' } }],
});
export const provisioningCartLockModel = defineModel({
  kind: 'zjmf-upstream/provisioning-cart-lock',
  label: '上游购物车排他锁',
  schema: z.object({ reference: z.string() }),
});
export interface ProvisioningJournalData {
  sourceFingerprint?: string;
  upstreamId: string;
  reference: string;
  fingerprint: string;
  state: string;
  providerServiceId: string | null;
  invoiceId: string | null;
  runtime: Record<string, unknown>;
}

/** 魔方上游实例。 */
export const zjmfUpstreamModel = defineModel({
  kind: 'zjmf-upstream/upstream',
  label: '魔方上游',
  schema: z.object({
    name: z.string(),
    baseUrl: z.string(),
    downstreamUrl: z.string().optional(),
    protocol: z.enum(['finance', 'v10']),
    currency: z.string().default('CNY'),
    markupBps: z.number().int().default(0),
    defaultStock: z.number().int().default(1_000_000),
    syncIntervalMinutes: z.number().int().default(360),
    enabled: z.boolean().default(true),
    syncState: z.enum(['IDLE', 'SYNCING']).default('IDLE'),
    /**
     * 实验开关：允许调用**未取证**的 V10 路由（换商品）。服务生命周期
     * （开关机/重装/VNC/续费/快照/备份）已有源码证据，不再受此开关限制。
     */
    allowUnverifiedV10Routes: z.boolean().default(false),
    /**
     * V10 console 路由家族：auto 表示按实例详情自动探测。
     * 显式指定可省掉每次请求的探测开销（见 `ZJMFV10Module`）。
     */
    v10Module: z
      .enum(['auto', 'mf_cloud', 'remf_cloud', 'mf_dcim', 'idcsmart_common'])
      .default('auto'),
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
  downstreamUrl?: string;
  name: string;
  baseUrl: string;
  protocol: 'finance' | 'v10';
  currency: string;
  markupBps: number;
  defaultStock: number;
  syncIntervalMinutes: number;
  enabled: boolean;
  syncState: 'IDLE' | 'SYNCING';
  allowUnverifiedV10Routes: boolean;
  /** V10 console 路由家族；auto 为自动探测。 */
  v10Module: 'auto' | 'mf_cloud' | 'remf_cloud' | 'mf_dcim' | 'idcsmart_common';
  lastAttemptAtMs?: number | null;
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
