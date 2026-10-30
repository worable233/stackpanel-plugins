import { describe, expect, it } from 'vitest';
import {
  applyWindow,
  describeWeekdays,
  formatClock,
  parseClock,
  parseHoursRange,
  validatePriceWindow,
  validatePriceWindows,
  windowMatches,
  zonedClock,
  type PriceWindow,
} from './pricing-window.js';
import type { ModelPrice } from './pricing.js';

/** 2026-10-29 是周四。用它当基准，避免测试随运行日期漂移。 */
function at(iso: string): Date {
  return new Date(iso);
}

const BASE: ModelPrice = {
  inputPrice: 1000,
  outputPrice: 2000,
  multiplier: 100,
  cacheReadPrice: 100,
  cacheWritePrice: 200,
  costInputPrice: 600,
  costOutputPrice: 1200,
};

describe('parseClock', () => {
  it('解析正常时刻', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('23:59')).toBe(1439);
  });

  it('接受 24:00 并归一为一天结束', () => {
    expect(parseClock('24:00')).toBe(1440);
  });

  it('拒绝非法值', () => {
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('1200')).toBeNull();
    expect(parseClock('')).toBeNull();
  });
});

describe('formatClock', () => {
  it('往返一致', () => {
    for (const value of ['00:00', '07:05', '23:59']) {
      const minutes = parseClock(value);
      expect(minutes).not.toBeNull();
      expect(formatClock(minutes as number)).toBe(value);
    }
  });
});

describe('parseHoursRange', () => {
  it('解析普通区间', () => {
    expect(parseHoursRange('09:00-18:00')).toEqual({ start: 540, end: 1080 });
  });

  it('跨午夜区间 end < start', () => {
    expect(parseHoursRange('22:00-02:00')).toEqual({ start: 1320, end: 120 });
  });

  it('拒绝格式错误', () => {
    expect(parseHoursRange('09:00')).toBeNull();
    expect(parseHoursRange('09:00-')).toBeNull();
    expect(parseHoursRange('a-b')).toBeNull();
  });
});

describe('zonedClock', () => {
  it('按指定时区换算星期与分钟', () => {
    // 2026-10-29T00:30:00Z = 上海 08:30（周四）
    const clock = zonedClock(at('2026-10-29T00:30:00Z'), 'Asia/Shanghai');
    expect(clock).toEqual({ weekday: 4, minutes: 510 });
  });

  it('空时区按 UTC 处理', () => {
    const clock = zonedClock(at('2026-10-29T00:30:00Z'), '');
    expect(clock).toEqual({ weekday: 4, minutes: 30 });
  });

  it('非法时区返回 null（不猜测）', () => {
    expect(zonedClock(at('2026-10-29T00:30:00Z'), 'Mars/Olympus')).toBeNull();
  });

  it('跨时区时星期可能不同', () => {
    // UTC 周五 23:00 = 上海 周六 07:00
    const clock = zonedClock(at('2026-10-30T23:00:00Z'), 'Asia/Shanghai');
    expect(clock).toEqual({ weekday: 6, minutes: 420 });
  });
});

