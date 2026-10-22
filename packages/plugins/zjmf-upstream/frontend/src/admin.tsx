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
import { t } from './i18n.js';

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
  const tr = t(props.locale);
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
        title={tr('page.title')}
        actions={
          create ? <Button onClick={() => setCreateOpen(true)}>{tr('page.add')}</Button> : null
        }
      />

      {result?.secretsEnabled === false ? (
        <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {tr('page.secretsMissing')}
        </div>
      ) : null}

      {create ? (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent
            closeLabel={tr('dialog.close')}
            className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-xl !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right"
          >
            <DialogHeader>
              <DialogTitle>{tr('create.title')}</DialogTitle>
              <DialogDescription>{tr('create.description')}</DialogDescription>
            </DialogHeader>
            <form action={create} className="grid gap-4 py-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-name">{tr('form.name')}</Label>
                <Input id="zjmf-name" name="name" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-base-url">{tr('form.baseUrl')}</Label>
                <Input
                  id="zjmf-base-url"
                  name="baseUrl"
                  placeholder="https://billing.example.com"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-protocol">{tr('form.protocol')}</Label>
                <Select id="zjmf-protocol" name="protocol" defaultValue="finance">
                  <option value="finance">{tr('form.protocolFinance')}</option>
                  <option value="v10">{tr('form.protocolV10')}</option>
                </Select>
              </div>
              <Field>
                <Label htmlFor="zjmf-downstream-url">{tr('form.downstreamUrl')}</Label>
                <Input
                  id="zjmf-downstream-url"
                  name="downstreamUrl"
                  placeholder="https://panel.example.com"
                />
              </Field>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-v10-module">{tr('form.v10Module')}</Label>
                <Select id="zjmf-v10-module" name="v10Module" defaultValue="auto">
                  <option value="auto">{tr('form.v10ModuleAuto')}</option>
                  <option value="mf_cloud">{tr('form.v10ModuleMfCloud')}</option>
                  <option value="remf_cloud">{tr('form.v10ModuleRemfCloud')}</option>
                  <option value="mf_dcim">{tr('form.v10ModuleMfDcim')}</option>
                  <option value="idcsmart_common">{tr('form.v10ModuleIdcsmart')}</option>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-username">{tr('form.username')}</Label>
                <Input id="zjmf-username" name="username" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-password">{tr('form.password')}</Label>
                <Input id="zjmf-password" name="password" type="password" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-currency">{tr('form.currency')}</Label>
                <Input id="zjmf-currency" name="currency" defaultValue="CNY" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-markup">{tr('form.markup')}</Label>
                <Input id="zjmf-markup" name="markupBps" type="number" defaultValue="0" min="0" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-stock">{tr('form.stock')}</Label>
                <Input
                  id="zjmf-stock"
                  name="defaultStock"
                  type="number"
                  defaultValue="1000000"
                  min="1"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="zjmf-interval">{tr('form.interval')}</Label>
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
                    <span className="font-medium text-destructive">{tr('form.unverified')}</span>
                    <br />
                    {tr('form.unverifiedHelpBefore')}
                    <code>console/v1/&lt;family&gt;</code>
                    {tr('form.unverifiedHelpAfter')}
                  </span>
                </label>
              </div>
              <Button type="submit" className="sm:col-span-2">
                {tr('create.submit')}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {update ? (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent
            closeLabel={tr('dialog.close')}
            className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !max-w-xl !translate-x-0 !translate-y-0 !rounded-none !border-y-0 !border-r-0 data-open:slide-in-from-right data-closed:slide-out-to-right"
          >
            <DialogHeader>
              <DialogTitle>{tr('edit.title')}</DialogTitle>
              <DialogDescription>{tr('edit.description')}</DialogDescription>
            </DialogHeader>
            {editing ? (
              <form action={update} className="grid gap-4 py-4 sm:grid-cols-2">
                <input type="hidden" name="id" value={editing.id} />
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-name">{tr('form.name')}</Label>
                  <Input id="zjmf-edit-name" name="name" defaultValue={editing.name} required />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-base-url">{tr('form.baseUrl')}</Label>
                  <Input
                    id="zjmf-edit-base-url"
                    name="baseUrl"
                    defaultValue={editing.baseUrl}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-protocol">{tr('form.protocol')}</Label>
                  <Select id="zjmf-edit-protocol" name="protocol" defaultValue={editing.protocol}>
                    <option value="finance">{tr('form.protocolFinance')}</option>
                    <option value="v10">{tr('form.protocolV10')}</option>
                  </Select>
                </div>
                <Field>
                  <Label htmlFor="zjmf-edit-downstream-url">{tr('form.downstreamUrl')}</Label>
                  <Input
                    id="zjmf-edit-downstream-url"
                    name="downstreamUrl"
                    defaultValue={editing.downstreamUrl ?? ''}
                    placeholder="https://panel.example.com"
                  />
                </Field>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-v10-module">{tr('form.v10Module')}</Label>
                  <Select
                    id="zjmf-edit-v10-module"
                    name="v10Module"
                    defaultValue={editing.v10Module ?? 'auto'}
                  >
                    <option value="auto">{tr('form.v10ModuleAuto')}</option>
                    <option value="mf_cloud">{tr('form.v10ModuleMfCloud')}</option>
                    <option value="remf_cloud">{tr('form.v10ModuleRemfCloud')}</option>
                    <option value="mf_dcim">{tr('form.v10ModuleMfDcim')}</option>
                    <option value="idcsmart_common">{tr('form.v10ModuleIdcsmart')}</option>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-username">{tr('edit.username')}</Label>
                  <Input
                    id="zjmf-edit-username"
                    name="username"
                    autoComplete="off"
                    placeholder={tr('edit.keepUnchanged')}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-password">{tr('edit.password')}</Label>
                  <Input
                    id="zjmf-edit-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={tr('edit.keepUnchanged')}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-currency">{tr('form.currency')}</Label>
                  <Input
                    id="zjmf-edit-currency"
                    name="currency"
                    defaultValue={editing.currency}
                    required
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-markup">{tr('form.markup')}</Label>
                  <Input
                    id="zjmf-edit-markup"
                    name="markupBps"
                    type="number"
                    defaultValue={editing.markupBps}
                    min="0"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-stock">{tr('form.stock')}</Label>
                  <Input
                    id="zjmf-edit-stock"
                    name="defaultStock"
                    type="number"
                    defaultValue={editing.defaultStock}
                    min="1"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="zjmf-edit-interval">{tr('form.interval')}</Label>
                  <Input
                    id="zjmf-edit-interval"
                    name="syncIntervalMinutes"
                    type="number"
                    defaultValue={editing.syncIntervalMinutes}
                    min="15"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="zjmf-edit-unverified-routes">{tr('edit.unverified')}</Label>
                  <Select
                    id="zjmf-edit-unverified-routes"
                    name="allowUnverifiedV10Routes"
                    defaultValue={String(Boolean(editing.allowUnverifiedV10Routes))}
                  >
                    <option value="false">{tr('edit.unverifiedOff')}</option>
                    <option value="true">{tr('edit.unverifiedOn')}</option>
                  </Select>
                </div>
                <Button type="submit" className="sm:col-span-2">
                  {tr('edit.submit')}
                </Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}

      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <SectionTitle>{tr('list.title')}</SectionTitle>
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
                      <span className="text-xs text-destructive">
                        {tr('list.credentialsMissing')}
                      </span>
                    ) : null}
                    {upstream.allowUnverifiedV10Routes ? (
                      <span className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        {tr('list.experimental')}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{upstream.baseUrl}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tr('list.meta', {
                      products: upstream.productCount,
                      markup: formatPercent(upstream.markupBps),
                      minutes: upstream.syncIntervalMinutes,
                    })}
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
                        {tr('list.edit')}
                      </Button>
                    ) : null}
                    {sync ? (
                      <form action={sync}>
                        <input type="hidden" name="sourceId" value={upstream.id} />
                        <SyncSubmitButton locale={props.locale} />
                      </form>
                    ) : null}
                    {remove ? (
                      <details className="relative">
                        <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-destructive/60 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 [&::-webkit-details-marker]:hidden">
                          {tr('list.delete')}
                        </summary>
                        <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border bg-card p-3 shadow-lg">
                          <p className="text-xs text-muted-foreground">
                            {tr('list.deleteConfirm')}
                          </p>
                          <form
                            action={remove}
                            className="mt-3 flex items-center justify-end gap-2"
                          >
                            <input type="hidden" name="id" value={upstream.id} />
                            <Button type="submit" variant="destructive" size="sm">
                              {tr('list.deleteSubmit')}
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
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">{tr('list.empty')}</p>
        )}
      </section>
    </main>
  );
}

