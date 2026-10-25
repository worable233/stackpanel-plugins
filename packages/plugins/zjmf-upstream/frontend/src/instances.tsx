'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import {
  PageHeader,
  Button,
  Input,
  Select,
  Label,
  Field,
  FieldGroup,
  StatusBadge,
  InlineError,
} from '@stackpanel/ui';
import { t } from './i18n.js';

interface Instance {
  id: string;
  name: string;
  productName?: string | null;
  productId?: string | null;
  sourceRef?: string | null;
  sourceName: string;
  status?: string | null;
  statusLabel?: string | null;
  host?: string | null;
  expiresAt?: string | null;
  openedAt?: string | null;
  products: { id: string; name: string }[];
  boundUserId: string | null;
  boundServiceId: string | null;
  bindingKnown: boolean;
}
interface InventoryError {
  sourceName: string;
  code: string;
  detail?: string | null;
}
interface Inventory {
  instances: Instance[];
  accounts: { id: string; name: string; enabled: boolean }[];
  errors: InventoryError[];
}

/**
 * 上游实例读取失败只回稳定 code（ADR-0012），文案由本包 catalog 拥有。
 * 不要把上游原文或服务端拼好的中文直接上屏。
 */
const INVENTORY_ERROR_KEYS: Record<string, string> = {
  'zjmf.instances_unavailable': 'instances.errorSource',
  'zjmf.instance_detail_unavailable': 'instances.errorDetail',
};

type Translator = (key: string, params?: Record<string, string | number>) => string;

function inventoryErrorText(error: InventoryError, tr: Translator) {
  return tr(INVENTORY_ERROR_KEYS[error.code] ?? 'instances.errorUnknown', {
    source: error.sourceName,
    detail: error.detail ?? '',
    code: error.code,
  });
}

/** Instance status → message id; unknown statuses fall back to the raw value. */
const STATE_KEYS: Record<string, string> = {
  ACTIVE: 'status.active',
  SUSPENDED: 'status.suspended',
  PROVISIONING: 'status.provisioning',
  PENDING_PROVISION: 'status.pendingProvision',
  TERMINATED: 'status.terminated',
  FAILED: 'status.failed',
};

