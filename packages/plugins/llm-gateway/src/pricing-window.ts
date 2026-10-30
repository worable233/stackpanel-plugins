/**
 * 时段价（峰谷定价）。
 *
 * 一条定价行可以挂若干**时段窗口**：请求结算时刻落在某个窗口内时，该窗口的
 * 价格覆盖基础价（窗口未写的字段继承基础价）。多个窗口按数组顺序取第一个命中。
 *
 * 为什么要独立成文件：时段判断全是「时区 / 跨午夜 / 星期」的纯计算，必须能
 * 单测，不能混进 relay 的 I/O 逻辑里——算错一小时就是算错钱。
 *
 * 与阶梯价（`PriceTier`）的分工：
 * - 阶梯价按**这次请求的输入长度**选价（长上下文档位）；
 * - 时段价按**这次请求发生在什么时候**选价（峰谷）。
 *
 * 两者同时配置时的优先级：`基础价 < 时段价 < 阶梯价`。即时段价先替换基础价，
 * 阶梯价再在替换后的价格上按用量覆盖。这样「峰谷 + 长上下文」可以叠加，
 * 且语义唯一确定（不会出现两个维度互相覆盖、结果取决于求值顺序）。
 */
import type { ModelPrice } from './pricing.js';

/** 一周七天的 ISO 编号：1 = 周一 … 7 = 周日。 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * 一条时段价窗口。
 *
 * 计价方式二选一（`percent` 优先）：
 * - `percent > 0`：把基础价的**售价与成本**整体乘 `percent%`（峰谷通常就是
 *   「低谷打几折」，一个数字说清楚，不必逐项抄价格）；
 * - 否则：只覆盖显式填写的单价，未填的字段继承基础价。
 */
export interface PriceWindow {
  /**
   * IANA 时区（如 `Asia/Shanghai`）。空 = UTC。
   * 必须显式给，否则「22:00 以后」在部署到别的时区时会悄悄偏移。
   */
  timezone?: string | undefined;
  /**
   * 生效星期（1=周一 … 7=周日）。空数组/未填 = 每天。
   */
  weekdays?: readonly number[] | undefined;
  /**
   * 生效时段 `HH:MM-HH:MM`。`end <= start` 视为**跨午夜**
   * （如 `22:00-02:00` 表示 22:00 到次日 02:00）。
   */
  hours: string;
  /** 比例模式：售价与成本统一乘 `percent%`；0/未填 = 用下面的显式单价。 */
  percent?: number | undefined;
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
  cacheReadPrice?: number | undefined;
  cacheWritePrice?: number | undefined;
  reasoningPrice?: number | undefined;
  costInputPrice?: number | undefined;
  costOutputPrice?: number | undefined;
  costCacheReadPrice?: number | undefined;
  costCacheWritePrice?: number | undefined;
}

/** 一天有多少分钟。 */
const MINUTES_PER_DAY = 24 * 60;

/** `Intl` 给出的英文星期缩写 → ISO 编号。 */
const WEEKDAY_TO_ISO: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * 解析 `HH:MM` 成「当天第几分钟」。
 *
 * 只接受 0–23 时、0–59 分；`24:00` 单独允许并归一为 `1440`，因为排班表里
 * 「到 24:00」比「到 23:59」更自然，差一分钟就是漏计。
 */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (hour === 24 && minute === 0) return MINUTES_PER_DAY;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/** 把分钟数格式化回 `HH:MM`（用于归一化与错误提示）。 */
export function formatClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.trunc(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 解析 `HH:MM-HH:MM`；格式非法返回 null。 */
export function parseHoursRange(value: string): { start: number; end: number } | null {
  const parts = value.split('-');
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0] as string);
  const end = parseClock(parts[1] as string);
  if (start === null || end === null) return null;
  if (start === MINUTES_PER_DAY) return null;
  return { start, end };
}

