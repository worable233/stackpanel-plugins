'use client';
import { SectionTitle } from '@stackpanel/ui';
import { UpstreamInstancesPage } from './instances.js';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { FeatureOverview } from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Select,
  Field,
} from '@stackpanel/ui';

interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  downstreamUrl?: string;
  protocol: 'finance' | 'v10';
  currency: string;
  markupBps: number;
  defaultStock: number;
  syncIntervalMinutes: number;
  enabled: boolean;
  allowUnverifiedV10Routes?: boolean;
  v10Module?: 'auto' | 'mf_cloud' | 'remf_cloud' | 'mf_dcim' | 'idcsmart_common';
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
  const update = props.actions['zjmf-upstream.update'];
  const sync = props.actions['zjmf-upstream.sync'];
  const remove = props.actions['zjmf-upstream.delete'];
  const upstreams = result?.upstreams ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Upstream | null>(null);

  return (
    <main className="w-full space-y-8">
      <PageHeader
        title="魔方上游"
        actions={create ? <Button onClick={() => setCreateOpen(true)}>添加上游</Button> : null}
      />

      {result?.secretsEnabled === false ? (
        <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          未配置平台加密密钥，无法保存上游账号。
        </div>
      ) : null}

      {create ? (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent
            closeLabel="关闭"
            className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-xl !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right"
          >
            <DialogHeader>
              <DialogTitle>添加上游</DialogTitle>
              <DialogDescription>填写上游接口和同步参数。</DialogDescription>
            </DialogHeader>
            <form action={create} className="grid gap-4 py-4 sm:grid-cols-2">
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
              <Field>
                <Label htmlFor="zjmf-downstream-url">本平台公开地址（下游关联）</Label>
                <Input
                  id="zjmf-downstream-url"
                  name="downstreamUrl"
                  placeholder="https://panel.example.com"
                />
              </Field>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-v10-module">V10 模块家族</Label>
                <Select id="zjmf-v10-module" name="v10Module" defaultValue="auto">
                  <option value="auto">自动探测（推荐）</option>
                  <option value="mf_cloud">mf_cloud（直营云）</option>
                  <option value="remf_cloud">remf_cloud（代理云）</option>
                  <option value="mf_dcim">mf_dcim（物理机）</option>
                  <option value="idcsmart_common">idcsmart_common（通用）</option>
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
                <Input
                  id="zjmf-stock"
                  name="defaultStock"
                  type="number"
                  defaultValue="1000000"
                  min="1"
                />
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
              <div className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 sm:col-span-2">
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    name="allowUnverifiedV10Routes"
                    value="true"
                    className="mt-0.5 size-4 accent-destructive"
                  />
                  <span>
                    <span className="font-medium text-destructive">
                      允许调用未取证的 V10 路由（换商品）
                    </span>
                    <br />
                    服务生命周期（开关机/重装/VNC/续费/快照/备份）已按
                    <code>console/v1/&lt;family&gt;</code> 源码契约实现，无需勾选。
                    这里只放开仍未取证的「换商品」，默认关闭。
                  </span>
                </label>
              </div>
              <Button type="submit" className="sm:col-span-2">
                添加上游
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {update ? (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent
            closeLabel="关闭"
            className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-xl !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right"
          >
            <DialogHeader>
              <DialogTitle>编辑上游</DialogTitle>
              <DialogDescription>
                更新连接与同步参数。留空账号和密码会保留现有凭据。
              </DialogDescription>
            </DialogHeader>
            {editing ? (
              <form action={update} className="grid gap-4 py-4 sm:grid-cols-2">
                <input type="hidden" name="id" value={editing.id} />
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-name">名称 *</Label>
                  <Input id="zjmf-edit-name" name="name" defaultValue={editing.name} required />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-base-url">接口地址 *</Label>
                  <Input
                    id="zjmf-edit-base-url"
                    name="baseUrl"
                    defaultValue={editing.baseUrl}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-protocol">协议</Label>
                  <Select id="zjmf-edit-protocol" name="protocol" defaultValue={editing.protocol}>
                    <option value="finance">魔方财务 V1</option>
                    <option value="v10">魔方财务 V10</option>
                  </Select>
                </div>
                <Field>
                  <Label htmlFor="zjmf-edit-downstream-url">本平台公开地址（下游关联）</Label>
                  <Input
                    id="zjmf-edit-downstream-url"
                    name="downstreamUrl"
                    defaultValue={editing.downstreamUrl ?? ''}
                    placeholder="https://panel.example.com"
                  />
                </Field>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-v10-module">V10 模块家族</Label>
                  <Select
                    id="zjmf-edit-v10-module"
                    name="v10Module"
                    defaultValue={editing.v10Module ?? 'auto'}
                  >
                    <option value="auto">自动探测（推荐）</option>
                    <option value="mf_cloud">mf_cloud（直营云）</option>
                    <option value="remf_cloud">remf_cloud（代理云）</option>
                    <option value="mf_dcim">mf_dcim（物理机）</option>
                    <option value="idcsmart_common">idcsmart_common（通用）</option>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-username">账号</Label>
                  <Input
                    id="zjmf-edit-username"
                    name="username"
                    autoComplete="off"
                    placeholder="留空则不修改"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-password">密码</Label>
                  <Input
                    id="zjmf-edit-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="留空则不修改"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-currency">币种 *</Label>
                  <Input
                    id="zjmf-edit-currency"
                    name="currency"
                    defaultValue={editing.currency}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-markup">加价（基点）</Label>
                  <Input
                    id="zjmf-edit-markup"
                    name="markupBps"
                    type="number"
                    defaultValue={editing.markupBps}
                    min="0"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-stock">库存</Label>
                  <Input
                    id="zjmf-edit-stock"
                    name="defaultStock"
                    type="number"
                    defaultValue={editing.defaultStock}
                    min="1"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-interval">同步间隔（分钟）</Label>
                  <Input
                    id="zjmf-edit-interval"
                    name="syncIntervalMinutes"
                    type="number"
                    defaultValue={editing.syncIntervalMinutes}
                    min="15"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="zjmf-edit-unverified-routes">允许未取证 V10 路由</Label>
                  <Select
                    id="zjmf-edit-unverified-routes"
                    name="allowUnverifiedV10Routes"
                    defaultValue={String(Boolean(editing.allowUnverifiedV10Routes))}
                  >
                    <option value="false">关闭</option>
                    <option value="true">开启（仅换商品）</option>
                  </Select>
                </div>
                <Button type="submit" className="sm:col-span-2">
                  保存更改
                </Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}

      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <SectionTitle>已接入上游</SectionTitle>
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
                    {upstream.allowUnverifiedV10Routes ? (
                      <span className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        实验性：未取证 V10 换商品
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{upstream.baseUrl}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {upstream.productCount} 个商品 · 加价 {formatPercent(upstream.markupBps)} ·{' '}
                    {upstream.syncIntervalMinutes} 分钟
                  </p>
                </div>
                {update || sync || remove ? (
                  <div className="flex items-center gap-2">
                    {update ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(upstream)}
                      >
                        编辑
                      </Button>
                    ) : null}
                    {sync ? (
                      <form action={sync}>
                        <input type="hidden" name="sourceId" value={upstream.id} />
                        <SyncSubmitButton />
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
                          <form
                            action={remove}
                            className="mt-3 flex items-center justify-end gap-2"
                          >
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

function SyncSubmitButton(): ReactElement {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? '正在同步…' : '立即同步'}
    </Button>
  );
}

function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function UpstreamOverview(props: AdminPageComponentProps) {
  const data = props.data.upstreams as
    | {
        upstreams: Array<{
          id: string;
          name: string;
          enabled: boolean;
          credentialsConfigured: boolean;
          productCount: number;
          lastSyncedAt: string | null;
        }>;
      }
    | undefined;
  const connections = data?.upstreams ?? [];
  return (
    <FeatureOverview
      title="概览"
      description="查看上游连接、凭据与商品同步状态。"
      unavailable={!data}
      labels={{
        unavailable: '暂时无法读取上游连接状态。',
        manageTitle: '上游管理',
        manageDescription: '管理连接、凭据、同步和定价规则。',
        activityDescription: '最近上游连接的同步状态。',
        empty: '还没有上游连接。',
      }}
      metrics={[
        { label: '上游连接', value: connections.length },
        {
          label: '已启用',
          value: connections.filter((item) => item.enabled).length,
        },
        {
          label: '已配置凭据',
          value: connections.filter((item) => item.credentialsConfigured).length,
        },
      ]}
      links={[
        {
          label: '上游实例',
          description: '查看所有已有实例及商品关联、用户归属。',
          href: '/admin/plugin/zjmf-upstream/instances',
        },
        {
          label: '上游连接',
          description: '管理连接、凭据、同步和定价规则。',
          href: '/admin/plugin/zjmf-upstream/connections',
        },
      ]}
      activity={{
        title: '同步状态',
        items: connections.slice(0, 5).map((item) => ({
          label: item.name,
          detail: item.lastSyncedAt
            ? new Date(item.lastSyncedAt).toLocaleString('zh-CN')
            : '尚未同步',
        })),
      }}
    />
  );
}

export const adminPages = {
  'admin/instances': UpstreamInstancesPage,
  'admin/summary': UpstreamOverview,
  'admin/overview': ZjmfUpstreamAdminPage,
} as const;
