'use client';
import { InlineError, InlineNotice } from './ui';
import { SectionTitle } from '@stackpanel/ui';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useEffect, useState, useTransition } from 'react';
import type { ReactElement } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import type { z } from 'zod';
import {
  Button,
  Card,
  CardHeader,
  CardContent,
  CardDescription,
  Field,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import {
  Save,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Activity,
  FileText,
  Server,
  Tags,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  CAPABILITY_OPTIONS,
  Empty,
  PROTOCOL_OPTIONS,
  Section,
  Stats,
  accountSchema,
  adminAccountsSchema,
  adminOverviewSchema,
  adminPricesSchema,
  adminBudgetLimitsSchema,
  adminEntitlementsSchema,
  adminModelMapsSchema,
  adminUsageLogRowSchema,
  adminUsageLogsSchema,
  budgetLimitSchema,
  entitlementSchema,
  modelMapSchema,
  capabilityLabel,
  money,
  protocolLabel,
  shortTime,
} from './ui';
import { t } from './i18n.js';

/**
 * 管理端交互页面（客户端 bundle）。
 *
 * 对应 `ui.adminRoutes` 中的 `component`：
 * - `admin/overview` → GatewayAdminOverview
 * - `admin/accounts` → GatewayAdminAccounts
 *
 * 构建脚本会把本文件编译为 `frontend/dist/admin.js`，并写入
 * `apps/web/src/lib/frontend-client-registry.ts`。
 */

type AccountRow = z.infer<typeof accountSchema>;
type Translator = (key: string, params?: Record<string, string | number>) => string;

/**
 * 反馈只能显示已本地化的文案，绝不显示原始异常正文（同内核契约：按 code 查文案）。
 *
 * 异常正文只进控制台，界面拿到调用方选定的 `tr(...)` 文案。
 */
function failure(cause: unknown, message: string): string {
  console.error('[llm-gateway] request failed', cause);
  return message;
}

const MODEL_LIMIT = 500;

/**
 * 把「美元/token」格式化成「美元/百万 token」，保留 4 位有效小数。
 *
 * 界面要显示 `$0.30/M` 这种人能读的量纲；直接给 `3e-7` 谁都看不懂。
 */
function usdPerMillion(usdPerToken: number): string {
  const perMillion = (usdPerToken ?? 0) * 1_000_000;
  if (!Number.isFinite(perMillion)) return '0';
  // 去掉末尾多余的 0：0.3000 → 0.3，2.5000 → 2.5
  return String(Number(perMillion.toFixed(4)));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function GatewayAdminOverview(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const locale = props.locale ?? 'zh-CN';
  const data = props.data as { overview?: z.infer<typeof adminOverviewSchema> };
  const overview = data.overview;
  return (
    <main className="space-y-8">
      <PageHeader title={tr('admin.overview.title')} />
      {overview ? (
        <Stats
          items={[
            { label: tr('admin.overview.accounts'), value: String(overview.accounts) },
            { label: tr('admin.overview.keys'), value: String(overview.keys) },
            { label: tr('admin.overview.requests'), value: String(overview.summary.requests) },
            { label: tr('admin.overview.revenue'), value: money(overview.summary.amount) },
            { label: tr('admin.overview.cost'), value: money(overview.summary.cost) },
            { label: tr('admin.overview.margin'), value: money(overview.summary.margin) },
          ]}
        />
      ) : null}

      <Section icon={<TrendingUp />} title={tr('admin.overview.topModels')}>
        {overview?.topModels.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.topModels.map((row) => (
              <li
                key={row.model}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <span className="min-w-0 truncate font-medium">{row.model}</span>
                <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {tr('admin.overview.topModelRequests', { count: row.requests })}
                  </span>
                  <span className="hidden tabular-nums sm:inline">{row.totalTokens} token</span>
                  <span className="font-mono text-sm font-semibold text-foreground tabular-nums">
                    {money(row.amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.overview.empty')} icon={<TrendingUp />} />
        )}
      </Section>

      <Section
        icon={<History />}
        title={tr('admin.overview.recentTitle')}
        description={tr('admin.overview.recentDescription')}
      >
        {overview?.logs.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {overview.logs.map((log) => (
              <li
                key={log.id}
                className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{log.model}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shortTime(log.createdAt, locale)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {log.totalTokens} token
                  </span>
                  <span
                    className={
                      log.status === 'SUCCESS'
                        ? 'text-xs text-emerald-600'
                        : 'text-xs text-destructive'
                    }
                  >
                    {log.status === 'SUCCESS' ? tr('common.success') : tr('common.failed')}
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{money(log.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.overview.recentEmpty')} icon={<History />} />
        )}
      </Section>
    </main>
  );
}

function GatewayAdminAccounts(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    accounts?: z.infer<typeof adminAccountsSchema>;
    prices?: z.infer<typeof adminPricesSchema>;
  };
  const accounts = data.accounts?.accounts ?? [];
  const prices = data.prices?.prices ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader title={tr('admin.accounts.title')} />
      <Section
        icon={<Server />}
        title={tr('admin.accounts.poolTitle')}
        description={tr('admin.accounts.poolDescription')}
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/accounts/new" />}
          >
            <Plus className="size-4" />
            {tr('admin.accounts.addAccount')}
          </Button>
        }
      >
        {accounts.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {accounts.map((account) => {
              const models = asStringArray(account.models);
              return (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {account.name}
                      <span
                        className={
                          account.status === 'ACTIVE'
                            ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                            : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                        }
                      >
                        {account.status === 'ACTIVE' ? tr('common.enabled') : tr('common.disabled')}
                      </span>
                      <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        {protocolLabel(account.provider)}
                      </span>
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {account.baseUrl}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tr('admin.accounts.meta', {
                        models: models.length
                          ? tr('admin.accounts.modelCount', { count: models.length })
                          : tr('admin.accounts.allModels'),
                        priority: account.priority,
                        weight: account.weight,
                        concurrency: account.maxConcurrency || '∞',
                      })}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{tr('admin.accounts.keyCount', { count: account.keyCount })}</span>
                      <span>
                        {account.balance !== null
                          ? tr('admin.accounts.balanceValue', {
                              amount: `${account.balance} ${account.balanceCurrency}`.trim(),
                            })
                          : tr('admin.accounts.balanceUnknown')}
                      </span>
                      {account.lastError ? (
                        <span className="text-destructive">
                          {tr('admin.accounts.lastError', { error: account.lastError })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <AccountProbe account={account} tr={tr} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link href={`/admin/plugin/llm-gateway/accounts/${account.id}/edit`} />
                      }
                    >
                      <Pencil className="size-3.5" />
                      {tr('common.edit')}
                    </Button>
                    <form action={props.actions['llm-gateway.set-account-status']}>
                      <input type="hidden" name="id" value={account.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {account.status === 'ACTIVE' ? tr('common.disabled') : tr('common.enabled')}
                      </Button>
                    </form>
                    <form action={props.actions['llm-gateway.delete-account']}>
                      <input type="hidden" name="id" value={account.id} />
                      <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty text={tr('admin.accounts.empty')} icon={<Server />} />
        )}
      </Section>

      <Section
        icon={<Tags />}
        title={tr('admin.accounts.pricingTitle')}
        description={tr('admin.accounts.pricingDescription')}
        action={
          <Button
            type="button"
            nativeButton={false}
            render={<Link href="/admin/plugin/llm-gateway/prices/new" />}
          >
            <Plus className="size-4" />
            {tr('admin.accounts.addPrice')}
          </Button>
        }
      >
        {prices.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {prices.map((price) => (
              <li
                key={price.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {price.model}
                    {price.upstreamModel && price.upstreamModel !== price.model ? (
                      <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        {tr('admin.accounts.upstreamBadge', { model: price.upstreamModel })}
                      </span>
                    ) : null}
                    <span
                      className={
                        price.enabled
                          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                          : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                      }
                    >
                      {price.enabled ? tr('common.enabled') : tr('common.disabled')}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {tr('admin.accounts.priceMeta', {
                      input: money(price.inputPrice),
                      output: money(price.outputPrice),
                      cacheRead: price.cacheReadPrice ? money(price.cacheReadPrice) : '—',
                      cacheWrite: price.cacheWritePrice ? money(price.cacheWritePrice) : '—',
                    })}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {price.capabilities.length
                      ? price.capabilities.map((item) => capabilityLabel(item, tr)).join(' / ')
                      : '—'}{' '}
                    · {tr('admin.accounts.priceMultiplier', { multiplier: price.multiplier })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/admin/plugin/llm-gateway/prices/${price.id}/edit`} />}
                  >
                    <Pencil className="size-3.5" />
                    {tr('common.edit')}
                  </Button>
                  <form action={props.actions['llm-gateway.delete-price']}>
                    <input type="hidden" name="id" value={price.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('admin.accounts.priceEmpty')} icon={<Tags />} />
        )}
      </Section>
    </div>
  );
}

/**
 * 阶梯价编辑器（长上下文档位价）。
 *
 * 交互刻意做成「阈值 + 两个价」的极简表格：运营者脑子里想的是「超过 20 万
 * token 之后输入多少、输出多少」，不是「一个 PriceTier 对象数组」。其余字段
 * （缓存/推理）留在折叠区，默认不打扰。
 *
 * 提交方式：整表序列化成 JSON 塞进一个隐藏 input。内核 action input 只支持
 * 标量类型，这是唯一能把数组送到后端的通道；后端 `jsonArray()` 负责反序列化，
 * 解析失败会 400 而不是静默清空。
 */
function PriceTierEditor({
  tr,
  initial,
}: {
  tr: Translator;
  initial: readonly TierRow[];
}): ReactElement {
  const [rows, setRows] = useState<TierRow[]>(() => initial.map((row) => ({ ...row })));

  function patch(index: number, key: keyof TierRow, value: string): void {
    setRows((current) =>
      current.map((row, position) => {
        if (position !== index) return row;
        const next = { ...row };
        if (value === '') delete next[key];
        else next[key] = Number(value);
        return next;
      }),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name="tiers" value={JSON.stringify(rows)} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('admin.editor.tiersEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
            >
              <Field>
                <Label htmlFor={`tier-from-${index}`}>{tr('admin.editor.tierFrom')}</Label>
                <Input
                  id={`tier-from-${index}`}
                  type="number"
                  min={0}
                  step={1000}
                  value={row.from ?? 0}
                  onChange={(event) => patch(index, 'from', event.target.value)}
                />
              </Field>
              <Field>
                <Label htmlFor={`tier-input-${index}`}>{tr('admin.editor.tierInputPrice')}</Label>
                <Input
                  id={`tier-input-${index}`}
                  type="number"
                  min={0}
                  value={row.inputPrice ?? ''}
                  placeholder={tr('admin.editor.inherit')}
                  onChange={(event) => patch(index, 'inputPrice', event.target.value)}
                />
              </Field>
              <Field>
                <Label htmlFor={`tier-output-${index}`}>{tr('admin.editor.tierOutputPrice')}</Label>
                <Input
                  id={`tier-output-${index}`}
                  type="number"
                  min={0}
                  value={row.outputPrice ?? ''}
                  placeholder={tr('admin.editor.inherit')}
                  onChange={(event) => patch(index, 'outputPrice', event.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRows((current) => current.filter((_r, i) => i !== index))}
                  aria-label={tr('common.delete')}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setRows((current) => {
              // 新档位的阈值默认接在最大阈值之后 100k，避免出现重复档位。
              const max = current.reduce((acc, row) => Math.max(acc, row.from ?? 0), 0);
              return [...current, { from: max + 100_000 }];
            })
          }
        >
          <Plus data-icon="inline-start" />
          {tr('admin.editor.addTier')}
        </Button>
      </div>
    </div>
  );
}

/** 公开参考价查询的一条候选。 */
interface CatalogSuggestion {
  model: string;
  provider: string;
  via: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  tiers: { from: number; inputPrice?: number; outputPrice?: number }[];
  windows: { timezone: string; weekdays: number[]; hours: string; percent?: number }[];
  /** 美元原值（每 token）。用来显示「$0.30/M × 7.00 = 210 分/M」。 */
  usdInputPerToken: number;
  usdOutputPerToken: number;
  /** 峰谷价缺「节假日全天低谷」规则（DeepSeek 官方有，公开数据源没有）。 */
  holidayGap: boolean;
  /** 换算用的汇率（1 USD = ? minor），展示出来让管理员知道数字怎么来的。 */
  rate: number;
  /** 还有几条同名候选。 */
  more: number;
}

/** `/admin/price-catalog` 的响应。 */
interface CatalogResponse {
  available: boolean;
  /** 汇率配成 0 = 管理员关掉了参考价功能。 */
  disabled?: boolean;
  rate: number;
  model: string;
  currency?: string;
  matches: CatalogSuggestion[];
}

/** 一条阶梯价行的可编辑形态（未填字段用 undefined 表示「继承基础价」）。 */
interface TierRow {
  from?: number;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  reasoningPrice?: number;
}

/** 一条时段价行的可编辑形态。 */
interface WindowRow {
  timezone: string;
  weekdays: number[];
  hours: string;
  percent?: number;
  inputPrice?: number;
  outputPrice?: number;
}

/** 星期选择器的选项（ISO 1–7）。 */
const WEEKDAY_OPTIONS: readonly { value: number; labelKey: string }[] = [
  { value: 1, labelKey: 'admin.editor.weekdayMon' },
  { value: 2, labelKey: 'admin.editor.weekdayTue' },
  { value: 3, labelKey: 'admin.editor.weekdayWed' },
  { value: 4, labelKey: 'admin.editor.weekdayThu' },
  { value: 5, labelKey: 'admin.editor.weekdayFri' },
  { value: 6, labelKey: 'admin.editor.weekdaySat' },
  { value: 7, labelKey: 'admin.editor.weekdaySun' },
];

/**
 * 峰谷时段价编辑器。
 *
 * 默认只暴露「时段 + 折扣比例」两个输入：绝大多数峰谷定价就是「低谷打五折」。
 * 需要精确到单项单价时展开「按单价」模式。星期默认不选（= 每天），
 * 因为「每天 22:00-02:00 打折」比「只在工作日打折」常见得多。
 */
function PriceWindowEditor({
  tr,
  initial,
}: {
  tr: Translator;
  initial: readonly WindowRow[];
}): ReactElement {
  const [rows, setRows] = useState<WindowRow[]>(() =>
    initial.map((row) => ({
      timezone: row.timezone || 'Asia/Shanghai',
      weekdays: [...row.weekdays],
      hours: row.hours,
      ...(row.percent !== undefined && row.percent > 0 ? { percent: row.percent } : {}),
      ...(row.inputPrice !== undefined ? { inputPrice: row.inputPrice } : {}),
      ...(row.outputPrice !== undefined ? { outputPrice: row.outputPrice } : {}),
    })),
  );

  function patch(index: number, next: Partial<WindowRow>): void {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...next } : row)),
    );
  }

  function toggleWeekday(index: number, day: number): void {
    setRows((current) =>
      current.map((row, position) => {
        if (position !== index) return row;
        const has = row.weekdays.includes(day);
        return {
          ...row,
          weekdays: has
            ? row.weekdays.filter((item) => item !== day)
            : [...row.weekdays, day].sort((a, b) => a - b),
        };
      }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="windows" value={JSON.stringify(rows)} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('admin.editor.windowsEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((row, index) => {
            const explicit = row.percent === undefined;
            return (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Field>
                    <Label htmlFor={`window-hours-${index}`}>
                      {tr('admin.editor.windowHours')}
                    </Label>
                    <Input
                      id={`window-hours-${index}`}
                      value={row.hours}
                      placeholder="22:00-02:00"
                      onChange={(event) => patch(index, { hours: event.target.value })}
                    />
                    <FieldDescription>{tr('admin.editor.windowHoursHelp')}</FieldDescription>
                  </Field>
                  <Field>
                    <Label htmlFor={`window-tz-${index}`}>
                      {tr('admin.editor.windowTimezone')}
                    </Label>
                    <Input
                      id={`window-tz-${index}`}
                      value={row.timezone}
                      placeholder="Asia/Shanghai"
                      onChange={(event) => patch(index, { timezone: event.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setRows((current) => current.filter((_r, i) => i !== index))}
                      aria-label={tr('common.delete')}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <Field>
                  <Label>{tr('admin.editor.windowWeekdays')}</Label>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {WEEKDAY_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={row.weekdays.includes(option.value)}
                          onChange={() => toggleWeekday(index, option.value)}
                          className="size-4 accent-primary"
                        />
                        {tr(option.labelKey)}
                      </label>
                    ))}
                  </div>
                  <FieldDescription>{tr('admin.editor.windowWeekdaysHelp')}</FieldDescription>
                </Field>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field>
                    <Label htmlFor={`window-percent-${index}`}>
                      {tr('admin.editor.windowPercent')}
                    </Label>
                    <Input
                      id={`window-percent-${index}`}
                      type="number"
                      min={0}
                      max={1000}
                      value={row.percent ?? ''}
                      placeholder="50"
                      onChange={(event) => {
                        const value = event.target.value;
                        patch(
                          index,
                          value === '' ? { percent: undefined } : { percent: Number(value) },
                        );
                      }}
                    />
                    <FieldDescription>{tr('admin.editor.windowPercentHelp')}</FieldDescription>
                  </Field>
                  {explicit ? (
                    <>
                      <Field>
                        <Label htmlFor={`window-input-${index}`}>
                          {tr('admin.editor.windowInputPrice')}
                        </Label>
                        <Input
                          id={`window-input-${index}`}
                          type="number"
                          min={0}
                          value={row.inputPrice ?? ''}
                          placeholder={tr('admin.editor.inherit')}
                          onChange={(event) =>
                            patch(index, {
                              inputPrice:
                                event.target.value === '' ? undefined : Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <Label htmlFor={`window-output-${index}`}>
                          {tr('admin.editor.windowOutputPrice')}
                        </Label>
                        <Input
                          id={`window-output-${index}`}
                          type="number"
                          min={0}
                          value={row.outputPrice ?? ''}
                          placeholder={tr('admin.editor.inherit')}
                          onChange={(event) =>
                            patch(index, {
                              outputPrice:
                                event.target.value === '' ? undefined : Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setRows((current) => [
              ...current,
              { timezone: 'Asia/Shanghai', weekdays: [], hours: '22:00-08:00', percent: 50 },
            ])
          }
        >
          <Plus data-icon="inline-start" />
          {tr('admin.editor.addWindow')}
        </Button>
      </div>
    </div>
  );
}

function GatewayAdminPriceEditor(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    prices?: z.infer<typeof adminPricesSchema>;
    accounts?: z.infer<typeof adminAccountsSchema>;
  };
  const priceId = props.params?.id;
  const editing = priceId
    ? ((data.prices?.prices ?? []).find((price) => price.id === priceId) ?? null)
    : null;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [upstreamModel, setUpstreamModel] = useState(editing?.upstreamModel ?? '');
  /** 自动填价的建议（点「查参考价」后出现）。 */
  const [suggest, setSuggest] = useState<CatalogSuggestion | null>(null);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  /**
   * 价格表单的受控值。
   *
   * 为什么这里不像其它字段那样用 `defaultValue`：自动填价要**改写**已有输入框
   * 的值，非受控 input 改不了（React 不会重渲染 defaultValue）。只把被自动填价
   * 影响的四项做成受控，其余保持非受控，避免整表单受控化。
   */
  const [prices, setPrices] = useState({
    inputPrice: editing?.inputPrice ?? 0,
    outputPrice: editing?.outputPrice ?? 0,
    costInputPrice: editing?.costInputPrice ?? 0,
    costOutputPrice: editing?.costOutputPrice ?? 0,
  });
  const [models, setModels] = useState<string[]>(() =>
    Array.from(
      new Set((data.accounts?.accounts ?? []).flatMap((account) => asStringArray(account.models))),
    ).sort(),
  );
  const router = useRouter();
  const saveAction = props.actions['llm-gateway.save-price'];

  async function loadCatalog() {
    setLoadingCatalog(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/llm-gateway/admin/upstream-model-catalog', {
        headers: { accept: 'application/json' },
      });
      const json = (await response.json().catch(() => null)) as {
        models?: unknown;
      } | null;
      if (!response.ok || !json || !Array.isArray(json.models))
        throw new Error(tr('common.fetchFailedStatus', { status: response.status }));
      const next = json.models.filter((item): item is string => typeof item === 'string');
      if (!next.length) throw new Error(tr('common.noUpstreamModels'));
      setModels((current) => Array.from(new Set([...current, ...next])).sort());
    } catch (cause) {
      setError(failure(cause, tr('common.fetchFailed')));
    } finally {
      setLoadingCatalog(false);
    }
  }

  /**
   * 查公开参考价。只取第一条候选（匹配度最高的那个）填进表单，其余候选
   * 以「还有 N 个同名候选」的形式提示——一次性列 20 条只会让人更不敢点。
   */
  async function loadSuggestion() {
    const model =
      (document.getElementById('price-model-page') as HTMLInputElement | null)?.value ?? '';
    if (model.trim() === '') {
      setError(tr('admin.editor.catalogNeedModel'));
      return;
    }
    setLoadingSuggest(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/plugins/llm-gateway/admin/price-catalog?model=${encodeURIComponent(model)}`,
        { headers: { accept: 'application/json' } },
      );
      const json = (await response.json().catch(() => null)) as CatalogResponse | null;
      if (!response.ok || !json)
        throw new Error(tr('common.fetchFailedStatus', { status: response.status }));
      if (json.disabled) {
        setError(tr('admin.editor.catalogDisabled'));
        return;
      }
      if (!json.available) {
        setError(tr('admin.editor.catalogUnavailable'));
        return;
      }
      const first = json.matches[0];
      if (!first) {
        setError(tr('admin.editor.catalogNoMatch', { model }));
        return;
      }
      setSuggest({ ...first, rate: json.rate, more: json.matches.length - 1 });
    } catch (cause) {
      setError(failure(cause, tr('common.fetchFailed')));
    } finally {
      setLoadingSuggest(false);
    }
  }

  /** 把建议价抄进表单。参考价 → 成本价是「业界普遍进价」，不是你的售价。 */
  function applySuggestion(target: 'cost' | 'sell') {
    if (!suggest) return;
    setPrices((current) => ({
      ...current,
      ...(target === 'cost'
        ? { costInputPrice: suggest.inputPrice, costOutputPrice: suggest.outputPrice }
        : { inputPrice: suggest.inputPrice, outputPrice: suggest.outputPrice }),
    }));
  }

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/plugin/llm-gateway/accounts"
        backLabel={tr('admin.editor.backToAccounts')}
        title={priceId ? tr('admin.editor.priceTitleEdit') : tr('admin.editor.priceTitleNew')}
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push('/admin/plugin/llm-gateway/accounts')}
              disabled={saving}
            >
              {tr('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="gateway-price-form"
              disabled={saving || Boolean(priceId && !editing)}
            >
              {saving ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {saving ? tr('common.saving') : tr('admin.editor.savePrice')}
            </Button>
          </>
        }
      />
      {priceId && !editing ? (
        <InlineNotice>{tr('admin.editor.priceMissing')}</InlineNotice>
      ) : (
        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <form
            id="gateway-price-form"
            key={editing?.id ?? 'new'}
            onSubmit={async (event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              if (saving) return;
              setSaving(true);
              setError(null);
              try {
                await saveAction(formData);
                router.push('/admin/plugin/llm-gateway/accounts');
                router.refresh();
              } catch (cause) {
                /**
                 * action 声明了 `successFeedback`，服务端执行成功后会
                 * `redirect(返回页?action=…&success=…)`。Next 的 redirect 在
                 * 服务端 action 里是靠抛 `NEXT_REDIRECT` 实现的，客户端
                 * `await` 到的就是一个 rejection——它表示**成功**，不是失败。
                 * 不区分的话就会出现「数据库已落库、页面却报保存失败」的
                 * 自相矛盾（内核 INTERFACES.md §3.4 记录了同一语义）。
                 */
                const digest =
                  typeof cause === 'object' && cause !== null && 'digest' in cause
                    ? String((cause as { digest?: unknown }).digest)
                    : '';
                if (digest.startsWith('NEXT_REDIRECT')) {
                  router.push('/admin/plugin/llm-gateway/accounts');
                  router.refresh();
                  return;
                }
                setError(failure(cause, tr('common.saveFailed')));
              } finally {
                setSaving(false);
              }
            }}
            className="flex min-w-0 flex-col gap-6"
          >
            {editing ? (
              <input type="hidden" name="enabled" value={String(editing.enabled)} />
            ) : null}
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.modelConfig')}</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <Label htmlFor="price-model-page">{tr('admin.editor.userModel')}</Label>
                    <Input
                      id="price-model-page"
                      name="model"
                      required
                      readOnly={editing !== null}
                      defaultValue={editing?.model ?? ''}
                      placeholder={tr('admin.editor.userModelPlaceholder')}
                    />
                    <FieldDescription>{tr('admin.editor.userModelHelp')}</FieldDescription>
                  </Field>
                  <Field>
                    <Label htmlFor="price-upstream-page">{tr('admin.editor.upstreamModel')}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="price-upstream-page"
                        name="upstreamModel"
                        list="upstream-model-options-page"
                        value={upstreamModel}
                        onChange={(event) => setUpstreamModel(event.target.value)}
                        placeholder={tr('admin.editor.upstreamModelPlaceholder')}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void loadCatalog()}
                        disabled={loadingCatalog}
                      >
                        <RefreshCw
                          data-icon="inline-start"
                          className={loadingCatalog ? 'animate-spin' : undefined}
                        />
                        {tr('admin.editor.fetchFromUpstream')}
                      </Button>
                    </div>
                    <datalist id="upstream-model-options-page">
                      {models.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.catalogTitle')}</SectionTitle>
                <CardDescription>{tr('admin.editor.catalogDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void loadSuggestion()}
                      disabled={loadingSuggest}
                    >
                      <Search
                        data-icon="inline-start"
                        className={loadingSuggest ? 'animate-pulse' : undefined}
                      />
                      {tr('admin.editor.catalogLookup')}
                    </Button>
                    {suggest ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => applySuggestion('cost')}
                        >
                          {tr('admin.editor.catalogFillCost')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => applySuggestion('sell')}
                        >
                          {tr('admin.editor.catalogFillSell')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {suggest ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3 text-sm">
                      <p className="font-medium">
                        {suggest.model}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {suggest.provider} · {tr(`admin.editor.catalogVia.${suggest.via}`)}
                        </span>
                      </p>
                      {/*
                        显示换算过程而不是只给结果。「210 分/M」孤零零摆着会被
                        当成人民币标价，实际它是 $0.30/M 按汇率 7.00 换算来的。
                      */}
                      <p className="text-muted-foreground">
                        {tr('admin.editor.catalogUsd', {
                          input: usdPerMillion(suggest.usdInputPerToken),
                          output: usdPerMillion(suggest.usdOutputPerToken),
                        })}
                      </p>
                      <p className="text-muted-foreground">
                        {tr('admin.editor.catalogPrices', {
                          input: suggest.inputPrice,
                          output: suggest.outputPrice,
                          rate: suggest.rate,
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {tr('admin.editor.catalogNotCost')}
                      </p>
                      {suggest.maxInputTokens > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {tr('admin.editor.catalogContext', {
                            input: suggest.maxInputTokens,
                            output: suggest.maxOutputTokens,
                          })}
                        </p>
                      ) : null}
                      {suggest.tiers.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {tr('admin.editor.catalogHasTiers', { count: suggest.tiers.length })}
                        </p>
                      ) : null}
                      {suggest.windows.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {tr('admin.editor.catalogHasWindows', { count: suggest.windows.length })}
                        </p>
                      ) : null}
                      {/*
                        数据源缺口必须讲出来：DeepSeek 官方口径是「节假日全天按
                        低谷价」，但 LiteLLM 的 windows 只有时段+星期。抄完不补
                        节假日窗口，节假日当天就会按峰时价多收用户的钱。
                      */}
                      {suggest.holidayGap ? (
                        <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                          {tr('admin.editor.catalogHolidayGap')}
                        </p>
                      ) : null}
                      {suggest.more > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {tr('admin.editor.catalogMore', { count: suggest.more })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{tr('admin.editor.catalogHelp')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.billingSettings')}</SectionTitle>
                <CardDescription>{tr('admin.editor.billingUnit')}</CardDescription>
              </CardHeader>
              <CardContent>
                <FieldGroup>
                  <div className="grid gap-5 sm:grid-cols-2">
                    {(
                      [
                        ['inputPrice', 'admin.editor.inputPrice', editing?.inputPrice ?? 0],
                        ['outputPrice', 'admin.editor.outputPrice', editing?.outputPrice ?? 0],
                        [
                          'cacheReadPrice',
                          'admin.editor.cacheReadPrice',
                          editing?.cacheReadPrice ?? 0,
                        ],
                        [
                          'cacheWritePrice',
                          'admin.editor.cacheWritePrice',
                          editing?.cacheWritePrice ?? 0,
                        ],
                        ['multiplier', 'admin.editor.multiplier', editing?.multiplier ?? 100],
                        [
                          'costInputPrice',
                          'admin.editor.costInputPrice',
                          editing?.costInputPrice ?? 0,
                        ],
                        [
                          'costOutputPrice',
                          'admin.editor.costOutputPrice',
                          editing?.costOutputPrice ?? 0,
                        ],
                        [
                          'costCacheReadPrice',
                          'admin.editor.costCacheReadPrice',
                          editing?.costCacheReadPrice ?? 0,
                        ],
                        [
                          'costCacheWritePrice',
                          'admin.editor.costCacheWritePrice',
                          editing?.costCacheWritePrice ?? 0,
                        ],
                        [
                          'maxOutputTokens',
                          'admin.editor.maxOutputTokens',
                          editing?.maxOutputTokens ?? 0,
                        ],
                      ] as const
                    ).map(([name, labelKey, value]) => {
                      // 被自动填价影响的四个字段必须受控，否则 setState 改不动 input。
                      const controlled = name in prices;
                      return (
                        <Field key={name}>
                          <Label htmlFor={`price-${name}-page`}>{tr(labelKey)}</Label>
                          <Input
                            id={`price-${name}-page`}
                            name={name}
                            type="number"
                            min={0}
                            required={name === 'inputPrice' || name === 'outputPrice'}
                            step={1}
                            {...(controlled
                              ? {
                                  value: prices[name as keyof typeof prices],
                                  onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                                    setPrices((current) => ({
                                      ...current,
                                      [name]:
                                        event.target.value === '' ? 0 : Number(event.target.value),
                                    })),
                                }
                              : { defaultValue: value })}
                          />
                        </Field>
                      );
                    })}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <Label htmlFor="price-strategy">{tr('admin.editor.strategy')}</Label>
                      <Select
                        id="price-strategy"
                        name="strategy"
                        defaultValue={editing?.strategy ?? ''}
                      >
                        <option value="">{tr('admin.editor.strategyAuto')}</option>
                        <option value="flat">{tr('admin.editor.strategyFlat')}</option>
                        <option value="tiered">{tr('admin.editor.strategyTiered')}</option>
                        <option value="expr">{tr('admin.editor.strategyExpr')}</option>
                      </Select>
                    </Field>
                    <Field>
                      <Label htmlFor="price-expr">{tr('admin.editor.expr')}</Label>
                      <Input
                        id="price-expr"
                        name="expr"
                        defaultValue={editing?.expr ?? ''}
                        placeholder={tr('admin.editor.exprPlaceholder')}
                      />
                    </Field>
                  </div>
                  <FieldDescription>{tr('admin.editor.exprHelp')}</FieldDescription>
                  <label className="flex items-center gap-2 text-sm">
                    {/* 未勾选时也必须提交 false：只有勾选才会出现在 FormData 里。 */}
                    <input type="hidden" name="groupDiscount" value="false" />
                    <input
                      type="checkbox"
                      name="groupDiscount"
                      value="true"
                      defaultChecked={editing?.groupDiscount ?? true}
                      className="size-4 accent-primary"
                    />
                    {tr('admin.editor.groupDiscount')}
                  </label>
                  <p className="text-xs text-muted-foreground">{tr('admin.editor.costHelp')}</p>
                </FieldGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.tiersTitle')}</SectionTitle>
                <CardDescription>{tr('admin.editor.tiersDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <PriceTierEditor tr={tr} initial={editing?.tiers ?? []} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.windowsTitle')}</SectionTitle>
                <CardDescription>{tr('admin.editor.windowsDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <PriceWindowEditor
                  tr={tr}
                  initial={(editing?.windows ?? []).map((window) => ({
                    timezone: window.timezone,
                    weekdays: window.weekdays,
                    hours: window.hours,
                    percent: window.percent,
                    inputPrice: window.inputPrice,
                    outputPrice: window.outputPrice,
                  }))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>{tr('admin.editor.capabilities')}</SectionTitle>
              </CardHeader>
              <CardContent>
                <FieldSet>
                  <FieldLegend className="sr-only">{tr('admin.editor.capabilities')}</FieldLegend>
                  <div className="flex flex-wrap gap-x-5 gap-y-3">
                    {CAPABILITY_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="capabilities"
                          value={option.value}
                          defaultChecked={editing?.capabilities.includes(option.value) ?? false}
                          className="size-4 accent-primary"
                        />
                        {tr(option.labelKey)}
                      </label>
                    ))}
                  </div>
                </FieldSet>
              </CardContent>
            </Card>
            {error ? <InlineError className="sm:col-span-2">{error}</InlineError> : null}
          </form>
          <Card className="xl:sticky xl:top-24">
            <CardHeader>
              <SectionTitle>{tr('admin.editor.priceNotes')}</SectionTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{tr('admin.editor.priceNotesBody')}</p>
              {editing ? <p className="mt-4 break-all font-mono text-sm">{editing.model}</p> : null}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}

function GatewayAdminAccountEditor(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as { accounts?: z.infer<typeof adminAccountsSchema> };
  const accountId = props.params?.id;
  const editing = accountId
    ? ((data.accounts?.accounts ?? []).find((account) => account.id === accountId) ?? null)
    : null;
  const createAction = props.actions['llm-gateway.create-account'];
  const updateAction = props.actions['llm-gateway.update-account'];
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const returnToList = () => router.push('/admin/plugin/llm-gateway/accounts');
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        backHref="/admin/plugin/llm-gateway/accounts"
        backLabel={tr('admin.editor.backToAccountList')}
        title={editing ? tr('admin.editor.accountTitleEdit') : tr('admin.editor.accountTitleNew')}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={returnToList} disabled={saving}>
              {tr('common.cancel')}
            </Button>
            <Button type="submit" form="gateway-account-form" disabled={saving}>
              {saving ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {saving ? tr('common.saving') : tr('admin.editor.saveAccount')}
            </Button>
          </>
        }
      />
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
          <AccountForm
            key={editing?.id ?? 'new'}
            editing={editing}
            createAction={createAction}
            updateAction={updateAction}
            onDone={returnToList}
            onPendingChange={setSaving}
            tr={tr}
          />
        </div>
        <aside className="rounded-xl border bg-card p-5 xl:sticky xl:top-24">
          <SectionTitle>{tr('admin.editor.accountOverview')}</SectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr('admin.editor.accountOverviewDescription')}
          </p>
          <dl className="mt-5 flex flex-col gap-4 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.status')}</dt>
              <dd>
                {editing?.status === 'DISABLED' ? tr('common.disabled') : tr('common.enabled')}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.protocol')}</dt>
              <dd>
                {editing ? protocolLabel(editing.provider) : tr('admin.editor.notConfigured')}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{tr('admin.editor.models')}</dt>
              <dd>
                {editing
                  ? asStringArray(editing.models).length || tr('admin.editor.all')
                  : tr('admin.editor.notConfigured')}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </main>
  );
}

function AccountForm({
  editing,
  createAction,
  updateAction,
  onDone,
  onPendingChange,
  tr,
}: {
  editing: AccountRow | null;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
  tr: Translator;
}): ReactElement {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(editing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState(editing?.provider ?? 'openai-chat');
  const [priority, setPriority] = useState(String(editing?.priority ?? 0));
  const [weight, setWeight] = useState(String(editing?.weight ?? 100));
  const [maxConcurrency, setMaxConcurrency] = useState(String(editing?.maxConcurrency ?? 0));
  const [status, setStatus] = useState(editing?.status ?? 'ACTIVE');

  const [selected, setSelected] = useState<string[]>(() => asStringArray(editing?.models));
  const [available, setAvailable] = useState<string[]>(() => asStringArray(editing?.models));
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');
  const [fetching, setFetching] = useState(false);

  const candidates = Array.from(new Set([...available, ...selected])).sort();
  const filtered = query
    ? candidates.filter((model) => model.toLowerCase().includes(query.toLowerCase()))
    : candidates;

  function toggle(model: string) {
    setSelected((current) =>
      current.includes(model) ? current.filter((item) => item !== model) : [...current, model],
    );
  }

  function selectAllVisible() {
    setSelected((current) => Array.from(new Set([...current, ...filtered])).slice(0, MODEL_LIMIT));
  }

  function clearSelected() {
    setSelected([]);
  }

  function addManual() {
    const parts = manual
      .split(/[\s,;，；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setAvailable((current) => Array.from(new Set([...current, ...parts])).sort());
    setSelected((current) => Array.from(new Set([...current, ...parts])).slice(0, MODEL_LIMIT));
    setManual('');
  }

  async function fetchModels() {
    if (!baseUrl.trim()) {
      setError(tr('admin.editor.missingBaseUrl'));
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError(tr('admin.editor.missingApiKey'));
      return;
    }
    setFetching(true);
    setError(null);
    try {
      const response = await fetch('/api/plugins/llm-gateway/admin/upstream-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          provider,
          ...(editing ? { id: editing.id } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(json.error ?? tr('common.fetchFailedStatus', { status: response.status }));
      const models = Array.isArray(json.models) ? json.models : [];
      if (models.length === 0) {
        setError(tr('common.noUpstreamModels'));
        return;
      }
      setAvailable((current) => Array.from(new Set([...current, ...models])).sort());
      setSelected(models.slice(0, MODEL_LIMIT));
    } catch (fetchError) {
      setError(failure(fetchError, tr('common.fetchFailed')));
    } finally {
      setFetching(false);
    }
  }

  function submit() {
    if (isPending) return;
    if (!name.trim()) {
      setError(tr('admin.editor.missingName'));
      return;
    }
    if (!baseUrl.trim()) {
      setError(tr('admin.editor.missingBaseUrl'));
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError(tr('admin.editor.missingApiKey'));
      return;
    }
    setError(null);
    const form = new FormData();
    form.set('name', name.trim());
    form.set('baseUrl', baseUrl.trim());
    form.set('provider', provider);
    if (apiKey.trim()) form.set('apiKey', apiKey.trim());
    form.set('priority', String(Math.trunc(Number(priority) || 0)));
    form.set('weight', String(Math.trunc(Number(weight) || 100)));
    form.set('maxConcurrency', String(Math.trunc(Number(maxConcurrency) || 0)));
    for (const model of selected.slice(0, MODEL_LIMIT)) form.append('models', model);

    onPendingChange(true);
    startTransition(async () => {
      try {
        if (editing) {
          form.set('id', editing.id);
          form.set('status', status);
          await updateAction(form);
        } else {
          await createAction(form);
        }
        onDone();
      } catch {
        setError(tr('common.saveFailed'));
      } finally {
        onPendingChange(false);
      }
    });
  }

  return (
    <form
      id="gateway-account-form"
      className="flex flex-col gap-6"
      aria-busy={isPending}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <SectionTitle>{tr('admin.editor.basic')}</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">{tr('admin.editor.basicDescription')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-name">{tr('admin.editor.name')}</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={tr('admin.editor.namePlaceholder')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-base-url">Base URL</Label>
          <Input
            id="account-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={
              provider === 'anthropic'
                ? 'https://api.anthropic.com'
                : provider === 'gemini'
                  ? 'https://generativelanguage.googleapis.com'
                  : 'https://api.openai.com'
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-provider">{tr('admin.editor.provider')}</Label>
          <Select
            id="account-provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            {PROTOCOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{tr('admin.editor.providerHelp')}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-api-key">{tr('admin.editor.apiKey')}</Label>
          <Input
            id="account-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing ? tr('admin.editor.apiKeyKeep') : 'sk-...'}
          />
        </div>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-status">{tr('admin.editor.status')}</Label>
            <Select
              id="account-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="ACTIVE">{tr('common.enabled')}</option>
              <option value="DISABLED">{tr('common.disabled')}</option>
            </Select>
          </div>
        ) : null}
        <div className="grid grid-cols-3 gap-3 sm:col-span-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-priority">{tr('admin.editor.priority')}</Label>
            <Input
              id="account-priority"
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-weight">{tr('admin.editor.weight')}</Label>
            <Input
              id="account-weight"
              type="number"
              min={1}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-concurrency">{tr('admin.editor.maxConcurrency')}</Label>
            <Input
              id="account-concurrency"
              type="number"
              min={0}
              value={maxConcurrency}
              onChange={(event) => setMaxConcurrency(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <SectionTitle>{tr('admin.editor.availableModels')}</SectionTitle>
          <p className="text-xs text-muted-foreground">
            {tr('admin.editor.availableModelsHelp', { count: selected.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={clearSelected}>
            {tr('admin.editor.clear')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchModels()}
            disabled={fetching}
          >
            {fetching ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {tr('admin.editor.fetchFromUpstream')}
          </Button>
        </div>
      </div>

      {candidates.length > 0 ? (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr('admin.editor.filterModels')}
                className="pl-8"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={selectAllVisible}>
              {tr('admin.editor.selectAll')}
            </Button>
          </div>
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2">
            {filtered.map((model) => {
              const checked = selected.includes(model);
              return (
                <label
                  key={model}
                  className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    checked
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'bg-background hover:bg-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={checked}
                    onChange={() => toggle(model)}
                  />
                  {model}
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{tr('admin.editor.modelsEmpty')}</p>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addManual();
            }
          }}
          placeholder={tr('admin.editor.manualPlaceholder')}
        />
        <Button type="button" variant="outline" size="sm" onClick={addManual}>
          {tr('admin.editor.add')}
        </Button>
      </div>

      {error ? <InlineError>{error}</InlineError> : null}
    </form>
  );
}

/**
 * 账号探测按钮（A2）：测活 / 查余额。
 *
 * 结果只就地展示（不刷新页面）：测活给延迟与模型数，余额给金额或「不支持」。
 */
function AccountProbe({ account, tr }: { account: AccountRow; tr: Translator }): ReactElement {
  const [busy, setBusy] = useState<'test' | 'balance' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(kind: 'test' | 'balance') {
    if (busy) return;
    setBusy(kind);
    setNote(null);
    try {
      const response = await fetch(
        `/api/plugins/llm-gateway/admin/accounts/${account.id}/${kind === 'test' ? 'test' : 'balance'}`,
        {
          method: kind === 'test' ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(kind === 'test' ? { body: JSON.stringify({}) } : {}),
        },
      );
      const json = (await response.json().catch(() => null)) as {
        result?: { ok: boolean; latencyMs: number; models: string[]; message: string | null };
        balance?: {
          supported: boolean;
          amount: number | null;
          currency: string;
          message: string | null;
        };
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(json?.error ?? tr('common.fetchFailedStatus', { status: response.status }));
      }
      if (kind === 'test') {
        const result = json?.result;
        setNote(
          result?.ok
            ? tr('admin.accounts.testOk', {
                latency: result.latencyMs,
                count: result.models.length,
              })
            : tr('admin.accounts.testFailed', { error: result?.message ?? '' }),
        );
      } else {
        const balance = json?.balance;
        setNote(
          balance?.supported
            ? balance.amount !== null
              ? tr('admin.accounts.balanceValue', {
                  amount: `${balance.amount} ${balance.currency}`.trim(),
                })
              : tr('admin.accounts.balanceFailed', { error: balance.message ?? '' })
            : tr('admin.accounts.balanceUnsupported'),
        );
      }
    } catch (cause) {
      setNote(failure(cause, tr('common.fetchFailed')));
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy !== null}
        onClick={() => void run('test')}
      >
        {busy === 'test' ? (
          <RefreshCw className="size-3.5 animate-spin" />
        ) : (
          <Activity className="size-3.5" />
        )}
        {tr('admin.accounts.test')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy !== null}
        onClick={() => void run('balance')}
      >
        {busy === 'balance' ? (
          <RefreshCw className="size-3.5 animate-spin" />
        ) : (
          <FileText className="size-3.5" />
        )}
        {tr('admin.accounts.balance')}
      </Button>
      {note ? <span className="max-w-56 text-xs text-muted-foreground">{note}</span> : null}
    </span>
  );
}

/**
 * 管理端用量日志（A5）：按天数/模型/状态筛，分页读，CSV 导出走 raw 路由。
 *
 * 页面不依赖 manifest 预取（筛选要交互），所以自己 fetch；CSV 用普通链接，
 * 浏览器直接下载。
 */
function GatewayAdminUsageLogs(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const locale = props.locale ?? 'zh-CN';
  const [days, setDays] = useState('1');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<z.infer<typeof adminUsageLogRowSchema>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageSize = 50;
  const query = new URLSearchParams({ days, page: String(page), pageSize: String(pageSize) });
  if (model.trim()) query.set('model', model.trim());
  if (status) query.set('status', status);

  async function load(target = page) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        days,
        page: String(target),
        pageSize: String(pageSize),
      });
      if (model.trim()) params.set('model', model.trim());
      if (status) params.set('status', status);
      const response = await fetch(`/api/plugins/llm-gateway/admin/usage-logs?${params}`, {
        headers: { accept: 'application/json' },
      });
      const json = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(tr('common.fetchFailedStatus', { status: response.status }));
      }
      const parsed = adminUsageLogsSchema.parse(json);
      setRows(parsed.logs);
      setTotal(parsed.total);
      setPage(parsed.page);
    } catch (cause) {
      setError(failure(cause, tr('common.fetchFailed')));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(1);
    // 首屏只读一次；筛选变化由「查询」按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        title={tr('admin.usage.title')}
        description={tr('admin.usage.description')}
        actions={
          <Button
            type="button"
            variant="outline"
            nativeButton={false}
            render={<a href={`/api/plugins/llm-gateway/admin/usage-logs.csv?${query}`} />}
          >
            <FileText className="size-4" />
            {tr('admin.usage.export')}
          </Button>
        }
      />
      <Section icon={<History />} title={tr('admin.usage.filters')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-28">
            <Label htmlFor="usage-days">{tr('admin.usage.days')}</Label>
            <Input
              id="usage-days"
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </Field>
          <Field className="w-48">
            <Label htmlFor="usage-model">{tr('admin.usage.model')}</Label>
            <Input
              id="usage-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={tr('admin.usage.modelPlaceholder')}
            />
          </Field>
          <Field className="w-40">
            <Label htmlFor="usage-status">{tr('admin.usage.status')}</Label>
            <Select
              id="usage-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">{tr('admin.usage.statusAll')}</option>
              <option value="SUCCESS">{tr('common.success')}</option>
              <option value="ERROR">{tr('common.failed')}</option>
              <option value="CANCELLED">{tr('admin.usage.cancelled')}</option>
              <option value="TIMEOUT">{tr('admin.usage.timeout')}</option>
            </Select>
          </Field>
          <Button type="button" onClick={() => void load(1)} disabled={loading}>
            {loading ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            {tr('admin.usage.search')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {tr('admin.usage.total', { count: total })}
          </span>
        </div>
      </Section>

      <Section icon={<Activity />} title={tr('admin.usage.listTitle')}>
        {error ? <InlineError>{error}</InlineError> : null}
        {rows.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('admin.usage.time')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.usage.model')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.usage.account')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.usage.tokens')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.usage.amount')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.usage.cost')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.usage.latency')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.usage.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {shortTime(row.createdAt, locale)}
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{row.model}</p>
                      <p className="text-xs text-muted-foreground">{row.endpoint}</p>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.accountId ?? '—'}
                      {row.upstreamKeyId ? ` / ${row.upstreamKeyId}` : ''}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.totalTokens}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {money(row.amount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                      {money(row.costAmount)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {row.latencyMs !== null ? `${row.latencyMs}ms` : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          row.status === 'SUCCESS' ? 'text-emerald-600' : 'text-destructive'
                        }
                      >
                        {row.status}
                      </span>
                      {row.aborted ? (
                        <span className="ml-1 text-amber-600">{tr('admin.usage.aborted')}</span>
                      ) : null}
                      {row.error ? (
                        <p className="mt-1 max-w-48 truncate text-muted-foreground">{row.error}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={tr('admin.usage.empty')} icon={<History />} />
        )}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{tr('admin.usage.pageOf', { page, pages })}</span>
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || page <= 1}
              onClick={() => void load(page - 1)}
            >
              {tr('common.previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || page >= pages}
              onClick={() => void load(page + 1)}
            >
              {tr('common.next')}
            </Button>
          </span>
        </div>
      </Section>
    </main>
  );
}

/**
 * 运营面（B）：模型映射 / 预算限额 / 套餐权益。
 *
 * 三个表格都走同一套「读全量 + 行内操作」的模式：运营动作是低频的，
 * 分页与筛选留给 API（`?userId=`），页面只保证「能看到、能改、能撤销」。
 */
function GatewayAdminOps(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const locale = props.locale ?? 'zh-CN';
  const [maps, setMaps] = useState<z.infer<typeof modelMapSchema>[]>([]);
  const [limits, setLimits] = useState<z.infer<typeof budgetLimitSchema>[]>([]);
  const [entitlements, setEntitlements] = useState<z.infer<typeof entitlementSchema>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = '/api/plugins/llm-gateway/admin';

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(
        json?.error?.message ?? tr('common.fetchFailedStatus', { status: response.status }),
      );
    }
    return json;
  }

  async function reload(): Promise<void> {
    setError(null);
    try {
      const [mapJson, limitJson, entitlementJson] = await Promise.all([
        fetch(`${base}/model-maps`, { headers: { accept: 'application/json' } }).then((r) =>
          r.json(),
        ),
        fetch(`${base}/budget-limits`, { headers: { accept: 'application/json' } }).then((r) =>
          r.json(),
        ),
        fetch(`${base}/entitlements`, { headers: { accept: 'application/json' } }).then((r) =>
          r.json(),
        ),
      ]);
      setMaps(adminModelMapsSchema.parse(mapJson).maps);
      setLimits(adminBudgetLimitsSchema.parse(limitJson).limits);
      setEntitlements(adminEntitlementsSchema.parse(entitlementJson).entitlements);
    } catch (cause) {
      setError(failure(cause, tr('common.fetchFailed')));
    }
  }

  useEffect(() => {
    void reload();
    // 只读一次；写操作各自 reload。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(failure(cause, tr('common.saveFailed')));
    } finally {
      setBusy(false);
    }
  }

  /** 解析 `model:weight, model:weight` 形式的目标列表。 */
  function parseTargets(text: string): Array<{ model: string; weight: number }> {
    return text
      .split(/[,，\n]/)
      .map((piece) => piece.trim())
      .filter(Boolean)
      .map((piece) => {
        const [model, weight] = piece.split(':');
        const parsed = Number((weight ?? '').trim());
        return {
          model: (model ?? '').trim(),
          weight: Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 100,
        };
      })
      .filter((target) => target.model.length > 0);
  }

  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('admin.ops.title')} description={tr('admin.ops.description')} />
      {error ? <InlineError>{error}</InlineError> : null}

      <Section icon={<Tags />} title={tr('admin.ops.maps')}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const targets = parseTargets(String(formData.get('targets') ?? ''));
            if (!targets.length) {
              setError(tr('admin.ops.targetsRequired'));
              return;
            }
            void run(async () => {
              await call('POST', '/model-maps', {
                from: String(formData.get('from') ?? '').trim(),
                mode: String(formData.get('mode') ?? 'exact'),
                targets,
                priority: Number(formData.get('priority') ?? 0) || 0,
              });
              event.currentTarget.reset();
            });
          }}
        >
          <Field className="w-48">
            <Label htmlFor="map-from">{tr('admin.ops.mapFrom')}</Label>
            <Input id="map-from" name="from" required />
          </Field>
          <Field className="w-32">
            <Label htmlFor="map-mode">{tr('admin.ops.mapMode')}</Label>
            <Select id="map-mode" name="mode" defaultValue="exact">
              <option value="exact">exact</option>
              <option value="prefix">prefix</option>
              <option value="regex">regex</option>
            </Select>
          </Field>
          <Field className="min-w-64 flex-1">
            <Label htmlFor="map-targets">{tr('admin.ops.mapTargets')}</Label>
            <Input id="map-targets" name="targets" placeholder="gpt-4o-2024-08:100, gpt-4o:50" />
          </Field>
          <Field className="w-24">
            <Label htmlFor="map-priority">{tr('admin.ops.priority')}</Label>
            <Input id="map-priority" name="priority" type="number" defaultValue={0} />
          </Field>
          <Button type="submit" disabled={busy}>
            <Plus className="size-4" />
            {tr('admin.ops.add')}
          </Button>
        </form>
        {maps.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.mapFrom')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.mapMode')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.mapTargets')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.priority')}</th>
                  <th className="px-3 py-2 text-right">{tr('common.edit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {maps.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 font-mono text-xs">{row.from}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.mode}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.targets.map((target) => `${target.model}:${target.weight}`).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.priority}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(() => call('DELETE', `/model-maps/${row.id}`))}
                      >
                        <Trash2 className="size-3.5" />
                        {tr('common.delete')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={tr('admin.ops.empty')} icon={<Tags />} />
        )}
      </Section>

      <Section icon={<TrendingUp />} title={tr('admin.ops.limits')}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            void run(async () => {
              await call('POST', '/budget-limits', {
                userId: String(formData.get('userId') ?? '').trim(),
                period: String(formData.get('period') ?? 'month'),
                amountLimit: Number(formData.get('amountLimit') ?? 0) || 0,
                warnPercent: Number(formData.get('warnPercent') ?? 80) || 80,
                action: String(formData.get('action') ?? 'warn'),
              });
              event.currentTarget.reset();
            });
          }}
        >
          <Field className="w-48">
            <Label htmlFor="limit-user">{tr('admin.ops.userId')}</Label>
            <Input id="limit-user" name="userId" placeholder={tr('admin.ops.userIdHint')} />
          </Field>
          <Field className="w-28">
            <Label htmlFor="limit-period">{tr('admin.ops.period')}</Label>
            <Select id="limit-period" name="period" defaultValue="month">
              <option value="month">{tr('admin.ops.month')}</option>
              <option value="day">{tr('admin.ops.day')}</option>
            </Select>
          </Field>
          <Field className="w-36">
            <Label htmlFor="limit-amount">{tr('admin.ops.amountLimit')}</Label>
            <Input id="limit-amount" name="amountLimit" type="number" min={0} defaultValue={0} />
          </Field>
          <Field className="w-28">
            <Label htmlFor="limit-warn">{tr('admin.ops.warnPercent')}</Label>
            <Input
              id="limit-warn"
              name="warnPercent"
              type="number"
              min={1}
              max={100}
              defaultValue={80}
            />
          </Field>
          <Field className="w-32">
            <Label htmlFor="limit-action">{tr('admin.ops.action')}</Label>
            <Select id="limit-action" name="action" defaultValue="warn">
              <option value="warn">{tr('admin.ops.actionWarn')}</option>
              <option value="block">{tr('admin.ops.actionBlock')}</option>
            </Select>
          </Field>
          <Button type="submit" disabled={busy}>
            <Plus className="size-4" />
            {tr('admin.ops.add')}
          </Button>
        </form>
        {limits.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.userId')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.period')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.amountLimit')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.warnPercent')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.action')}</th>
                  <th className="px-3 py-2 text-right">{tr('common.edit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {limits.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 text-xs">{row.userId || tr('admin.ops.global')}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.period === 'day' ? tr('admin.ops.day') : tr('admin.ops.month')}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {row.amountLimit === 0 ? '∞' : money(row.amountLimit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.warnPercent}%</td>
                    <td className="px-3 py-2 text-xs">
                      {row.action === 'block'
                        ? tr('admin.ops.actionBlock')
                        : tr('admin.ops.actionWarn')}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(() => call('DELETE', `/budget-limits/${row.id}`))}
                      >
                        <Trash2 className="size-3.5" />
                        {tr('common.delete')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={tr('admin.ops.empty')} icon={<TrendingUp />} />
        )}
      </Section>

      <Section icon={<Activity />} title={tr('admin.ops.entitlements')}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const models = String(formData.get('models') ?? '')
              .split(/[,，\n]/)
              .map((piece) => piece.trim())
              .filter(Boolean);
            void run(async () => {
              await call('POST', '/entitlements', {
                userId: String(formData.get('userId') ?? '').trim(),
                name: String(formData.get('name') ?? '').trim(),
                quotaAmount: Number(formData.get('quotaAmount') ?? 0) || 0,
                ...(models.length ? { models } : {}),
                ...(Number(formData.get('validityDays') ?? 0) > 0
                  ? { validityDays: Number(formData.get('validityDays')) }
                  : {}),
              });
              event.currentTarget.reset();
            });
          }}
        >
          <Field className="w-48">
            <Label htmlFor="ent-user">{tr('admin.ops.userId')}</Label>
            <Input id="ent-user" name="userId" required />
          </Field>
          <Field className="w-40">
            <Label htmlFor="ent-name">{tr('admin.ops.entName')}</Label>
            <Input id="ent-name" name="name" />
          </Field>
          <Field className="w-36">
            <Label htmlFor="ent-quota">{tr('admin.ops.quota')}</Label>
            <Input id="ent-quota" name="quotaAmount" type="number" min={0} defaultValue={0} />
          </Field>
          <Field className="w-28">
            <Label htmlFor="ent-days">{tr('admin.ops.validityDays')}</Label>
            <Input id="ent-days" name="validityDays" type="number" min={0} defaultValue={0} />
          </Field>
          <Field className="min-w-56 flex-1">
            <Label htmlFor="ent-models">{tr('admin.ops.models')}</Label>
            <Input id="ent-models" name="models" placeholder="gpt-4o, claude-3-5-sonnet" />
          </Field>
          <Button type="submit" disabled={busy}>
            <Plus className="size-4" />
            {tr('admin.ops.grant')}
          </Button>
        </form>
        {entitlements.length ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.userId')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.entName')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.quota')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.used')}</th>
                  <th className="px-3 py-2 text-right">{tr('admin.ops.remaining')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.ops.status')}</th>
                  <th className="px-3 py-2 text-left">{tr('admin.usage.time')}</th>
                  <th className="px-3 py-2 text-right">{tr('common.edit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entitlements.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 text-xs">{row.userId}</td>
                    <td className="px-3 py-2 text-xs">{row.name || '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {row.quotaAmount === 0 ? '∞' : money(row.quotaAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {money(row.usedAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {row.remaining === null ? '∞' : money(row.remaining)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          row.liveStatus === 'ACTIVE' ? 'text-emerald-600' : 'text-muted-foreground'
                        }
                      >
                        {row.liveStatus}
                      </span>
                      {row.models.length ? (
                        <p className="mt-0.5 max-w-40 truncate text-muted-foreground">
                          {row.models.join(', ')}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.expiresAt ? shortTime(row.expiresAt, locale) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy || row.status === 'REVOKED'}
                        onClick={() => void run(() => call('DELETE', `/entitlements/${row.id}`))}
                      >
                        <Trash2 className="size-3.5" />
                        {tr('admin.ops.revoke')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text={tr('admin.ops.empty')} icon={<Activity />} />
        )}
      </Section>
    </main>
  );
}

/**
 * Playground（D1）：拿一个模型试一句话。
 *
 * 与后台其它页面的区别：它调的是 `POST /admin/playground`（服务端选号直连上游），
 * **不扣用户钱包、不写用量流水**——这是运营排查工具，不是计费路径（见
 * `src/playground.ts` 文件头的取舍）。页面只显示网关给出的稳定错误文案，
 * 上游原文不出现在界面上。
 */
interface PlaygroundResultView {
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  latencyMs: number;
  stopReason: string;
  account: { id: string; name: string; provider: string };
  upstreamModel: string;
}

function GatewayAdminPlayground(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as { prices?: z.infer<typeof adminPricesSchema> };
  const models = (data.prices?.prices ?? []).map((price) => price.model);

  const [model, setModel] = useState(models[0] ?? '');
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlaygroundResultView | null>(null);

  async function send(): Promise<void> {
    if (busy) return;
    if (model.trim() === '' || prompt.trim() === '') {
      setError(tr('admin.playground.missing'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (system.trim() !== '') messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const parsedTemperature = Number.parseFloat(temperature);
      const parsedMaxTokens = Number.parseInt(maxTokens, 10);
      const response = await fetch('/api/plugins/llm-gateway/admin/playground', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model.trim(),
          messages,
          ...(Number.isFinite(parsedTemperature) ? { temperature: parsedTemperature } : {}),
          ...(Number.isFinite(parsedMaxTokens) ? { maxTokens: parsedMaxTokens } : {}),
        }),
      });
      const json = (await response.json().catch(() => null)) as {
        result?: PlaygroundResultView;
        error?: { message?: string };
      } | null;
      if (!response.ok || !json?.result) {
        console.error('[llm-gateway] playground failed', json);
        setError(
          json?.error?.message ?? tr('common.fetchFailedStatus', { status: response.status }),
        );
        return;
      }
      setResult(json.result);
    } catch (cause) {
      setError(failure(cause, tr('admin.playground.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="space-y-6">
      <PageHeader
        title={tr('admin.playground.title')}
        description={tr('admin.playground.description')}
      />
      {error ? <InlineError>{error}</InlineError> : null}
      <InlineNotice>{tr('admin.playground.notice')}</InlineNotice>
      <Card>
        <CardHeader>
          <SectionTitle>{tr('admin.playground.request')}</SectionTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <Label htmlFor="pg-model">{tr('admin.playground.model')}</Label>
              <Select
                id="pg-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.length === 0 ? (
                  <option value="">{tr('admin.playground.noModels')}</option>
                ) : (
                  models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Field>
              <Label htmlFor="pg-system">{tr('admin.playground.system')}</Label>
              <textarea
                id="pg-system"
                className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
                value={system}
                placeholder={tr('admin.playground.systemPlaceholder')}
                onChange={(event) => setSystem(event.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="pg-prompt">{tr('admin.playground.prompt')}</Label>
              <textarea
                id="pg-prompt"
                className="min-h-28 w-full rounded-md border bg-background p-2 text-sm"
                value={prompt}
                placeholder={tr('admin.playground.promptPlaceholder')}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Field className="w-32">
                <Label htmlFor="pg-temperature">{tr('admin.playground.temperature')}</Label>
                <Input
                  id="pg-temperature"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                />
              </Field>
              <Field className="w-40">
                <Label htmlFor="pg-max-tokens">{tr('admin.playground.maxTokens')}</Label>
                <Input
                  id="pg-max-tokens"
                  value={maxTokens}
                  placeholder={tr('admin.playground.optional')}
                  onChange={(event) => setMaxTokens(event.target.value)}
                />
              </Field>
            </div>
            <div>
              <Button type="button" disabled={busy} onClick={() => void send()}>
                {busy ? tr('admin.playground.running') : tr('admin.playground.run')}
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <SectionTitle>{tr('admin.playground.result')}</SectionTitle>
          <CardDescription>{tr('admin.playground.resultHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-3">
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
                {result.text === '' ? tr('admin.playground.emptyText') : result.text}
              </pre>
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <p>
                  {tr('admin.playground.latency')}: {result.latencyMs} ms
                </p>
                <p>
                  {tr('admin.playground.tokens')}: {result.usage.inputTokens} /{' '}
                  {result.usage.outputTokens} ({result.usage.totalTokens})
                </p>
                <p>
                  {tr('admin.playground.account')}: {result.account.name} ({result.account.provider}
                  )
                </p>
                <p>
                  {tr('admin.playground.upstreamModel')}: {result.upstreamModel}
                </p>
                <p>
                  {tr('admin.playground.stopReason')}: {result.stopReason}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{tr('admin.playground.empty')}</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export const adminPages = {
  'admin/overview': GatewayAdminOverview,
  'admin/accounts': GatewayAdminAccounts,
  'admin/usage': GatewayAdminUsageLogs,
  'admin/ops': GatewayAdminOps,
  'admin/account-editor': GatewayAdminAccountEditor,
  'admin/price-editor': GatewayAdminPriceEditor,
  'admin/playground': GatewayAdminPlayground,
} as const;