describe('windowMatches', () => {
  const daytime: PriceWindow = { hours: '09:00-18:00', timezone: 'Asia/Shanghai' };

  it('区间内命中、区间外不命中', () => {
    expect(windowMatches(daytime, at('2026-10-29T02:00:00Z'))).toBe(true); // 上海 10:00
    expect(windowMatches(daytime, at('2026-10-29T00:00:00Z'))).toBe(false); // 上海 08:00
    expect(windowMatches(daytime, at('2026-10-29T10:00:00Z'))).toBe(false); // 上海 18:00
  });

  it('左闭右开：起点命中，终点不命中', () => {
    expect(windowMatches(daytime, at('2026-10-29T01:00:00Z'))).toBe(true); // 上海 09:00 起点命中
    expect(windowMatches(daytime, at('2026-10-29T09:59:00Z'))).toBe(true); // 上海 17:59 仍在区间内
    expect(windowMatches(daytime, at('2026-10-29T10:00:00Z'))).toBe(false); // 上海 18:00 终点不命中
  });

  it('星期过滤生效', () => {
    const weekdaysOnly: PriceWindow = { ...daytime, weekdays: [1, 2, 3, 4, 5] };
    expect(windowMatches(weekdaysOnly, at('2026-10-29T02:00:00Z'))).toBe(true); // 周四
    expect(windowMatches(weekdaysOnly, at('2026-10-31T02:00:00Z'))).toBe(false); // 周六
  });

  it('跨午夜窗口覆盖次日凌晨', () => {
    const overnight: PriceWindow = { hours: '22:00-02:00', timezone: 'Asia/Shanghai' };
    expect(windowMatches(overnight, at('2026-10-29T15:00:00Z'))).toBe(true); // 上海 23:00
    expect(windowMatches(overnight, at('2026-10-29T17:00:00Z'))).toBe(true); // 上海次日 01:00
    expect(windowMatches(overnight, at('2026-10-29T10:00:00Z'))).toBe(false); // 上海 18:00
  });

  it('跨午夜窗口的星期归属起点那一天', () => {
    // 周五 22:00 - 周六 02:00：weekdays=[5]
    const fridayNight: PriceWindow = {
      hours: '22:00-02:00',
      timezone: 'Asia/Shanghai',
      weekdays: [5],
    };
    expect(windowMatches(fridayNight, at('2026-10-30T15:00:00Z'))).toBe(true); // 周五 23:00
    expect(windowMatches(fridayNight, at('2026-10-30T17:00:00Z'))).toBe(true); // 周六 01:00（归周五）
    expect(windowMatches(fridayNight, at('2026-10-31T15:00:00Z'))).toBe(false); // 周六 23:00
    expect(windowMatches(fridayNight, at('2026-10-31T17:00:00Z'))).toBe(false); // 周日 01:00（归周六）
  });

  it('24:00 结尾表示到当天结束', () => {
    const tillMidnight: PriceWindow = { hours: '20:00-24:00', timezone: 'Asia/Shanghai' };
    expect(windowMatches(tillMidnight, at('2026-10-29T15:59:00Z'))).toBe(true); // 23:59
    expect(windowMatches(tillMidnight, at('2026-10-29T16:00:00Z'))).toBe(false); // 次日 00:00
  });

  it('空 weekdays 表示每天', () => {
    const everyDay: PriceWindow = { hours: '00:00-24:00', timezone: 'UTC' };
    expect(windowMatches(everyDay, at('2026-10-29T02:00:00Z'))).toBe(true);
    expect(windowMatches(everyDay, at('2026-11-01T02:00:00Z'))).toBe(true);
  });
});

