import { defineFrontend } from '@stackpanel/sdk';
import type {
  AccountPageComponentProps,
  AccountWidgetProps,
  FrontendPackage,
} from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import Link from 'next/link';
import {
  Activity,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  FileText,
  History,
  Image as ImageIcon,
  KeyRound,
  Pencil,
  PieChart,
  Plus,
  Search,
  Tags,
  Terminal,
  Trash2,
  Type,
  Wallet,
} from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  PageHeader,
} from '@stackpanel/ui';
import type { z } from 'zod';
import {
  Empty,
  IconBadge,
  RANGE_OPTIONS,
  Section,
  Stat,
  USAGE_RANGES,
  adminAccountsSchema,
  adminOverviewSchema,
  adminPricesSchema,
  billingSchema,
  capabilityLabel,
  formatTokens,
  keysSchema,
  modelDisplayName,
  modelsText,
  money,
  publicPricesSchema,
  rangeLabel,
  shortTime,
  unitPrice,
  usageSchema,
} from './ui';
import type { UsageRange } from './ui';
import { UsageChart } from './usage-chart';
import { messages, t } from './i18n.js';

/**
 * 模型服务（llm-gateway）前端包（服务端 bundle）。
 *
 * - 用户：账户中心「模型服务」——创建/管理密钥、查看用量。
 * - 页面数据由宿主按 `fetch` 声明代为请求，不需要内嵌 finder 代码。
 *
 * 管理端交互页面在 `admin.tsx`（客户端 bundle，构建为 dist/admin.js）。
 */

/* --------------------------------- 用户页 --------------------------------- */

