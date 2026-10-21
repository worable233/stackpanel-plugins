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
} from '@stackpanel/ui';

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
interface Inventory {
  instances: Instance[];
  accounts: { id: string; name: string; enabled: boolean }[];
  errors: { sourceName: string; message: string }[];
}
const states: Record<string, string> = {
  ACTIVE: '已开通',
  SUSPENDED: '已暂停',
  PROVISIONING: '开通中',
  PENDING_PROVISION: '待开通',
  TERMINATED: '已终止',
  FAILED: '开通失败',
};
export function UpstreamInstancesPage(props: AdminPageComponentProps) {
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
  return (
    <main className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="上游实例"
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
                  setRefreshError('刷新失败，当前仍显示上次结果，请重试。');
                }
              })
            }
          >
            {pending ? '刷新中…' : '刷新实例'}
          </Button>
        }
      />
      {refreshError ? (
        <p role="alert" className="text-sm text-destructive">
          {refreshError}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        展示所有已配置上游账号的已有实例，包括未关联本地商品的实例。刷新只读取资产，不会创建订单或开通实例。
      </p>
      {!data ? (
        <p role="alert">实例加载失败，请刷新重试。</p>
      ) : (
        <>
          {data.errors.map((error, index) => (
            <p
              key={`${error.sourceName}-${index}`}
              role="alert"
              className="text-sm text-destructive"
            >
              {error.sourceName}：{error.message}
            </p>
          ))}
          <FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field>
              <Label htmlFor="instance-lifecycle">实例状态</Label>
              <Select
                id="instance-lifecycle"
                value={lifecycle}
                onChange={(event) => {
                  setLifecycle(event.target.value);
                  setPage(1);
                }}
              >
                <option value="current">当前实例</option>
                <option value="history">已取消 / 已终止</option>
                <option value="all">全部记录</option>
              </Select>
            </Field>
            <Field>
              <Label htmlFor="instance-search">搜索实例</Label>
              <Input
                id="instance-search"
                placeholder="名称、IP、实例编号或商品"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field>
              <Label htmlFor="instance-source">上游账号</Label>
              <Select
                id="instance-source"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">全部账号</option>
                {data.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.enabled ? '' : '（已停用）'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <Label htmlFor="instance-mapping">本地商品关联</Label>
              <Select
                id="instance-mapping"
                value={mapping}
                onChange={(event) => {
                  setMapping(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">全部实例</option>
                <option value="mapped">已关联商品</option>
                <option value="unmapped">未关联商品</option>
              </Select>
            </Field>
          </FieldGroup>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            共 {data.instances.length} 个实例，当前筛选 {rows.length} 个
            {data.errors.length ? ' · 部分连接读取失败' : ''}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">上游已有实例及商品和用户绑定状态</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {[
                    '实例 / IP',
                    '上游账号',
                    '上游商品',
                    '本地商品',
                    '状态',
                    '开通时间',
                    '到期时间',
                    '用户归属',
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
                      {item.productName ?? '未知商品'}
                      <p className="text-xs text-muted-foreground">
                        {item.productId ? `#${item.productId}` : '上游未返回商品编号'}
                      </p>
                    </td>
                    <td className="px-3 py-4">
                      {item.products.length ? (
                        item.products.map((product) => <p key={product.id}>{product.name}</p>)
                      ) : (
                        <StatusBadge tone="neutral">未关联商品</StatusBadge>
                      )}
                    </td>
                    <td className="px-3 py-4">
                      <StatusBadge tone={item.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                        {item.statusLabel ??
                          states[item.status ?? ''] ??
                          item.statusLabel ??
                          '未知'}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-4 whitespace-nowrap">
                      {item.openedAt && Number.isFinite(Date.parse(item.openedAt))
                        ? new Date(item.openedAt).toLocaleString('zh-CN', {
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
                        ? new Date(item.expiresAt).toLocaleString('zh-CN', {
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
                        '归属读取不可用'
                      ) : item.boundUserId ? (
                        <Link
                          className="underline underline-offset-4"
                          href={`/admin/users/${encodeURIComponent(item.boundUserId)}`}
                        >
                          查看绑定用户
                        </Link>
                      ) : (
                        '未绑定用户'
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-muted-foreground">
                      {data.errors.length ? '已成功读取的连接中没有匹配实例' : '暂无匹配实例'}
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
                上一页
              </Button>
              <span className="text-sm">
                {current} / {Math.ceil(rows.length / 25)}
              </span>
              <Button
                variant="outline"
                disabled={current * 25 >= rows.length}
                onClick={() => setPage(current + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
