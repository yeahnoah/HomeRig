'use client';
import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Cell,
} from 'recharts';

// ─── Seed payload from /api/mining/model ─────────────────────────────────────
export interface ModelSeed {
  live: { hashrate_ths: number; power_w: number; jth: number; miner_count: number };
  network: {
    network_ths: number;
    difficulty: number | null;
    subsidy_btc: number;
    source: string;
  } | null;
  btc_price_usd: number | null;
  offpeak_cents_per_kwh: number;
  currency: string;
  btc_per_day_full_runtime: number | null;
}

const DAYS_PER_MONTH = 30.4;
const C = {
  revenue: 'var(--blue)',
  profit: '#2dd4bf',
  cumProfit: '#ec4899',
  hwValue: '#eab308',
  cashFlow: 'var(--accent)',
};

// ─── Math helpers ────────────────────────────────────────────────────────────

/** Annualized IRR from a monthly cash-flow series [cf0, cf1, ...] via bisection. */
function annualizedIrr(monthlyCashflows: number[]): number | null {
  const npv = (rate: number) =>
    monthlyCashflows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i), 0);
  // Need a sign change to have a root.
  if (npv(0) <= 0) return null; // never profitable → no positive IRR
  let lo = 0;
  let hi = 5; // 500%/month upper bound
  if (npv(hi) > 0) return null; // absurdly profitable / unbounded
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = npv(mid);
    if (Math.abs(v) < 1e-6) break;
    if (v > 0) lo = mid;
    else hi = mid;
  }
  const monthly = (lo + hi) / 2;
  return Math.pow(1 + monthly, 12) - 1;
}

interface MonthRow {
  month: number;
  revenue: number;
  netProfit: number;
  cumProfit: number;
  hwValue: number;
  cashFlow: number;
  btcMined: number;
}

// ─── Projection calculator ───────────────────────────────────────────────────

