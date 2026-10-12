import type { ReactElement, ReactNode } from 'react';
import { Boxes } from 'lucide-react';
import { z } from 'zod';

/**
 * llm-gateway 前端共享层。
 *
 * 被两个入口复用：
 * - `index.tsx`（服务端前端包：finders / 用户账户页）
 * - `admin.tsx`（客户端管理页：交互式 admin 组件）
 *
 * 这里只放纯展示件、格式化函数与 zod schema，禁止 React hooks，
 * 以保证既可进 Node 服务端 bundle，也可进浏览器客户端 bundle。
 */

/* --------------------------------- schema -------------------------------- */

export const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  status: z.string(),
  models: z.array(z.string()),
  rpmLimit: z.number(),
  concurrencyLimit: z.number(),
  quotaLimit: z.number().nullable(),
  quotaUsed: z.number(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const keysSchema = z.object({
  revealedKey: z.string().nullable(),
  keys: z.array(keySchema),
});

export const usageLogSchema = z.object({
  id: z.string(),
  model: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  amount: z.number(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  createdAt: z.string(),
});

export const modelUsageSchema = z.object({
  model: z.string(),
  amount: z.number(),
  tokens: z.number(),
  requests: z.number(),
});

export const usagePointSchema = z.object({
  /** X 轴标签：今日为 `0:00`，按天为 `9/28`。 */
  label: z.string(),
  amount: z.number(),
  tokens: z.number(),
});

export const rangeUsageSchema = z.object({
  summary: z.object({
    requests: z.number(),
    amount: z.number(),
    totalTokens: z.number(),
  }),
  /** 按时间聚合的曲线数据。 */
  series: z.array(usagePointSchema).default([]),
  /** 按模型聚合并按消费降序。 */
  byModel: z.array(modelUsageSchema).default([]),
});

export const USAGE_RANGES = ['today', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const usageSchema = z.object({
  ranges: z.object({
    today: rangeUsageSchema,
    '7d': rangeUsageSchema,
    '30d': rangeUsageSchema,
  }),
  logs: z.array(usageLogSchema),
});

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  models: z.unknown(),
  status: z.string(),
  priority: z.number(),
  weight: z.number(),
  maxConcurrency: z.number(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

/** 上游协议选项（与后端 PROTOCOLS 对齐）。 */
export const PROTOCOL_OPTIONS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'gemini', label: 'Google Gemini' },
] as const;

/** 概览页时间范围选项。 */
export const RANGE_OPTIONS = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
] as const;

export function protocolLabel(value: string): string {
  return PROTOCOL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** 模型能力标记（自由文本，与后端 capabilities 对齐）。 */
export const CAPABILITY_OPTIONS = [
  { value: 'reasoning', label: '推理' },
  { value: 'image', label: '图像' },
  { value: 'pdf', label: 'PDF' },
  { value: 'tools', label: '工具' },
  { value: 'text', label: '文本' },
] as const;

export function capabilityLabel(value: string): string {
  return CAPABILITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export const priceSchema = z.object({
  id: z.string(),
  model: z.string(),
  /** 实际转发上游的模型名；空串表示与 `model` 相同。 */
  upstreamModel: z.string().default(''),
  inputPrice: z.number(),
  outputPrice: z.number(),
  cacheReadPrice: z.number(),
  cacheWritePrice: z.number(),
  multiplier: z.number(),
  capabilities: z.array(z.string()),
  enabled: z.boolean(),
});

export const adminOverviewSchema = z.object({
  accounts: z.number(),
  keys: z.number(),
  summary: z.object({ requests: z.number(), amount: z.number(), totalTokens: z.number() }),
  topModels: z.array(
    z.object({
      model: z.string(),
      requests: z.number(),
      amount: z.number(),
      totalTokens: z.number(),
    }),
  ),
  logs: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      totalTokens: z.number(),
      amount: z.number(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const adminAccountsSchema = z.object({ accounts: z.array(accountSchema) });
export const adminPricesSchema = z.object({ prices: z.array(priceSchema) });

export const billingSchema = z.object({
  enabled: z.boolean(),
  balance: z.number(),
  currency: z.string(),
});

/** 用户可见的模型定价（已把倍率折算进单价，minor / 百万 token）。 */
export const publicPricesSchema = z.object({
  currency: z.string(),
  unitTokens: z.number(),
  prices: z.array(
    z.object({
      model: z.string(),
      inputPrice: z.number(),
      outputPrice: z.number(),
      cacheReadPrice: z.number(),
      cacheWritePrice: z.number(),
      multiplier: z.number(),
      capabilities: z.array(z.string()),
    }),
  ),
});

/** 单位：minor / 百万 token → 「¥x.xx / 百万 token」。 */
export function unitPrice(minorPerMillion: number): string {
  return `${money(minorPerMillion)} / 百万`;
}

/* -------------------------------- 格式化 -------------------------------- */

export function money(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

export function shortTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 紧凑数字：1200 → 1.2k，3_400_000 → 3.4M。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function modelsText(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) return value.join(', ');
  return '不限';
}

/* ------------------------------- 通用样式件 ------------------------------ */

/** Small leading icon badge used by section titles and lists. */
export function IconBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span
      className={`flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ${className ?? ''}`}
      aria-hidden="true"
    >
      {/* 与 /account/balance 的 Icon 一致：内层用 em 尺寸，图标随标题字号缩放。 */}
      <span className="inline-flex size-[1.15em] shrink-0 items-center justify-center leading-none [&_svg]:size-full">
        {children}
      </span>
    </span>
  );
}

/**
 * A titled content section: optional icon badge + title + description on the
 * left, optional action on the right, then the content. The content is not
 * wrapped in another card — sections compose plain surfaces so cards only
 * appear where they carry meaning.
 */
export function Section({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {icon ? <IconBadge>{icon}</IconBadge> : null}
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A single metric tile. Top-level surface, never nested inside a card. */
export function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
    </div>
  );
}

export function Empty({ text, icon }: { text: string; icon?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
        {icon ?? <Boxes />}
      </span>
      <p className="mt-3 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function Stats({ items }: { items: Array<{ label: string; value: string }> }): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((item) => (
        <Stat key={item.label} label={item.label} value={item.value} />
      ))}
    </div>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  defaultValue,
  placeholder,
  required,
  min,
  max,
  step,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
}): ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        min={min}
        max={max}
        step={step}
        className="h-10 rounded-lg border bg-background px-3 outline-none focus-visible:border-ring"
      />
    </label>
  );
}