export function UpstreamInstancesPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const locale = props.locale ?? 'zh-CN';
  const [refreshed, setRefreshed] = useState<Inventory | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const data = refreshed ?? (props.data.inventory as Inventory | undefined);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [mapping, setMapping] = useState('all');
  const [lifecycle, setLifecycle] = useState('current');
  const [page, setPage] = useState(1);
  const [pending, start] = useTransition();
  const rows = (data?.instances ?? []).filter(
    (item) =>
      (lifecycle === 'all' ||
        (lifecycle === 'history' ? item.status === 'TERMINATED' : item.status !== 'TERMINATED')) &&
      (source === 'all' || item.sourceRef === source) &&
      (mapping === 'all' ||
        (mapping === 'mapped' ? item.products.length > 0 : item.products.length === 0)) &&
      [
        item.name,
        item.id,
        item.host,
        item.productName,
        item.sourceName,
        ...item.products.map((product) => product.name),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 25)));
  const statusText = (item: Instance): string => {
    if (item.statusLabel) return item.statusLabel;
    const key = item.status ? STATE_KEYS[item.status] : undefined;
    return key ? tr(key) : tr('status.unknown');
  };
  return (
    <main className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={tr('instances.title')}
        actions={
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setRefreshError('');
                try {
                  const response = await fetch('/api/plugins/zjmf-upstream/admin/instances', {
                    cache: 'no-store',
                  });
                  if (!response.ok) throw new Error();
                  const result = (await response.json()) as Inventory;
                  if (
                    !Array.isArray(result.instances) ||
                    !Array.isArray(result.accounts) ||
                    !Array.isArray(result.errors)
                  )
                    throw new Error();
                  setRefreshed(result);
                  setPage(1);
                } catch {
                  setRefreshError(tr('instances.refreshFailed'));
                }
              })
            }
          >
            {pending ? tr('instances.refreshing') : tr('instances.refresh')}
          </Button>
        }
      />
      {refreshError ? <InlineError>{refreshError}</InlineError> : null}
      <p className="text-sm text-muted-foreground">{tr('instances.description')}</p>
      {!data ? (
        <InlineError>{tr('instances.loadFailed')}</InlineError>
      ) : (
        <>
          {data.errors.map((error, index) => (
            <InlineError key={`${error.sourceName}-${index}`}>
              {inventoryErrorText(error, tr)}
            </InlineError>
          ))}
          <FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field>
              <Label htmlFor="instance-lifecycle">{tr('filter.lifecycle')}</Label>
              <Select
                id="instance-lifecycle"
                value={lifecycle}
                onChange={(event) => {
                  setLifecycle(event.target.value);
                  setPage(1);
                }}
              >
                <option value="current">{tr('filter.lifecycleCurrent')}</option>
                <option value="history">{tr('filter.lifecycleHistory')}</option>
                <option value="all">{tr('filter.lifecycleAll')}</option>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="instance-search">{tr('filter.search')}</Label>
              <Input
                id="instance-search"
                placeholder={tr('filter.searchPlaceholder')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field>
              <Label htmlFor="instance-source">{tr('filter.source')}</Label>
              <Select
                id="instance-source"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">{tr('filter.sourceAll')}</option>
                {data.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.enabled ? '' : tr('filter.sourceDisabled')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <Label htmlFor="instance-mapping">{tr('filter.mapping')}</Label>
              <Select
                id="instance-mapping"
                value={mapping}
                onChange={(event) => {
                  setMapping(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">{tr('filter.mappingAll')}</option>
                <option value="mapped">{tr('filter.mappingMapped')}</option>
                <option value="unmapped">{tr('filter.mappingUnmapped')}</option>
              </Select>
            </Field>
          </FieldGroup>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {tr('table.summary', { total: data.instances.length, shown: rows.length })}
            {data.errors.length ? tr('table.summaryPartial') : ''}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{tr('table.caption')}</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {[
                    tr('table.colInstance'),
                    tr('table.colSource'),
                    tr('table.colUpstreamProduct'),
                    tr('table.colLocalProduct'),
                    tr('table.colStatus'),
                    tr('table.colOpenedAt'),
                    tr('table.colExpiresAt'),
                    tr('table.colOwner'),
                  ].map((title) => (
                    <th key={title} scope="col" className="px-3 py-3 font-medium whitespace-nowrap">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice((current - 1) * 25, current * 25).map((item) => (
                  <tr
                    key={JSON.stringify([item.sourceRef, item.id])}
                    className="border-b align-top"
                  >
                    <td className="px-3 py-4">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        #{item.id}
                        {item.host ? ` · ${item.host}` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-4">{item.sourceName}</td>
                    <td className="px-3 py-4">
                      {item.productName ?? tr('table.unknownProduct')}
                      <p className="text-xs text-muted-foreground">
                        {item.productId ? `#${item.productId}` : tr('table.noProductId')}
                      </p>
                    </td>
                    <td className="px-3 py-4">
                      {item.products.length ? (
                        item.products.map((product) => <p key={product.id}>{product.name}</p>)
                      ) : (
                        <StatusBadge tone="neutral">{tr('table.unmapped')}</StatusBadge>
                      )}
                    </td>
                    <td className="px-3 py-4">
                      <StatusBadge tone={item.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                        {statusText(item)}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap">
                      {item.openedAt && Number.isFinite(Date.parse(item.openedAt))
                        ? new Date(item.openedAt).toLocaleString(locale, {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })
                        : '—'}
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap">
                      {item.expiresAt && Number.isFinite(Date.parse(item.expiresAt))
                        ? new Date(item.expiresAt).toLocaleString(locale, {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })
                        : '—'}
                    </td>
                    <td className="px-3 py-4">
                      {!item.bindingKnown ? (
                        tr('table.bindingUnavailable')
                      ) : item.boundUserId ? (
                        <Link
                          className="underline underline-offset-4"
                          href={`/admin/users/${encodeURIComponent(item.boundUserId)}`}
                        >
                          {tr('table.viewBoundUser')}
                        </Link>
                      ) : (
                        tr('table.unbound')
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
                      {data.errors.length ? tr('table.noMatchPartial') : tr('table.noMatch')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > 25 && (
            <div className="flex items-center justify-end gap-3">
              <Button
                variant="outline"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                {tr('pager.prev')}
              </Button>
              <span className="text-sm">
                {current} / {Math.ceil(rows.length / 25)}
              </span>
              <Button
                variant="outline"
                disabled={current * 25 >= rows.length}
                onClick={() => setPage(current + 1)}
              >
                {tr('pager.next')}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