/**
 * 把 `at` 换算成指定时区的「星期 + 当天第几分钟」。
 *
 * 时区非法时返回 null，由调用方决定降级策略（这里选择**不命中**，
 * 也就是回退到基础价——宁可少收时段折扣，也不要按错误时区乱收钱）。
 */
export function zonedClock(
  at: Date,
  timeZone: string,
): { weekday: number; minutes: number } | null {
  if (Number.isNaN(at.getTime())) return null;
  const zone = timeZone.trim() === '' ? 'UTC' : timeZone.trim();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
  } catch {
    return null;
  }
  let weekday: number | null = null;
  let hour: number | null = null;
  let minute: number | null = null;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = WEEKDAY_TO_ISO[part.value] ?? null;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  if (weekday === null || hour === null || minute === null) return null;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // 某些实现即使给了 h23 也会吐出 24:00，归一为次日 00:00。
  const normalizedHour = hour === 24 ? 0 : hour;
  return { weekday, minutes: normalizedHour * 60 + minute };
}

/**
 * 判断某个时刻是否落在窗口内。
 *
 * 星期归属按**窗口起点所在的那一天**算：`22:00-02:00` 配 `weekdays: [5]`
 * 表示「周五 22:00 到周六 02:00」，而不是「周五 22:00-24:00 加上周六 00:00-02:00」。
 * 这是排班表的通行语义，也是运营者填表时脑子里的那个意思。
 */
export function windowMatches(window: PriceWindow, at: Date): boolean {
  const range = parseHoursRange(window.hours);
  if (!range) return false;
  const clock = zonedClock(at, window.timezone ?? 'UTC');
  if (!clock) return false;

  const weekdays = (window.weekdays ?? []).filter(
    (day) => Number.isInteger(day) && day >= 1 && day <= 7,
  );
  const dayMatches = (iso: number): boolean => weekdays.length === 0 || weekdays.includes(iso);

  const { start, end } = range;
  if (end > start) {
    return dayMatches(clock.weekday) && clock.minutes >= start && clock.minutes < end;
  }
  // 跨午夜：起点当天算起，到次日 end 之前。
  if (clock.minutes >= start) return dayMatches(clock.weekday);
  if (clock.minutes < end) {
    // 次日凌晨的部分归属前一天：昨天 = 今天的 iso - 1（周一的前一天是周日）。
    const previous = clock.weekday === 1 ? 7 : clock.weekday - 1;
    return dayMatches(previous);
  }
  return false;
}

/** 按比例缩放一个金额（保持整数分，四舍五入）。 */
function scale(amount: number, percent: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(0, Math.round((amount * percent) / 100));
}

/**
 * 把窗口落到价格上。`percent` 模式缩放售价与成本两侧，显式模式只覆盖填了的字段。
 */
function overlay(base: ModelPrice, window: PriceWindow): Partial<ModelPrice> {
  const percent = window.percent ?? 0;
  if (percent > 0) {
    const patch: Partial<ModelPrice> = {
      inputPrice: scale(base.inputPrice, percent),
      outputPrice: scale(base.outputPrice, percent),
    };
    if (base.cacheReadPrice !== undefined) {
      patch.cacheReadPrice = scale(base.cacheReadPrice, percent);
    }
    if (base.cacheWritePrice !== undefined) {
      patch.cacheWritePrice = scale(base.cacheWritePrice, percent);
    }
    if (base.reasoningPrice !== undefined) {
      patch.reasoningPrice = scale(base.reasoningPrice, percent);
    }
    if (base.costInputPrice !== undefined) {
      patch.costInputPrice = scale(base.costInputPrice, percent);
    }
    if (base.costOutputPrice !== undefined) {
      patch.costOutputPrice = scale(base.costOutputPrice, percent);
    }
    if (base.costCacheReadPrice !== undefined) {
      patch.costCacheReadPrice = scale(base.costCacheReadPrice, percent);
    }
    if (base.costCacheWritePrice !== undefined) {
      patch.costCacheWritePrice = scale(base.costCacheWritePrice, percent);
    }
    return patch;
  }
  const patch: Partial<ModelPrice> = {};
  if (window.inputPrice !== undefined) patch.inputPrice = window.inputPrice;
  if (window.outputPrice !== undefined) patch.outputPrice = window.outputPrice;
  if (window.cacheReadPrice !== undefined) patch.cacheReadPrice = window.cacheReadPrice;
  if (window.cacheWritePrice !== undefined) patch.cacheWritePrice = window.cacheWritePrice;
  if (window.reasoningPrice !== undefined) patch.reasoningPrice = window.reasoningPrice;
  if (window.costInputPrice !== undefined) patch.costInputPrice = window.costInputPrice;
  if (window.costOutputPrice !== undefined) patch.costOutputPrice = window.costOutputPrice;
  if (window.costCacheReadPrice !== undefined) {
    patch.costCacheReadPrice = window.costCacheReadPrice;
  }
  if (window.costCacheWritePrice !== undefined) {
    patch.costCacheWritePrice = window.costCacheWritePrice;
  }
  return patch;
}