function SyncSubmitButton({ locale }: { locale: string | undefined }): ReactElement {
  const { pending } = useFormStatus();
  const tr = t(locale);
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? tr('list.syncing') : tr('list.sync')}
    </Button>
  );
}

function formatPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function UpstreamOverview(props: AdminPageComponentProps) {
  const tr = t(props.locale);
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
      title={tr('overview.title')}
      description={tr('overview.description')}
      unavailable={!data}
      labels={{
        unavailable: tr('overview.unavailable'),
        manageTitle: tr('overview.manageTitle'),
        manageDescription: tr('overview.manageDescription'),
        activityDescription: tr('overview.activityDescription'),
        empty: tr('overview.empty'),
      }}
      metrics={[
        { label: tr('overview.metricConnections'), value: connections.length },
        {
          label: tr('overview.metricEnabled'),
          value: connections.filter((item) => item.enabled).length,
        },
        {
          label: tr('overview.metricCredentials'),
          value: connections.filter((item) => item.credentialsConfigured).length,
        },
      ]}
      links={[
        {
          label: tr('overview.linkInstances'),
          description: tr('overview.linkInstancesDescription'),
          href: '/admin/plugin/zjmf-upstream/instances',
        },
        {
          label: tr('overview.linkConnections'),
          description: tr('overview.manageDescription'),
          href: '/admin/plugin/zjmf-upstream/connections',
        },
      ]}
      activity={{
        title: tr('overview.activityTitle'),
        items: connections.slice(0, 5).map((item) => ({
          label: item.name,
          detail: item.lastSyncedAt
            ? new Date(item.lastSyncedAt).toLocaleString(props.locale ?? 'zh-CN')
            : tr('overview.neverSynced'),
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
