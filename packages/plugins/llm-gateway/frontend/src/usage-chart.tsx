'use client';

import type { ReactElement } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface UsageChartPoint {
  label: string;
  value: number;
}

export function UsageChart({
  data,
  formatValue,
  metric,
}: {
  data: UsageChartPoint[];
  formatValue: (value: number) => string;
  metric: 'cost' | 'tokens';
}): ReactElement {
  const maxValue = Math.max(0, ...data.map((point) => point.value));
  const allZero = maxValue === 0;
  const padding =
    metric === 'cost' ? Math.max(0.01, maxValue * 0.18) : Math.max(1, maxValue * 0.18);
  const domain: [number, number] = allZero ? [0, 1] : [0, maxValue + padding];
  return (
    <div className="h-32 w-full min-w-0 sm:h-36">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border) / .65)" strokeDasharray="3 4" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            minTickGap={32}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            width={metric === 'cost' ? 58 : 66}
            domain={domain}
            tickCount={4}
            tickFormatter={formatValue}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
          />
          {allZero ? (
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / .7)" strokeDasharray="4 4" />
          ) : null}
          <Tooltip
            cursor={{ stroke: 'hsl(var(--border))', strokeDasharray: '4 4' }}
            formatter={(value) => [formatValue(Number(value)), '用量']}
            contentStyle={{
              borderRadius: 10,
              border: '1px solid hsl(var(--border))',
              background: 'hsl(var(--card))',
              color: 'hsl(var(--card-foreground))',
              boxShadow: '0 8px 24px hsl(var(--foreground) / .08)',
            }}
          />
          <Line
            type="linear"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={2.5}
            dot={data.length <= 7 ? { r: 3, fill: 'hsl(var(--primary))' } : false}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
