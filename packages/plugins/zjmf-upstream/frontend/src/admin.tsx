'use client';

import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, Input, Label, PageHeader, Select } from '@stackpanel/ui';

interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  protocol: 'finance' | 'v10';
  currency: string;
  markupBps: number;
  defaultStock: number;
  syncIntervalMinutes: number;
  enabled: boolean;
  lastSyncedAt: string | null;
  productCount: number;
  credentialsConfigured: boolean;
}

interface UpstreamListResult {
  secretsEnabled: boolean;
  upstreams: Upstream[];
}

export function ZjmfUpstreamAdminPage(props: AdminPageComponentProps): ReactElement {
  const result = props.data.upstreams as UpstreamListResult | undefined;
  const create = props.actions['zjmf-upstream.create'];
  const sync = props.actions['zjmf-upstream.sync'];
  const remove = props.actions['zjmf-upstream.delete'];
  const upstreams = result?.upstreams ?? [];

  return (
    <main className="w-full space-y-8">
      <PageHeader title="魔方上游" description="同步魔方财务 V1 与 V10 商品到商店。" />

      {result?.secretsEnabled === false ? (
        <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          未配置平台加密密钥，无法保存上游账号。
        </div>
      ) : null}

      {create ? (
        <form
          action={create}
          className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-name">名称 *</Label>
            <Input id="zjmf-name" name="name" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-base-url">接口地址 *</Label>
            <Input
              id="zjmf-base-url"
              name="baseUrl"
              placeholder="https://billing.example.com"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-protocol">协议</Label>
            <Select id="zjmf-protocol" name="protocol" defaultValue="finance">
              <option value="finance">魔方财务 V1</option>
              <option value="v10">魔方财务 V10</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-username">账号 *</Label>
            <Input id="zjmf-username" name="username" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-password">密码 *</Label>
            <Input id="zjmf-password" name="password" type="password" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-currency">币种 *</Label>
            <Input id="zjmf-currency" name="currency" defaultValue="CNY" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-markup">加价（基点）</Label>
            <Input id="zjmf-markup" name="markupBps" type="number" defaultValue="0" min="0" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-stock">库存</Label>
            <Input id="zjmf-stock" name="defaultStock" type="number" defaultValue="1000000" min="1" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zjmf-interval">同步间隔（分钟）</Label>
            <Input
              id="zjmf-interval"
              name="syncIntervalMinutes"
              type="number"
              defaultValue="360"
              min="15"
            />
          </div>
          <Button type="submit" className="sm:col-span-2 lg:col-span-3 lg:w-fit">
            添加上游
          </Button>
        </form>
      ) : null}

      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">已接入上游</h2>
        </div>
        {upstreams.length > 0 ? (
          <div className="divide-y">
            {upstreams.map((upstream) => (
              <article
                key={upstream.id}
                className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{upstream.name}</h3>
                    <span className="rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {upstream.protocol === 'finance' ? 'V1' : 'V10'}
                    </span>
                    {!upstream.credentialsConfigured ? (
                      <span className="text-xs text-destructive">未配置凭据</span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{upstream.baseUrl}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {upstream.productCount} 个商品 · 加价 {formatPercent(upstream.markupBps)} ·{' '}
                    {upstream.syncIntervalMinutes} 分钟
                  </p>
                </div>
                {sync || remove ? (
                  <div className="flex items-center gap-2">
                    {sync ? (
                      <form action={sync}>
                        <input type="hidden" name="sourceId" value={upstream.id} />
                        <Button type="submit" variant="outline" size="sm">
                          立即同步
                        </Button>
                      </form>
                    ) : null}
                    {remove ? (
                      <details className="relative">
                        <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-destructive/60 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 [&::-webkit-details-marker]:hidden">
                          删除
                        </summary>
                        <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border bg-card p-3 shadow-lg">
                          <p className="text-xs text-muted-foreground">
                            将删除该上游及其映射的商品与凭证，此操作不可撤销。确认删除？
                          </p>
                          <form action={remove} className="mt-3 flex items-center justify-end gap-2">
                            <input type="hidden" name="id" value={upstream.id} />
                            <Button type="submit" variant="destructive" size="sm">
                              确认删除
                            </Button>
                          </form>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">还没有上游。</p>
        )}
      </section>
    </main>
  );
}

function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export const adminPages = {
  'admin/overview': ZjmfUpstreamAdminPage,
} as const;