export function GatewayOverviewPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    billing?: z.infer<typeof billingSchema>;
    usage?: z.infer<typeof usageSchema>;
  };
  const billing = data.billing;
  const usage = data.usage;
  const setBilling = props.actions['llm-gateway.set-billing'];

  // 时间范围与指标都由 URL 驱动（服务端渲染无状态）：
  // ?range=today|7d|30d&metric=cost|tokens
  const range = USAGE_RANGES.includes(props.searchParams['range'] as UsageRange)
    ? (props.searchParams['range'] as UsageRange)
    : '30d';
  const metric = props.searchParams['metric'] === 'tokens' ? 'tokens' : 'cost';
  const active = usage?.ranges[range];
  const series = active?.series ?? [];
  const byModel = active?.byModel ?? [];
  const modelCount = byModel.length;
  const base = '/account/gateway';

  const rangeLabelText = rangeLabel(range, tr);

  const href = (next: { range?: UsageRange; metric?: 'cost' | 'tokens' }): string => {
    const params = new URLSearchParams();
    params.set('range', next.range ?? range);
    params.set('metric', next.metric ?? metric);
    return `${base}?${params.toString()}`;
  };

  const chartTitle =
    range === 'today'
      ? tr('overview.chartTitleToday')
      : tr('overview.chartTitleRange', { range: rangeLabelText });
  const chartDesc =
    range === 'today' ? tr('overview.chartDescToday') : tr('overview.chartDescRange');

  return (
    <main className="space-y-8">
      <PageHeader
        title={tr('overview.title')}
        actions={<RangePicker range={range} href={href} tr={tr} />}
      />

      {billing && !billing.enabled ? (
        <form
          action={setBilling}
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-3.5 text-sm"
        >
          <input type="hidden" name="enabled" value="true" />
          <span className="text-amber-700 dark:text-amber-400">{tr('overview.billingOff')}</span>
          <button
            type="submit"
            className="h-9 rounded-lg bg-foreground px-3 text-sm font-semibold text-background transition-opacity hover:opacity-90"
          >
            {tr('overview.enableBilling')}
          </button>
        </form>
      ) : null}

      {usage ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label={tr('overview.metricCost', { range: rangeLabelText })}
              value={money(active?.summary.amount ?? 0)}
            />
            <Stat
              label={tr('overview.metricRequests', { range: rangeLabelText })}
              value={String(active?.summary.requests ?? 0)}
            />
            <Stat
              label={tr('overview.metricTokens', { range: rangeLabelText })}
              value={formatTokens(active?.summary.totalTokens ?? 0)}
            />
          </div>

          <Section
            icon={<Activity />}
            title={chartTitle}
            description={chartDesc}
            action={
              <div className="inline-flex rounded-lg border p-0.5 text-sm">
                <Link
                  href={href({ metric: 'cost' })}
                  className={
                    metric === 'cost'
                      ? 'rounded-md bg-primary/10 px-3 py-1 font-medium text-primary'
                      : 'rounded-md px-3 py-1 text-muted-foreground hover:bg-muted'
                  }
                >
                  {tr('overview.metricCostShort')}
                </Link>
                <Link
                  href={href({ metric: 'tokens' })}
                  className={
                    metric === 'tokens'
                      ? 'rounded-md bg-primary/10 px-3 py-1 font-medium text-primary'
                      : 'rounded-md px-3 py-1 text-muted-foreground hover:bg-muted'
                  }
                >
                  Token
                </Link>
              </div>
            }
          >
            <div className="rounded-xl border bg-card px-3 py-3 sm:px-5 sm:py-4">
              <UsageChart
                data={series.map((point) => ({
                  label: point.label,
                  value: metric === 'tokens' ? point.tokens : point.amount,
                }))}
                formatValue={metric === 'tokens' ? formatTokens : money}
                ariaLabel={tr('overview.chartAria')}
              />
            </div>
          </Section>

          <Section
            icon={<PieChart />}
            title={tr('overview.byModelTitle')}
            description={tr('overview.byModelDescription', { range: rangeLabelText })}
            action={
              <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground tabular-nums">
                {tr('overview.modelCount', { count: modelCount })}
              </span>
            }
          >
            {byModel.length ? (
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
                {byModel.map((row) => (
                  <li
                    key={row.model}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{modelDisplayName(row.model, tr)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {tr('overview.modelRowMeta', {
                          requests: row.requests,
                          tokens: formatTokens(row.tokens),
                        })}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono font-semibold tabular-nums">
                      {money(row.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                text={tr('overview.byModelEmpty', { range: rangeLabelText })}
                icon={<PieChart />}
              />
            )}
          </Section>

          <Section
            icon={<History />}
            title={tr('overview.recentTitle')}
            description={tr('overview.recentDescription')}
          >
            {usage.logs.length ? (
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
                {usage.logs.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{modelDisplayName(log.model, tr)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {shortTime(log.createdAt, props.locale ?? 'zh-CN')}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatTokens(log.totalTokens)} token
                      </span>
                      {log.latencyMs !== null ? (
                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                          {log.latencyMs}ms
                        </span>
                      ) : null}
                      <span
                        className={
                          log.status === 'SUCCESS'
                            ? 'text-xs text-emerald-600'
                            : 'text-xs text-destructive'
                        }
                      >
                        {log.status === 'SUCCESS' ? tr('common.success') : tr('common.failed')}
                      </span>
                      <span className="font-mono font-semibold tabular-nums">
                        {money(log.amount)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text={tr('overview.recentEmpty')} icon={<History />} />
            )}
          </Section>
        </>
      ) : null}
    </main>
  );
}

/**
 * 时间范围选择器：纯 `<details>` 折叠，无 JS。选项是链接，切换后整页重渲染。
 */
function RangePicker({
  range,
  href,
  tr,
}: {
  range: UsageRange;
  href: (next: { range: UsageRange }) => string;
  tr: (key: string, params?: Record<string, string | number>) => string;
}): ReactElement {
  const current = RANGE_OPTIONS.find((option) => option.value === range) ?? RANGE_OPTIONS[0];
  return (
    <details className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
        <CalendarDays className="size-4 text-muted-foreground" />
        {tr(current.labelKey)}
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-40 rounded-xl border bg-popover p-1 shadow-md">
        {RANGE_OPTIONS.map((option) => {
          const activeOption = option.value === range;
          return (
            <Link
              key={option.value}
              href={href({ range: option.value })}
              className={
                activeOption
                  ? 'flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm font-medium'
                  : 'flex items-center justify-between rounded-lg px-3 py-1.5 text-sm hover:bg-muted/60'
              }
            >
              {tr(option.labelKey)}
              {activeOption ? <Check className="size-4 text-primary" /> : null}
            </Link>
          );
        })}
      </div>
    </details>
  );
}

/** 模型定价：搜索 + 行选中 + 右侧详情（全部 URL 驱动，服务端渲染）。 */
export function GatewayPricingPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as { prices?: z.infer<typeof publicPricesSchema> };
  const prices = data.prices?.prices ?? [];
  const query = (props.searchParams['q'] ?? '').trim().toLowerCase();
  const selectedId = props.searchParams['model'] ?? '';

  // 兜底行 `*` 固定排在最后，避免抢占第一行/默认选中。
  const ordered = [...prices].sort((a, b) => {
    if (a.model === '*') return 1;
    if (b.model === '*') return -1;
    return a.model.localeCompare(b.model);
  });
  const filtered = query
    ? ordered.filter((price) => price.model.toLowerCase().includes(query))
    : ordered;
  // 默认选中第一个真实模型（有兜底行时才退到它）。
  const selected =
    prices.find((price) => price.model === selectedId) ??
    filtered.find((price) => price.model !== '*') ??
    filtered[0] ??
    null;

  const base = '/account/gateway/pricing';

  return (
    <main className="space-y-8">
      <PageHeader
        title={tr('pricing.title')}
        actions={
          <>
            <form method="get" action={base} className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                name="q"
                defaultValue={props.searchParams['q'] ?? ''}
                placeholder={tr('pricing.searchPlaceholder')}
                className="h-9 w-56 rounded-lg border bg-background pl-8 pr-3 text-sm outline-none focus-visible:border-ring"
              />
            </form>
            <span className="text-xs text-muted-foreground tabular-nums">
              {tr('pricing.total', { count: prices.length })}
            </span>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0">
          {filtered.length ? (
            <div className="overflow-x-auto rounded-2xl border bg-card shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">{tr('pricing.colModel')}</th>
                    <th className="px-3 py-2">{tr('pricing.colCapability')}</th>
                    <th className="px-3 py-2 whitespace-nowrap">{tr('pricing.colInput')}</th>
                    <th className="px-3 py-2 whitespace-nowrap">{tr('pricing.colOutput')}</th>
                    <th className="px-3 py-2 whitespace-nowrap">{tr('pricing.colCacheRead')}</th>
                    <th className="px-3 py-2 whitespace-nowrap">{tr('pricing.colCacheWrite')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((price) => {
                    const active = selected?.model === price.model;
                    return (
                      <tr
                        key={price.model}
                        className={
                          active ? 'border-b bg-primary/5 last:border-0' : 'border-b last:border-0'
                        }
                      >
                        <td className="px-3 py-2">
                          <Link
                            href={`${base}?model=${encodeURIComponent(price.model)}${
                              query ? `&q=${encodeURIComponent(query)}` : ''
                            }`}
                            className="font-medium whitespace-nowrap hover:underline"
                          >
                            {modelDisplayName(price.model, tr)}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <CapabilityIcons value={price.capabilities} tr={tr} />
                        </td>
                        <td className="px-3 py-2 tabular-nums">{money(price.inputPrice)}</td>
                        <td className="px-3 py-2 tabular-nums">{money(price.outputPrice)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {money(price.cacheReadPrice)}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {money(price.cacheWritePrice)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text={query ? tr('pricing.noMatch') : tr('pricing.empty')} icon={<Tags />} />
          )}
        </section>

        <aside className="h-fit lg:sticky lg:top-6">
          {selected ? (
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <IconBadge>
                  <Tags />
                </IconBadge>
                <h2 className="min-w-0 truncate font-semibold">
                  {modelDisplayName(selected.model, tr)}
                </h2>
              </div>
              {selected.model === '*' ? (
                <p className="mt-1.5 text-xs text-muted-foreground">{tr('pricing.fallbackNote')}</p>
              ) : (
                <p className="mt-1.5 font-mono text-xs text-muted-foreground">{selected.model}</p>
              )}
              <div className="mt-4">
                <CapabilityIcons value={selected.capabilities} tr={tr} />
              </div>
              <dl className="mt-4 grid gap-2 text-sm">
                <PriceRow
                  label={tr('pricing.priceInput')}
                  value={unitPrice(selected.inputPrice, tr)}
                />
                <PriceRow
                  label={tr('pricing.priceOutput')}
                  value={unitPrice(selected.outputPrice, tr)}
                />
                <PriceRow
                  label={tr('pricing.priceCacheRead')}
                  value={unitPrice(selected.cacheReadPrice, tr)}
                />
                <PriceRow
                  label={tr('pricing.priceCacheWrite')}
                  value={unitPrice(selected.cacheWritePrice, tr)}
                />
                <PriceRow label={tr('pricing.priceMultiplier')} value={`${selected.multiplier}%`} />
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">{tr('pricing.cacheNote')}</p>
            </div>
          ) : (
            <Empty text={tr('pricing.selectHint')} icon={<Tags />} />
          )}
        </aside>
      </div>
    </main>
  );
}

function PriceRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

const CAPABILITY_ICONS: Record<string, { icon: typeof Brain; labelKey: string }> = {
  reasoning: { icon: Brain, labelKey: 'capability.reasoning' },
  image: { icon: ImageIcon, labelKey: 'capability.image' },
  pdf: { icon: FileText, labelKey: 'capability.pdf' },
  tools: { icon: Terminal, labelKey: 'capability.tools' },
  text: { icon: Type, labelKey: 'capability.text' },
};

/** 能力图标行（无能力时不渲染）。 */
function CapabilityIcons({
  value,
  tr,
}: {
  value: string[];
  tr: (key: string, params?: Record<string, string | number>) => string;
}): ReactElement | null {
  if (!value.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((capability) => {
        const entry = CAPABILITY_ICONS[capability];
        const Icon = entry?.icon ?? Type;
        return (
          <span
            key={capability}
            title={entry ? tr(entry.labelKey) : capabilityLabel(capability, tr)}
            className="inline-flex size-6 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"
          >
            <Icon className="size-3.5" />
          </span>
        );
      })}
    </div>
  );
}

/**
 * 「创建密钥」对话框。抽成独立组件以便放进 `PageHeader` 的 actions 槽，
 * 避免把创建入口埋在内容区里。
 */
function CreateKeyDialog({
  action,
  tr,
}: {
  action: (formData: FormData) => void;
  tr: (key: string, params?: Record<string, string | number>) => string;
}): ReactElement {
  return (
    <Dialog>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" />
        {tr('keys.create')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr('keys.createTitle')}</DialogTitle>
          <DialogDescription>{tr('keys.createDescription')}</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">{tr('keys.name')}</Label>
            <Input id="key-name" name="name" required placeholder={tr('keys.namePlaceholder')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-models">{tr('keys.models')}</Label>
            <Input id="key-models" name="models" placeholder="gpt-4o-mini" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="key-expires">{tr('keys.expires')}</Label>
              <Input id="key-expires" name="expiresInDays" type="number" min={1} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-rpm">{tr('keys.rpm')}</Label>
              <Input id="key-rpm" name="rpmLimit" type="number" min={0} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-concurrency">{tr('keys.concurrency')}</Label>
              <Input id="key-concurrency" name="concurrencyLimit" type="number" min={0} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">{tr('keys.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * API 计费开关（页面级设置）。服务端表单提交相反状态；
 * 未开启时网关对所有调用返回 403 `billing_disabled`。
 */
function BillingToggle({
  enabled,
  action,
  tr,
}: {
  enabled: boolean;
  action: (formData: FormData) => void;
  tr: (key: string, params?: Record<string, string | number>) => string;
}): ReactElement {
  return (
    <form action={action}>
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <Button type="submit" variant={enabled ? 'outline' : 'default'} size="sm">
        {enabled ? tr('keys.billingOn') : tr('keys.billingOffAction')}
      </Button>
    </form>
  );
}

/** API 密钥：创建、启停、删除。 */
export function GatewayKeysPage(props: AccountPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const data = props.data as {
    keys?: z.infer<typeof keysSchema>;
    billing?: z.infer<typeof billingSchema>;
  };
  const keys = data.keys;
  const billing = data.billing;
  const createKey = props.actions['llm-gateway.create-key'];
  const setBilling = props.actions['llm-gateway.set-billing'];

  return (
    <main className="space-y-8">
      <PageHeader
        title={tr('keys.title')}
        actions={<CreateKeyDialog action={createKey} tr={tr} />}
      />

      <Section
        icon={<Wallet />}
        title={tr('keys.billingTitle')}
        description={tr('keys.billingDescription')}
        action={<BillingToggle enabled={billing?.enabled ?? false} action={setBilling} tr={tr} />}
      >
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
          <li className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
            <span className="text-muted-foreground">{tr('keys.statusLabel')}</span>
            <span
              className={
                billing?.enabled
                  ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                  : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
              }
            >
              {billing?.enabled ? tr('keys.statusEnabled') : tr('keys.statusDisabled')}
            </span>
          </li>
          <li className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
            <span className="text-muted-foreground">{tr('keys.balance')}</span>
            <span className="font-mono font-semibold tabular-nums">
              {money(billing?.balance ?? 0)}
            </span>
          </li>
        </ul>
      </Section>

      {keys?.revealedKey ? (
        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <IconBadge className="bg-emerald-500/15 text-emerald-600">
              <KeyRound />
            </IconBadge>
            {tr('keys.revealed')}
          </div>
          <code className="mt-3 block break-all rounded-lg bg-background px-3 py-2 font-mono text-sm">
            {keys.revealedKey}
          </code>
        </div>
      ) : null}

      <Section icon={<KeyRound />} title={tr('keys.mine')} description={tr('keys.mineDescription')}>
        {keys?.keys?.length ? (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-sm">
            {keys.keys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    {key.name}
                    <span
                      className={
                        key.status === 'ACTIVE'
                          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600'
                          : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                      }
                    >
                      {key.status === 'ACTIVE' ? tr('common.enabled') : tr('common.disabled')}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{key.keyPrefix}…</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr('keys.quotaUsed', {
                      models: modelsText(key.models, tr),
                      used:
                        key.quotaLimit !== null
                          ? `${money(key.quotaUsed)} / ${money(key.quotaLimit)}`
                          : money(key.quotaUsed),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Dialog>
                    <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
                      <Pencil className="size-3.5" />
                      {tr('common.edit')}
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-lg">
                      <DialogHeader>
                        <DialogTitle>{tr('keys.editTitle', { name: key.name })}</DialogTitle>
                        <DialogDescription>{tr('keys.editDescription')}</DialogDescription>
                      </DialogHeader>
                      <form action={props.actions['llm-gateway.update-key']} className="grid gap-4">
                        <input type="hidden" name="id" value={key.id} />
                        <div className="grid gap-1.5">
                          <Label htmlFor={`key-name-${key.id}`}>{tr('keys.name')}</Label>
                          <Input
                            id={`key-name-${key.id}`}
                            name="name"
                            required
                            defaultValue={key.name}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`key-models-${key.id}`}>{tr('keys.models')}</Label>
                          <Input
                            id={`key-models-${key.id}`}
                            name="models"
                            defaultValue={key.models.join(', ')}
                          />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="grid gap-1.5">
                            <Label htmlFor={`key-rpm-${key.id}`}>{tr('keys.rpm')}</Label>
                            <Input
                              id={`key-rpm-${key.id}`}
                              name="rpmLimit"
                              type="number"
                              min={0}
                              defaultValue={key.rpmLimit}
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor={`key-concurrency-${key.id}`}>
                              {tr('keys.concurrency')}
                            </Label>
                            <Input
                              id={`key-concurrency-${key.id}`}
                              name="concurrencyLimit"
                              type="number"
                              min={0}
                              defaultValue={key.concurrencyLimit}
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button type="submit">{tr('keys.saveEdit')}</Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                  <form action={props.actions['llm-gateway.update-key']}>
                    <input type="hidden" name="id" value={key.id} />
                    <input
                      type="hidden"
                      name="status"
                      value={key.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}
                    />
                    <Button type="submit" variant="ghost" size="sm">
                      {key.status === 'ACTIVE' ? tr('common.disabled') : tr('common.enabled')}
                    </Button>
                  </form>
                  <form action={props.actions['llm-gateway.delete-key']}>
                    <input type="hidden" name="id" value={key.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text={tr('keys.empty')} icon={<KeyRound />} />
        )}
      </Section>
    </main>
  );
}

export function GatewayAccountWidget(props: AccountWidgetProps): ReactElement {
  const tr = t(props.locale);
  return (
    <Link
      href="/account/gateway"
      className="group block rounded-2xl border bg-card p-5 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Brain className="size-5" />
      </span>
      <p className="mt-4 text-sm font-semibold">{tr('widget.title')}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{tr('widget.description')}</p>
    </Link>
  );
}

/* --------------------------------- 导出 --------------------------------- */

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  ui: {
    actions: [
      {
        id: 'llm-gateway.set-billing',
        method: 'POST',
        path: '/llm-gateway/billing',
        permission: 'llm-gateway.use',
        // The toggle's own state is the receipt.
        silent: true,
        input: [{ name: 'enabled', type: 'boolean', required: true }],
      },
      {
        id: 'llm-gateway.create-key',
        method: 'POST',
        path: '/llm-gateway/keys',
        permission: 'llm-gateway.use',
        successFeedback: { messageKey: 'feedback.keyCreated' },
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 64 },
          { name: 'models', type: 'string', maxLength: 500 },
          { name: 'expiresInDays', type: 'integer', min: 1, max: 3650 },
          { name: 'rpmLimit', type: 'integer', min: 0 },
          { name: 'concurrencyLimit', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.update-key',
        method: 'PATCH',
        path: '/llm-gateway/keys/:id',
        permission: 'llm-gateway.use',
        successFeedback: { messageKey: 'feedback.keyUpdated' },
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', maxLength: 64 },
          { name: 'status', type: 'string', maxLength: 16 },
          { name: 'models', type: 'string', maxLength: 500 },
          { name: 'rpmLimit', type: 'integer', min: 0 },
          { name: 'concurrencyLimit', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.delete-key',
        method: 'DELETE',
        path: '/llm-gateway/keys/:id',
        permission: 'llm-gateway.use',
        successFeedback: { messageKey: 'feedback.keyDeleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'llm-gateway.create-account',
        method: 'POST',
        path: '/llm-gateway/admin/accounts',
        permission: 'llm-gateway.admin',
        successFeedback: { messageKey: 'feedback.accountCreated' },
        input: [
          { name: 'name', type: 'string', required: true, maxLength: 64 },
          { name: 'baseUrl', type: 'string', required: true, maxLength: 500 },
          { name: 'apiKey', type: 'string', required: true, maxLength: 500 },
          { name: 'provider', type: 'string', maxLength: 32 },
          { name: 'models', type: 'ids', maxLength: 128, max: 500 },
          { name: 'priority', type: 'integer' },
          { name: 'weight', type: 'integer', min: 1 },
          { name: 'maxConcurrency', type: 'integer', min: 0 },
        ],
      },
      {
        id: 'llm-gateway.update-account',
        method: 'PATCH',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        successFeedback: { messageKey: 'feedback.accountUpdated' },
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'name', type: 'string', maxLength: 64 },
          { name: 'baseUrl', type: 'string', maxLength: 500 },
          { name: 'apiKey', type: 'string', maxLength: 500 },
          { name: 'provider', type: 'string', maxLength: 32 },
          { name: 'models', type: 'ids', maxLength: 128, max: 500 },
          { name: 'priority', type: 'integer' },
          { name: 'weight', type: 'integer', min: 1 },
          { name: 'maxConcurrency', type: 'integer', min: 0 },
          { name: 'status', type: 'string', maxLength: 16 },
        ],
      },
      {
        id: 'llm-gateway.set-account-status',
        method: 'PATCH',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        // Status flips are already visible in the row; only failures need a toast.
        silent: true,
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'status', type: 'string', required: true, maxLength: 16 },
        ],
      },
      {
        id: 'llm-gateway.delete-account',
        method: 'DELETE',
        path: '/llm-gateway/admin/accounts/:id',
        permission: 'llm-gateway.admin',
        successFeedback: { messageKey: 'feedback.accountDeleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
      {
        id: 'llm-gateway.save-price',
        method: 'POST',
        path: '/llm-gateway/admin/prices',
        permission: 'llm-gateway.admin',
        successFeedback: { messageKey: 'feedback.priceSaved' },
        input: [
          { name: 'model', type: 'string', required: true, maxLength: 128 },
          { name: 'upstreamModel', type: 'string', maxLength: 128 },
          { name: 'inputPrice', type: 'integer', required: true, min: 0 },
          { name: 'outputPrice', type: 'integer', required: true, min: 0 },
          { name: 'cacheReadPrice', type: 'integer', min: 0 },
          { name: 'cacheWritePrice', type: 'integer', min: 0 },
          { name: 'capabilities', type: 'ids', maxLength: 32, max: 8 },
          { name: 'multiplier', type: 'integer', min: 0 },
          { name: 'enabled', type: 'boolean' },
        ],
      },
      {
        id: 'llm-gateway.delete-price',
        method: 'DELETE',
        path: '/llm-gateway/admin/prices/:id',
        permission: 'llm-gateway.admin',
        successFeedback: { messageKey: 'feedback.priceDeleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/overview',
        permission: 'llm-gateway.admin',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group', order: 0 },
        data: [{ fetch: { path: '/llm-gateway/admin/overview' }, as: 'overview' }],
      },
      {
        path: '/accounts/new',
        component: 'admin/account-editor',
        permission: 'llm-gateway.admin',
        data: [{ fetch: { path: '/llm-gateway/admin/accounts' }, as: 'accounts' }],
      },
      {
        path: '/accounts/:id/edit',
        component: 'admin/account-editor',
        permission: 'llm-gateway.admin',
        data: [{ fetch: { path: '/llm-gateway/admin/accounts' }, as: 'accounts' }],
      },
      {
        path: '/prices/new',
        component: 'admin/price-editor',
        permission: 'llm-gateway.admin',
        data: [
          { fetch: { path: '/llm-gateway/admin/accounts' }, as: 'accounts' },
          { fetch: { path: '/llm-gateway/admin/prices' }, as: 'prices' },
        ],
      },
      {
        path: '/prices/:id/edit',
        component: 'admin/price-editor',
        permission: 'llm-gateway.admin',
        data: [
          { fetch: { path: '/llm-gateway/admin/accounts' }, as: 'accounts' },
          { fetch: { path: '/llm-gateway/admin/prices' }, as: 'prices' },
        ],
      },
      {
        path: '/accounts',
        component: 'admin/accounts',
        permission: 'llm-gateway.admin',
        nav: {
          labelKey: 'nav.adminAccounts',
          groupKey: 'nav.group',
          order: 10,
          activePaths: ['/prices'],
        },
        data: [
          { fetch: { path: '/llm-gateway/admin/accounts' }, as: 'accounts' },
          { fetch: { path: '/llm-gateway/admin/prices' }, as: 'prices' },
        ],
      },
    ],
    accountRoutes: [
      {
        path: '/gateway',
        component: 'account/gateway-overview',
        permission: 'llm-gateway.use',
        nav: { labelKey: 'nav.overview', groupKey: 'nav.group' },
        data: [
          { fetch: { path: '/llm-gateway/billing' }, as: 'billing' },
          { fetch: { path: '/llm-gateway/usage' }, as: 'usage' },
        ],
      },
      {
        path: '/gateway/pricing',
        component: 'account/gateway-pricing',
        permission: 'llm-gateway.use',
        nav: { labelKey: 'nav.pricing', groupKey: 'nav.group' },
        data: [{ fetch: { path: '/llm-gateway/prices' }, as: 'prices' }],
      },
      {
        path: '/gateway/keys',
        component: 'account/gateway-keys',
        permission: 'llm-gateway.use',
        nav: { labelKey: 'nav.keys', groupKey: 'nav.group' },
        data: [
          { fetch: { path: '/llm-gateway/billing' }, as: 'billing' },
          { fetch: { path: '/llm-gateway/keys' }, as: 'keys' },
        ],
      },
    ],
    accountWidgets: [
      {
        id: 'llm-gateway',
        titleKey: 'widget.title',
        title: '模型服务',
        component: 'account/gateway',
        permission: 'llm-gateway.use',
      },
    ],
    accountPages: {
      'account/gateway-overview': GatewayOverviewPage,
      'account/gateway-pricing': GatewayPricingPage,
      'account/gateway-keys': GatewayKeysPage,
    },
    accountWidgetComponents: { 'account/gateway': GatewayAccountWidget },
  },
};

export default defineFrontend(frontend);