/**
 * 按时刻选出本次生效的价格（纯函数）。
 *
 * 返回值一律清空 `windows`：时段判断必须**只做一次**，在请求入口把结果
 * 烘进价格快照。否则结算时再算一次，跨过时段边界的长请求就会按另一个
 * 时段的价格结算——这是资金正确性问题，不是口径问题。
 */
export function applyWindow<T extends ModelPrice>(price: T, at: Date): T {
  const windows = price.windows ?? [];
  if (windows.length === 0) return price;
  for (const window of windows) {
    if (!windowMatches(window, at)) continue;
    return { ...price, ...overlay(price, window), windows: [] };
  }
  return { ...price, windows: [] };
}

/** 校验一条窗口；返回错误文案，合法则返回 null。 */
export function validatePriceWindow(window: PriceWindow): string | null {
  const range = parseHoursRange(window.hours);
  if (!range) return `时段格式应为 HH:MM-HH:MM，收到 ${window.hours}`;
  if (window.timezone !== undefined && window.timezone.trim() !== '') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: window.timezone.trim() });
    } catch {
      return `时区无效：${window.timezone}`;
    }
  }
  for (const day of window.weekdays ?? []) {
    if (!Number.isInteger(day) || day < 1 || day > 7) return `星期取值应为 1-7，收到 ${day}`;
  }
  const percent = window.percent ?? 0;
  if (percent < 0 || percent > 1000) return `比例应在 0-1000 之间，收到 ${percent}`;
  const money = [
    window.inputPrice,
    window.outputPrice,
    window.cacheReadPrice,
    window.cacheWritePrice,
    window.reasoningPrice,
    window.costInputPrice,
    window.costOutputPrice,
    window.costCacheReadPrice,
    window.costCacheWritePrice,
  ];
  for (const value of money) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) return `单价应为非负整数（分/百万 token）`;
  }
  if (percent === 0) {
    const hasExplicit =
      window.inputPrice !== undefined ||
      window.outputPrice !== undefined ||
      window.costInputPrice !== undefined ||
      window.costOutputPrice !== undefined;
    if (!hasExplicit) return '时段窗口需要填写比例，或至少填写输入价与输出价';
  }
  return null;
}

/** 校验一组窗口；返回第一个错误。 */
export function validatePriceWindows(windows: readonly PriceWindow[]): string | null {
  for (const window of windows) {
    const error = validatePriceWindow(window);
    if (error) return error;
  }
  return null;
}

/** 星期集合的中文摘要，用于审计日志与前端展示。 */
export function describeWeekdays(weekdays: readonly number[] | undefined): string {
  const days = (weekdays ?? []).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  if (days.length === 0 || days.length === 7) return '每天';
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((day, index) => day === index + 1)) return '工作日';
  if (sorted.length === 2 && sorted[0] === 6 && sorted[1] === 7) return '周末';
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return sorted.map((day) => names[day - 1]).join('、');
}