describe('applyWindow', () => {
  it('没有窗口时原样返回', () => {
    const price = { ...BASE };
    expect(applyWindow(price, at('2026-10-29T02:00:00Z'))).toEqual(price);
  });

  it('percent 模式同时缩放售价与成本', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [{ hours: '00:00-24:00', timezone: 'UTC', percent: 50 }],
    };
    const result = applyWindow(price, at('2026-10-29T02:00:00Z'));
    expect(result.inputPrice).toBe(500);
    expect(result.outputPrice).toBe(1000);
    expect(result.cacheReadPrice).toBe(50);
    expect(result.cacheWritePrice).toBe(100);
    expect(result.costInputPrice).toBe(300);
    expect(result.costOutputPrice).toBe(600);
  });

  it('未命中窗口时保持基础价', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [{ hours: '00:00-08:00', timezone: 'UTC', percent: 50 }],
    };
    const result = applyWindow(price, at('2026-10-29T12:00:00Z'));
    expect(result.inputPrice).toBe(1000);
  });

  it('显式单价模式只覆盖填了的字段', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [{ hours: '00:00-24:00', timezone: 'UTC', inputPrice: 300 }],
    };
    const result = applyWindow(price, at('2026-10-29T02:00:00Z'));
    expect(result.inputPrice).toBe(300);
    expect(result.outputPrice).toBe(2000); // 继承
  });

  it('多个窗口取第一个命中', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [
        { hours: '00:00-12:00', timezone: 'UTC', percent: 50 },
        { hours: '00:00-24:00', timezone: 'UTC', percent: 10 },
      ],
    };
    expect(applyWindow(price, at('2026-10-29T02:00:00Z')).inputPrice).toBe(500);
    expect(applyWindow(price, at('2026-10-29T20:00:00Z')).inputPrice).toBe(100);
  });

  it('结果清空 windows：时段只判断一次', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [{ hours: '00:00-24:00', timezone: 'UTC', percent: 50 }],
    };
    const result = applyWindow(price, at('2026-10-29T02:00:00Z'));
    expect(result.windows).toEqual([]);
    // 再算一次不会二次打折
    expect(applyWindow(result, at('2026-10-29T02:00:00Z')).inputPrice).toBe(500);
  });

  it('保留 ModelPrice 之外的字段（如 upstreamModel）', () => {
    const price = {
      ...BASE,
      publicModel: 'glm-5.2',
      upstreamModel: 'glm-5.2-upstream',
      windows: [{ hours: '00:00-24:00', timezone: 'UTC', percent: 50 }],
    };
    const result = applyWindow(price, at('2026-10-29T02:00:00Z'));
    expect(result.upstreamModel).toBe('glm-5.2-upstream');
    expect(result.publicModel).toBe('glm-5.2');
  });

  it('非法时区的窗口不命中（宁可少打折，不乱收钱）', () => {
    const price: ModelPrice = {
      ...BASE,
      windows: [{ hours: '00:00-24:00', timezone: 'Bad/Zone', percent: 50 }],
    };
    expect(applyWindow(price, at('2026-10-29T02:00:00Z')).inputPrice).toBe(1000);
  });
});

describe('validatePriceWindow', () => {
  it('合法窗口通过', () => {
    expect(validatePriceWindow({ hours: '22:00-02:00', percent: 50 })).toBeNull();
    expect(
      validatePriceWindow({ hours: '09:00-18:00', inputPrice: 100, outputPrice: 200 }),
    ).toBeNull();
  });

  it('时段格式错误被拒', () => {
    expect(validatePriceWindow({ hours: '9点到18点', percent: 50 })).toContain('HH:MM');
  });

  it('时区无效被拒', () => {
    expect(
      validatePriceWindow({ hours: '09:00-18:00', timezone: 'Mars/Base', percent: 50 }),
    ).toContain('时区无效');
  });

  it('星期越界被拒', () => {
    expect(validatePriceWindow({ hours: '09:00-18:00', weekdays: [0], percent: 50 })).toContain(
      '星期',
    );
    expect(validatePriceWindow({ hours: '09:00-18:00', weekdays: [8], percent: 50 })).toContain(
      '星期',
    );
  });

  it('比例越界被拒', () => {
    expect(validatePriceWindow({ hours: '09:00-18:00', percent: 1001 })).toContain('比例');
  });

  it('既无比例也无单价被拒', () => {
    expect(validatePriceWindow({ hours: '09:00-18:00' })).toContain('比例');
  });

  it('负单价被拒', () => {
    expect(validatePriceWindow({ hours: '09:00-18:00', inputPrice: -1 })).toContain('非负整数');
  });
});

describe('validatePriceWindows', () => {
  it('空数组通过', () => {
    expect(validatePriceWindows([])).toBeNull();
  });

  it('返回第一个错误', () => {
    const error = validatePriceWindows([
      { hours: '00:00-24:00', percent: 50 },
      { hours: 'bad', percent: 50 },
    ]);
    expect(error).toContain('HH:MM');
  });
});

describe('describeWeekdays', () => {
  it('空/全周显示每天', () => {
    expect(describeWeekdays([])).toBe('每天');
    expect(describeWeekdays(undefined)).toBe('每天');
    expect(describeWeekdays([1, 2, 3, 4, 5, 6, 7])).toBe('每天');
  });

  it('识别工作日与周末', () => {
    expect(describeWeekdays([1, 2, 3, 4, 5])).toBe('工作日');
    expect(describeWeekdays([6, 7])).toBe('周末');
  });

  it('其他组合列名字', () => {
    expect(describeWeekdays([3, 1])).toBe('周一、周三');
  });
});