/* --------------------------------- 图表 ---------------------------------- */

const SVG_W = 760;
const SVG_H = 240;
const PAD_L = 54;
const PAD_R = 16;
const PAD_T = 20;
const PAD_B = 30;
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

/** 取「好看」的坐标轴上限（1/2/2.5/5 × 10^n）。 */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return step * base;
}

/**
 * 单调三次插值（Fritsch–Carlson）→ 平滑曲线。
 *
 * 相比 Catmull-Rom 不会在数据点之间过冲下冲，折线感消失又不会凭空造出
 * 不存在的峰谷——用量图最忌讳假波动。
 */
function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  const n = points.length;
  if (n === 1) return `M ${points[0]![0].toFixed(2)} ${points[0]![1].toFixed(2)}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const step = points[i + 1]![0] - points[i]![0] || 1e-6;
    dx.push(step);
    slope.push((points[i + 1]![1] - points[i]![1]) / step);
  }

  const tangent: number[] = new Array<number>(n).fill(0);
  tangent[0] = slope[0]!;
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    if (a * b <= 0) {
      tangent[i] = 0;
    } else {
      tangent[i] = (2 * a * b) / (a + b);
    }
  }

  let d = `M ${points[0]![0].toFixed(2)} ${points[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const step = dx[i]!;
    const c1x = p1[0] + step / 3;
    const c1y = p1[1] + (tangent[i]! * step) / 3;
    const c2x = p2[0] - step / 3;
    const c2y = p2[1] - (tangent[i + 1]! * step) / 3;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/**
 * 服务端渲染的小时用量面积图（纯内联 SVG，零客户端 JS）。
 *
 * 账户页是服务端组件、不能用 recharts（要 hooks），所以手画 SVG：
 * 平滑曲线 + 渐变面积 + 稀疏虚线网格，无可见数据点（悬浮才出提示）。
 */
export function AreaChart({
  series,
  formatValue,
  labelEvery = 1,
  labels,
}: {
  series: number[];
  formatValue: (value: number) => string;
  labelEvery?: number;
  /** X 轴刻度文案，缺省按小时 `{i}:00`。 */
  labels?: string[];
}): ReactElement {
  const max = niceCeil(Math.max(...series, 0));
  const n = series.length;
  const x = (i: number): number => PAD_L + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const y = (v: number): number => PAD_T + PLOT_H - (v / max) * PLOT_H;

  const points = series.map((value, index) => [x(index), y(value)] as [number, number]);
  const line = smoothPath(points);
  const baseline = PAD_T + PLOT_H;
  const area = `${line} L ${x(n - 1).toFixed(2)} ${baseline} L ${x(0).toFixed(2)} ${baseline} Z`;

  const gridValues = [0, max / 2, max];
  const tickHours = series.map((_, index) => index).filter((hour) => hour % labelEvery === 0);
  const tickLabel = (index: number): string => labels?.[index] ?? `${index}:00`;

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="h-64 w-full text-primary"
      role="img"
      aria-label="小时用量"
    >
      <defs>
        <linearGradient id="llmGatewayArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>

      {gridValues.map((value) => (
        <line
          key={`grid-${value}`}
          x1={PAD_L}
          x2={PAD_L + PLOT_W}
          y1={y(value)}
          y2={y(value)}
          className={value === 0 ? 'stroke-border' : 'stroke-border/60'}
          strokeWidth={1}
          strokeDasharray={value === 0 ? undefined : '3 5'}
        />
      ))}
      {gridValues.map((value) => (
        <text
          key={`label-${value}`}
          x={PAD_L - 10}
          y={y(value) + 3.5}
          textAnchor="end"
          className="fill-muted-foreground text-[10px] tabular-nums"
        >
          {formatValue(value)}
        </text>
      ))}

      <path d={area} fill="url(#llmGatewayArea)" />
      <path
        d={line}
        fill="none"
        className="stroke-primary"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {points.map(([px, py], index) => (
        <circle key={`hit-${index}`} cx={px} cy={py} r={9} fill="transparent">
          <title>{`${tickLabel(index)} · ${formatValue(series[index] ?? 0)}`}</title>
        </circle>
      ))}

      {tickHours.map((hour) => (
        <text
          key={`tick-${hour}`}
          x={x(hour)}
          y={SVG_H - 9}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px] tabular-nums"
        >
          {tickLabel(hour)}
        </text>
      ))}
    </svg>
  );
}
