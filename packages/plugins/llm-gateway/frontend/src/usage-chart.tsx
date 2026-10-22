'use client';

import type { ReactElement } from 'react';

export interface UsageChartPoint {
  label: string;
  value: number;
}

export function UsageChart({
  data,
  formatValue,
  ariaLabel,
}: {
  data: UsageChartPoint[];
  formatValue: (value: number) => string;
  /** Localized accessible name for the chart (package catalog). */
  ariaLabel: string;
}): ReactElement {
  const maxValue = Math.max(0, ...data.map((point) => point.value));
  const max = maxValue || 1;
  const width = 720;
  const height = 128;
  const left = 58;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const points = data.map((point, index) => ({
    ...point,
    x: left + (data.length <= 1 ? chartWidth / 2 : (index / (data.length - 1)) * chartWidth),
    y: top + chartHeight - (point.value / max) * chartHeight,
  }));
  const visibleLabels = points.filter(
    (_, index) =>
      data.length <= 8 || index % Math.ceil(data.length / 8) === 0 || index === data.length - 1,
  );
  return (
    <div className="w-full min-w-0 overflow-hidden" style={{ height: 'clamp(112px, 22vw, 144px)' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-full w-full"
        role="img"
        aria-label={ariaLabel}
      >
        {[0, 0.5, 1].map((ratio) => {
          const y = top + chartHeight * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={left}
                x2={width - right}
                y1={y}
                y2={y}
                stroke="hsl(var(--border) / .65)"
                strokeDasharray="3 4"
              />
              <text
                x={left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize="11"
                fill="hsl(var(--muted-foreground))"
              >
                {formatValue(maxValue * ratio)}
              </text>
            </g>
          );
        })}
        {points.length ? (
          <polyline
            points={points.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {visibleLabels.map((point) => (
          <text
            key={`${point.label}-${point.x}`}
            x={point.x}
            y={height - 4}
            textAnchor="middle"
            fontSize="11"
            fill="hsl(var(--muted-foreground))"
          >
            {point.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
