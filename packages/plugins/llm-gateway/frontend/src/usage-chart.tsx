'use client';

import type { ReactElement } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
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
}: {
  data: UsageChartPoint[];
  formatValue: (value: number) => string;
}): ReactElement {
  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border) / .55)" strokeDasharray="3 4" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={10} minTickGap={24} />
          <YAxis axisLine={false} tickLine={false} tickMargin={8} width={56} tickFormatter={formatValue} />
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
          <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