export function ProjectionSection({ seed }: { seed: ModelSeed }) {
  const cur = seed.currency || '$';
  const liveKw = seed.live.power_w > 0 ? seed.live.power_w / 1000 : 7.29; // 2× S21 XP nameplate
  const liveThs = seed.live.hashrate_ths > 0 ? seed.live.hashrate_ths : 540;

  const [capex, setCapex] = useState(11938);
  const [startPrice, setStartPrice] = useState(Math.round(seed.btc_price_usd ?? 60000));
  const [priceGrowth, setPriceGrowth] = useState(20); // %/yr
  const [hashrate, setHashrate] = useState(Math.round(liveThs));
  const [powerKw, setPowerKw] = useState(Number(liveKw.toFixed(2)));
  const [rateCents, setRateCents] = useState(seed.offpeak_cents_per_kwh);
  const [uptime, setUptime] = useState(100); // %
  const [diffGrowth, setDiffGrowth] = useState(35); // %/yr — difficulty rises → fewer BTC
  const [halvingMonth, setHalvingMonth] = useState(22); // ~April 2028 from mid-2026
  const [horizon, setHorizon] = useState(36);

  // BTC/day at full runtime for the chosen hashrate, from live network share.
  const btcPerDay0 = useMemo(() => {
    if (seed.network && seed.network.network_ths > 0) {
      return (hashrate / seed.network.network_ths) * 144 * seed.network.subsidy_btc;
    }
    // Fall back to the server-seeded value scaled to the chosen hashrate.
    if (seed.btc_per_day_full_runtime && liveThs > 0) {
      return seed.btc_per_day_full_runtime * (hashrate / liveThs);
    }
    return 0;
  }, [hashrate, seed, liveThs]);

  const { rows, summary } = useMemo(() => {
    const out: MonthRow[] = [];
    const cashflows: number[] = [-capex];
    let cumProfit = 0;
    let totalBtc = 0;
    let totalRev = 0;
    let totalElec = 0;
    let payback: number | null = null;

    const up = uptime / 100;
    const elecPerMonth = powerKw * 24 * up * DAYS_PER_MONTH * (rateCents / 100);

    for (let m = 0; m < horizon; m++) {
      const subsidyFactor = m >= halvingMonth ? 0.5 : 1;
      const diffFactor = 1 / Math.pow(1 + diffGrowth / 100, m / 12);
      const btcPerDay = btcPerDay0 * up * diffFactor * subsidyFactor;
      const btcMined = btcPerDay * DAYS_PER_MONTH;
      const price = startPrice * Math.pow(1 + priceGrowth / 100, m / 12);
      const revenue = btcMined * price;
      const netProfit = revenue - elecPerMonth;

      cumProfit += netProfit;
      totalBtc += btcMined;
      totalRev += revenue;
      totalElec += elecPerMonth;
      cashflows.push(netProfit);
      if (payback == null && cumProfit >= capex) payback = m + 1;

      out.push({
        month: m + 1,
        revenue,
        netProfit,
        cumProfit,
        hwValue: capex * Math.max(0, 1 - (m + 1) / horizon),
        cashFlow: -capex + cumProfit,
        btcMined,
      });
    }

    const costOfProduction = totalBtc > 0 ? (totalElec + capex) / totalBtc : 0;
    const elecBreakEven = btcPerDay0 > 0 ? (powerKw * 24 * (rateCents / 100)) / btcPerDay0 : 0;
    const endPL = totalRev - totalElec - capex;
    const roiPct = capex > 0 ? (endPL / capex) * 100 : 0;
    const irr = annualizedIrr(cashflows);

    return {
      rows: out,
      summary: {
        totalBtc,
        costOfProduction,
        elecBreakEven,
        payback,
        endPL,
        roiPct,
        irr,
      },
    };
  }, [
    capex, startPrice, priceGrowth, rateCents, uptime, diffGrowth, halvingMonth, horizon, powerKw, btcPerDay0,
  ]);

  const usd0 = (n: number) =>
    `${cur}${Math.round(n).toLocaleString('en-US')}`;

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-5 fade-up">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-medium">Profitability projection</h3>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
            {horizon}-month model · {seed.network ? `network ${(seed.network.network_ths / 1e6).toFixed(0)} EH/s` : 'network n/a'}
          </p>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl data ${summary.endPL >= 0 ? 'text-green' : 'text-red'}`}>
            {summary.endPL >= 0 ? '+' : '−'}{usd0(Math.abs(summary.endPL))}
          </span>
          <span className="text-xs text-muted">end P/L</span>
        </div>
      </header>

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Cost of production" value={usd0(summary.costOfProduction)} sub="$/BTC all-in" />
        <Stat
          label="Electricity break-even"
          value={usd0(summary.elecBreakEven)}
          sub="$/BTC energy only"
          accent={seed.btc_price_usd != null && seed.btc_price_usd < summary.elecBreakEven ? 'red' : 'green'}
        />
        <Stat
          label="CAPEX payback"
          value={summary.payback ? `${summary.payback} mo` : `>${horizon} mo`}
          sub="months to recoup"
        />
        <Stat label="Total BTC mined" value={summary.totalBtc.toFixed(4)} sub={`over ${horizon} mo`} />
        <Stat
          label="ROI"
          value={`${summary.roiPct >= 0 ? '+' : ''}${summary.roiPct.toFixed(0)}%`}
          sub="on CAPEX"
          accent={summary.roiPct >= 0 ? 'green' : 'red'}
        />
        <Stat
          label="IRR"
          value={summary.irr == null ? '—' : `${(summary.irr * 100).toFixed(0)}%`}
          sub="annualized"
          accent="amber"
        />
      </div>

      {/* ── Chart ── */}
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              interval={Math.max(0, Math.floor(horizon / 12) - 1)}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${cur}${Math.round(v / 1000)}k`}
              width={42}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${cur}${Math.round(v / 1000)}k`}
              width={42}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v, name) => [usd0(Number(v)), String(name)]}
              labelFormatter={(l) => `Month ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="left" dataKey="revenue" name="Revenue / mo" fill={C.revenue} opacity={0.85} />
            <Bar yAxisId="left" dataKey="netProfit" name="Net profit / mo" fill={C.profit} opacity={0.85} />
            <Line yAxisId="right" type="monotone" dataKey="cumProfit" name="Cumulative profit" stroke={C.cumProfit} dot={false} strokeWidth={2} />
            <Line yAxisId="right" type="monotone" dataKey="cashFlow" name="Cash flow (incl. CAPEX)" stroke={C.cashFlow} dot={false} strokeWidth={2} />
            <Line yAxisId="right" type="monotone" dataKey="hwValue" name="Hardware value" stroke={C.hwValue} dot={false} strokeWidth={1.5} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Assumptions ── */}
      <div className="space-y-2 pt-1">
        <div className="text-[10px] uppercase tracking-wider text-muted">Assumptions (editable)</div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <NumIn label={`Hardware cost (${cur})`} value={capex} onChange={setCapex} />
          <NumIn label={`BTC start price (${cur})`} value={startPrice} onChange={setStartPrice} />
          <NumIn label="BTC growth (%/yr)" value={priceGrowth} onChange={setPriceGrowth} step={1} />
          <NumIn label="Difficulty growth (%/yr)" value={diffGrowth} onChange={setDiffGrowth} step={1} />
          <NumIn label="Uptime (%)" value={uptime} onChange={setUptime} step={1} />
          <NumIn label="Hashrate (TH/s)" value={hashrate} onChange={setHashrate} step={10} />
          <NumIn label="Power (kW)" value={powerKw} onChange={setPowerKw} step={0.1} />
          <NumIn label="Rate (¢/kWh)" value={rateCents} onChange={setRateCents} step={0.1} />
          <NumIn label="Halving at month" value={halvingMonth} onChange={setHalvingMonth} step={1} />
          <NumIn label="Horizon (months)" value={horizon} onChange={(v) => setHorizon(Math.max(1, Math.min(120, v)))} step={6} />
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Seeded from live data: {seed.live.hashrate_ths > 0 ? `${seed.live.hashrate_ths.toFixed(0)} TH/s @ ${(seed.live.power_w / 1000).toFixed(2)} kW` : 'rig nameplate'}, off-peak {seed.offpeak_cents_per_kwh}¢/kWh, BTC {usd0(seed.btc_price_usd ?? 0)}. BTC mined/day is derived from your hashrate's share of the live network and decays with the difficulty-growth assumption; a halving (subsidy ÷2) is applied at the chosen month.
        </p>
      </div>
    </section>
  );
}

