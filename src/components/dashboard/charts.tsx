'use client';
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceArea,
} from 'recharts';

export interface ChartPoint {
  ts: number; // ms epoch — recharts needs numeric for proper scaling
  hashrate_th?: number;
  power_w?: number | null;
  max_chip_temp?: number | null;
  /** Optional: which miner produced this point (used for multi-series). */
  series?: string;
  [key: string]: unknown;
}

interface BaseProps {
  data: ChartPoint[];
  /** Highlight regions (e.g. blackout windows) on the chart. */
  highlights?: { start: number; end: number; label?: string }[];
  height?: number;
}

const SERIES_COLORS = ['var(--accent)', 'var(--blue)', 'var(--green)'];

// Compact time formatter for X axis: "HH:MM"
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

interface SharedTooltipProps {
  active?: boolean;
  payload?: readonly { dataKey?: string | number; name?: string | number; value?: number; color?: string }[];
  label?: number | string;
  valueFormatter?: (v: number) => string;
  unit?: string;
}

function SharedTooltip({ active, payload, label, valueFormatter, unit }: SharedTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const labelMs = typeof label === 'number' ? label : undefined;
  return (
    <div className="bg-surface border border-border-strong rounded px-3 py-2 text-xs shadow-xl">
      <div className="text-muted data mb-1">{labelMs !== undefined ? fmtTime(labelMs) : ''}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{String(p.name ?? p.dataKey ?? '')}</span>
          <span className="data text-foreground ml-auto">
            {valueFormatter ? valueFormatter(p.value ?? 0) : (p.value ?? 0)}
            {unit ? ` ${unit}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Multi-series hashrate over time. `data` should be flattened: one row per
 * timestamp with a key like `miner_1`, `miner_2`, etc. for each miner.
 */
export function HashrateChart({
  data,
  minerKeys,
  highlights,
  height = 220,
}: BaseProps & { minerKeys: { key: string; name: string }[] }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 6" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={fmtTime}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={36}
          tickFormatter={(v) => `${v}`}
        />
        {highlights?.map((h, i) => (
          <ReferenceArea
            key={i}
            x1={h.start}
            x2={h.end}
            fill="var(--accent)"
            fillOpacity={0.06}
            ifOverflow="extendDomain"
          />
        ))}
        <Tooltip
          content={(p: unknown) => (
            <SharedTooltip
              {...(p as SharedTooltipProps)}
              unit="TH/s"
              valueFormatter={(v) => v.toFixed(1)}
            />
          )}
        />
        {minerKeys.map((m, i) => (
          <Line
            key={m.key}
            type="monotone"
            dataKey={m.key}
            name={m.name}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Power (total across miners) with cost overlay. Stacked area. */
export function PowerCostChart({
  data,
  highlights,
  height = 220,
}: BaseProps & { data: { ts: number; power_w: number; cost_per_hour: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id="powerGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={fmtTime}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={44}
          tickFormatter={(v) => `${v}W`}
        />
        {highlights?.map((h, i) => (
          <ReferenceArea
            key={i}
            x1={h.start}
            x2={h.end}
            fill="var(--red)"
            fillOpacity={0.04}
            ifOverflow="extendDomain"
          />
        ))}
        <Tooltip
          content={(p) => {
            const point = p.payload?.[0]?.payload as
              | { ts?: number; power_w?: number; cost_per_hour?: number }
              | undefined;
            if (!p.active || !point) return null;
            return (
              <div className="bg-surface border border-border-strong rounded px-3 py-2 text-xs shadow-xl">
                <div className="text-muted data mb-1">{point.ts ? fmtTime(point.ts) : ''}</div>
                <div className="flex items-center gap-3 data">
                  <span className="text-accent">{point.power_w ?? 0} W</span>
                  <span className="text-green">${(point.cost_per_hour ?? 0).toFixed(2)}/hr</span>
                </div>
              </div>
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="power_w"
          stroke="var(--accent)"
          strokeWidth={1.5}
          fill="url(#powerGradient)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Compact line sparkline. Used inside per-miner cards. */
export function Sparkline({
  data,
  dataKey,
  color = 'var(--accent)',
  height = 36,
}: {
  data: { ts: number; [key: string]: number | undefined }[];
  dataKey: string;
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.25}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