// ─── Efficiency benchmark chart ──────────────────────────────────────────────

const BENCHMARKS: { name: string; jth: number }[] = [
  { name: 'S21 XP (spec)', jth: 13.5 },
  { name: 'S21 Pro', jth: 15.0 },
  { name: 'S21', jth: 17.5 },
  { name: 'S19 XP', jth: 21.5 },
  { name: 'S19 Pro', jth: 29.5 },
];

export function EfficiencySection({ seed }: { seed: ModelSeed }) {
  const live = seed.live.jth;
  const data = useMemo(() => {
    const rows = [...BENCHMARKS];
    const arr = rows.map((b) => ({ ...b, you: false }));
    if (live > 0) arr.push({ name: 'Your rig (live)', jth: Number(live.toFixed(1)), you: true });
    // Lower J/TH = more efficient → sort ascending so the best sits on top.
    return arr.sort((a, b) => a.jth - b.jth);
  }, [live]);

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3 fade-up">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-medium">Mining efficiency · J/TH</h3>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
            lower is better · vs Antminer benchmarks
          </p>
        </div>
        {live > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="text-2xl data text-accent">{live.toFixed(1)}</span>
            <span className="text-xs text-muted">J/TH live</span>
          </div>
        )}
      </header>

      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: 'var(--muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}`}
              domain={[0, 'dataMax + 3']}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: 'var(--foreground)' }}
              axisLine={false}
              tickLine={false}
              width={110}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v) => [`${Number(v)} J/TH`, 'Efficiency']}
            />
            <Bar dataKey="jth" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 10, fill: 'var(--muted)', formatter: (v) => `${v}` }}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.you ? 'var(--accent)' : 'var(--surface-2)'} stroke={d.you ? 'var(--accent)' : 'var(--border)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted">
        {live > 0
          ? `Your live efficiency is ${live.toFixed(1)} J/TH${live <= 14 ? ' — at or better than S21 XP spec.' : '.'} Higher-than-spec usually means higher ambient temp, a dialed-up power profile, or aging hashboards.`
          : 'Waiting for live running samples to measure efficiency — your miners are currently paused.'}
      </p>
    </section>
  );
}

// ─── Small UI helpers ────────────────────────────────────────────────────────

function Stat({
  label, value, sub, accent = 'plain',
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'red' | 'amber' | 'green' | 'plain';
}) {
  const cls =
    accent === 'red' ? 'text-red' :
    accent === 'amber' ? 'text-accent' :
    accent === 'green' ? 'text-green' :
    'text-foreground';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted">{label}</div>
      <div className={`text-lg data ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function NumIn({
  label, value, onChange, step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
        className="mt-1 w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm data"
      />
    </label>
  );
}
