'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StatusLed } from '@/components/status-led';
import { HeroStat } from '@/components/dashboard/hero-stat';
import { HashrateChart, PowerCostChart, Sparkline, type ChartPoint } from '@/components/dashboard/charts';
import { CostPopover } from '@/components/dashboard/cost-popover';
import { BoardStrip } from '@/components/dashboard/board-strip';
import { ProjectionSection, EfficiencySection, type ModelSeed } from '@/components/dashboard/projection';
import { ThermalSection } from '@/components/dashboard/thermal';
import type { MinerStats } from '@/types';

interface MinerRow {
  id: number;
  name: string;
  ip: string;
  enabled: boolean;
  stats: MinerStats | null;
}

interface HistoryPoint {
  ts: string;
  hashrate_th: number;
  power_w: number | null;
  max_chip_temp: number | null;
  status: string;
}

interface HistorySeries {
  miner_id: number;
  name: string;
  points: HistoryPoint[];
}

interface ElectricityCfg {
  currency: string;
  rate_offpeak_cents: number;
  rate_peak_cents: number;
  use_blackout_as_peak: boolean;
  service_charge_cents_per_day: number;
  demand_charge_dollars_per_kw: number;
}

interface SpendSummary {
  miner_cost: number;
  plug_cost: number;
  total_cost: number;
  miner_kwh: number;
  plug_kwh: number;
  currency: string;
  window_minutes: number;
}

interface MonthlySummary {
  month: string;
  days_elapsed: number;
  days_in_month: number;
  peak_kw: number;
  peak_at: string | null;
  service_charge_so_far: number;
  demand_charge_so_far: number;
  energy_cost_so_far: number;
  total_so_far: number;
  projected_total: number;
  currency: string;
}

interface ElectricityState {
  config: ElectricityCfg;
  current_period: 'peak' | 'offpeak';
  current_rate_cents_per_kwh: number;
  spend?: SpendSummary;
  monthly?: MonthlySummary;
  plug?: { power_w: number | null; energy_kwh: number | null; ts: string } | null;
}

interface ProfitState {
  config: { enabled: boolean; has_token: boolean };
  snapshot: {
    enabled: boolean;
    btc_price_usd: number | null;
    btc_per_day: number | null;
    btc_per_day_method: string | null;
    running_watts: number;
    rate_period: 'peak' | 'offpeak';
    rate_cents_per_kwh: number;
    daily_energy_cost_usd: number;
    break_even_usd: number | null;
    threshold_usd: number | null;
    manual_floor_active: boolean;
    revenue_per_day_usd: number | null;
    profit_per_day_usd: number | null;
    unprofitable: boolean;
    reason: string;
  };
  guard: { tripped: boolean; below_for_seconds: number | null };
}

const WINDOW_OPTIONS = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
];

export default function Dashboard() {
  const [miners, setMiners] = useState<MinerRow[]>([]);
  const [history, setHistory] = useState<HistorySeries[]>([]);
  const [electricity, setElectricity] = useState<ElectricityState | null>(null);
  const [profit, setProfit] = useState<ProfitState | null>(null);
  const [model, setModel] = useState<ModelSeed | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [m, h, e, p, mo] = await Promise.all([
        fetch('/api/miners').then((r) => r.json()),
        fetch(`/api/miners/history?minutes=${windowMinutes}`).then((r) => r.json()),
        fetch('/api/electricity').then((r) => r.json()),
        fetch('/api/profitability').then((r) => r.json()),
        fetch('/api/mining/model').then((r) => r.json()),
      ]);
      setMiners(m.miners ?? []);
      setHistory(h.series ?? []);
      setElectricity(e ?? null);
      setProfit(p ?? null);
      setModel(mo ?? null);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [windowMinutes]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 10000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const pollNow = useCallback(async () => {
    setRefreshing(true);
    await fetch('/api/miners/poll', { method: 'POST' }).catch(() => {});
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  // ── Derived totals ──
  const totalHashrate = miners.reduce((acc, m) => acc + (m.stats?.hashrate_th ?? 0), 0);
  const totalPower = miners.reduce((acc, m) => acc + (m.stats?.power_w ?? 0), 0);
  const minersMining = miners.filter((m) => m.stats?.status === 'mining').length;
  const minersTotal = miners.filter((m) => m.enabled).length;
  const totalEfficiency = totalHashrate > 0 ? totalPower / totalHashrate : 0;

  const ratePerKwh = electricity ? electricity.current_rate_cents_per_kwh / 100 : 0;
  const costPerHour = (totalPower / 1000) * ratePerKwh;
  const costPerDay = costPerHour * 24;
  const costPerMonth = costPerDay * 30;
  const currency = electricity?.config.currency ?? '$';

  // ── Chart data ──
  const minerKeys = useMemo(
    () => history.map((s) => ({ key: `miner_${s.miner_id}`, name: s.name })),
    [history]
  );

  const hashrateChartData = useMemo<ChartPoint[]>(() => {
    // Pivot: { ts → { miner_1: hr, miner_2: hr } }
    const byTs = new Map<number, ChartPoint>();
    for (const s of history) {
      for (const p of s.points) {
        const ms = new Date(p.ts.replace(' ', 'T') + 'Z').getTime();
        const row = byTs.get(ms) ?? ({ ts: ms } as ChartPoint);
        (row as Record<string, unknown>)[`miner_${s.miner_id}`] = p.hashrate_th;
        byTs.set(ms, row);
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }, [history]);

  const powerChartData = useMemo(() => {
    // Sum power across miners per timestamp.
    const byTs = new Map<number, number>();
    for (const s of history) {
      for (const p of s.points) {
        const ms = new Date(p.ts.replace(' ', 'T') + 'Z').getTime();
        const cur = byTs.get(ms) ?? 0;
        byTs.set(ms, cur + (p.power_w ?? 0));
      }
    }
    return Array.from(byTs.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, power_w]) => ({
        ts,
        power_w,
        cost_per_hour: (power_w / 1000) * ratePerKwh,
      }));
  }, [history, ratePerKwh]);

  return (
    <div className="space-y-8">
      {/* ── Top bar ── */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted">
            Live status —{' '}
            <span className="data text-foreground">
              {minersMining}/{minersTotal}
            </span>{' '}
            miners mining
          </p>
        </div>
        <div className="flex items-center gap-4">
          <WindowSelector value={windowMinutes} onChange={setWindowMinutes} />
          <button
            onClick={pollNow}
            disabled={refreshing}
            className="text-[10px] uppercase tracking-[0.18em] text-accent hover:text-foreground transition-colors disabled:opacity-50"
          >
            {refreshing ? 'polling…' : 'refresh now'}
          </button>
        </div>
      </header>

      {err && <div className="text-red text-sm">{err}</div>}

      {/* ── Hero stats row ── */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden border border-border">
        <div className="bg-surface px-5 py-5 fade-up">
          <HeroStat
            label="Total Hashrate"
            value={totalHashrate.toFixed(1)}
            unit="TH/s"
            accent="amber"
            sublabel={
              <span className="pulse-soft">
                <span className="led led--green inline-block mr-1.5 align-middle" />
                {minersMining > 0 ? 'live' : 'idle'}
              </span>
            }
          />
        </div>
        <div className="bg-surface px-5 py-5 fade-up" style={{ animationDelay: '50ms' }}>
          <HeroStat
            label="Power Draw"
            value={totalPower}
            unit="W"
            accent="plain"
            sublabel={
              totalEfficiency > 0
                ? `${totalEfficiency.toFixed(1)} J/TH · ${(totalPower / 1000).toFixed(2)} kW`
                : '—'
            }
          />
        </div>
        <div className="bg-surface px-5 py-5 fade-up" style={{ animationDelay: '100ms' }}>
          <HeroStat
            label={electricity?.current_period === 'peak' ? 'Cost / hr (peak)' : 'Cost / hr (off-peak)'}
            value={costPerHour.toFixed(2)}
            unit={`${currency}/hr`}
            accent={electricity?.current_period === 'peak' ? 'red' : 'green'}
            sublabel={
              electricity ? (
                <span>
                  @ <span className="data">{electricity.current_rate_cents_per_kwh.toFixed(1)}¢/kWh</span>
                </span>
              ) : null
            }
          />
        </div>
        <div className="bg-surface px-5 py-5 fade-up relative" style={{ animationDelay: '150ms' }}>
          <div className="absolute top-3 right-4">
            {electricity && (
              <CostPopover
                cfg={electricity.config}
                onSaved={(next) => setElectricity({ ...electricity, config: next })}
              />
            )}
          </div>
          {electricity?.spend && (electricity.spend.miner_kwh > 0 || electricity.spend.plug_kwh > 0) ? (
            // Meter-backed real spend from the last 24h (miners integrated +
            // plug kWh delta). More accurate than instantaneous watts × time.
            <HeroStat
              label="Last 24h spend"
              value={electricity.spend.total_cost.toFixed(2)}
              unit={`${currency}`}
              accent="plain"
              sublabel={
                <span className="text-xs text-muted">
                  miners <span className="data text-foreground">{currency}{electricity.spend.miner_cost.toFixed(2)}</span>
                  {' · '}
                  fans <span className="data text-foreground">{currency}{electricity.spend.plug_cost.toFixed(2)}</span>
                  {' · '}
                  <span className="data">{(electricity.spend.miner_kwh + electricity.spend.plug_kwh).toFixed(1)} kWh</span>
                </span>
              }
            />
          ) : (
            <HeroStat
              label="Projected"
              value={costPerDay.toFixed(2)}
              unit={`${currency}/day`}
              accent="plain"
              sublabel={`~${currency}${costPerMonth.toFixed(0)}/mo at current load`}
            />
          )}
        </div>
      </section>

      {/* ── Monthly bill projection ── */}
      {electricity?.monthly && (
        <MonthlyBillCard monthly={electricity.monthly} demandRate={electricity.config.demand_charge_dollars_per_kw} />
      )}

      {/* ── Profitability guard ── */}
      {profit?.snapshot.enabled && <ProfitabilityCard profit={profit} />}

      {/* ── Hashboard thermals + watchdog ── */}
      <ThermalSection miners={miners} />

      {/* ── Live efficiency (J/TH) ── */}
      {model && <EfficiencySection seed={model} />}

      {/* ── Profitability projection calculator ── */}
      {model && <ProjectionSection seed={model} />}

      {/* ── Charts row ── */}
      <section className="grid lg:grid-cols-3 gap-4">
        <ChartCard
          className="lg:col-span-2"
          title="Hashrate"
          subtitle={`per miner · last ${formatWindowLabel(windowMinutes)}`}
          legend={minerKeys.map((m, i) => ({
            label: m.name,
            color: ['var(--accent)', 'var(--blue)', 'var(--green)'][i % 3],
          }))}
        >
          {hashrateChartData.length >= 2 ? (
            <HashrateChart data={hashrateChartData} minerKeys={minerKeys} />
          ) : (
            <EmptyState
              text={`Collecting data… check back in ~${Math.max(1, Math.round(windowMinutes / 30))} min`}
            />
          )}
        </ChartCard>
        <ChartCard
          title="Power & cost"
          subtitle={`total draw · ${currency}/hr overlay`}
        >
          {powerChartData.length >= 2 ? (
            <PowerCostChart data={powerChartData} />
          ) : (
            <EmptyState text="Collecting data…" />
          )}
        </ChartCard>
      </section>

      {/* ── Per-device cost row: miners + plug ── */}
      <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {miners.map((m, i) => (
          <MinerCard
            key={m.id}
            miner={m}
            sparkData={hashrateChartData.map((p) => ({
              ts: p.ts,
              v: (p as Record<string, unknown>)[`miner_${m.id}`] as number | undefined,
            }))}
            delay={i * 50}
            onAction={pollNow}
            ratePerKwh={ratePerKwh}
            currency={currency}
            currentPeriod={electricity?.current_period}
          />
        ))}
        {electricity?.plug && (
          <PlugCard
            powerW={electricity.plug.power_w}
            energyKwh={electricity.plug.energy_kwh}
            ratePerKwh={ratePerKwh}
            currency={currency}
            currentPeriod={electricity.current_period}
            delay={miners.length * 50}
          />
        )}
        {miners.length === 0 && (
          <div className="md:col-span-2 lg:col-span-3 text-sm text-muted text-center py-12">
            No miners configured. Add one in <a href="/settings" className="text-accent hover:underline">Settings</a>.
          </div>
        )}
      </section>
    </div>
  );
}

// ── helpers ──

function WindowSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="inline-flex items-center rounded border border-border bg-surface text-xs">
      {WINDOW_OPTIONS.map((opt) => (
        <button
          key={opt.minutes}
          onClick={() => onChange(opt.minutes)}
          className={
            'px-2.5 py-1 transition-colors data uppercase tracking-wider text-[10px] ' +
            (value === opt.minutes
              ? 'bg-surface-2 text-foreground'
              : 'text-muted hover:text-foreground')
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  className,
  legend,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  legend?: { label: string; color: string }[];
}) {
  return (
    <article
      className={`rounded-lg border border-border bg-surface p-5 fade-up ${className ?? ''}`}
    >
      <header className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {subtitle && (
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {legend && legend.length > 0 && (
          <ul className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted">
            {legend.map((l, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: l.color }} />
                <span>{l.label}</span>
              </li>
            ))}
          </ul>
        )}
      </header>
      {children}
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-[200px] text-xs text-muted">
      {text}
    </div>
  );
}

/**
 * Monthly bill projection. Locked demand charge from the highest-kw hour so far,
 * service charge accruing daily, energy cost from history, and a projected total
 * for end of month (energy scales with remaining days; demand and service per the
 * known formulas).
 */
function MonthlyBillCard({ monthly, demandRate }: { monthly: MonthlySummary; demandRate: number }) {
  const cur = monthly.currency || '$';
  const pct = Math.min(100, (monthly.days_elapsed / monthly.days_in_month) * 100);

  const monthName = (() => {
    const [y, m] = monthly.month.split('-').map((x) => parseInt(x, 10));
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  })();

  const peakAtLabel = monthly.peak_at
    ? new Date(monthly.peak_at.replace(' ', 'T') + 'Z').toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        hour12: true,
      })
    : '—';

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4 fade-up">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-medium">Bill projection · {monthName}</h3>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
            {monthly.days_elapsed.toFixed(1)} of {monthly.days_in_month} days
          </p>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl data text-foreground">{cur}{monthly.total_so_far.toFixed(2)}</span>
          <span className="text-xs text-muted">so far</span>
          <span className="text-muted">·</span>
          <span className="text-2xl data text-accent">{cur}{monthly.projected_total.toFixed(2)}</span>
          <span className="text-xs text-muted">projected</span>
        </div>
      </header>

      {/* Progress bar showing days elapsed */}
      <div className="h-1 rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full bg-accent transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Line items */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <BillLine
          label="Service"
          amount={`${cur}${monthly.service_charge_so_far.toFixed(2)}`}
          sub={`fixed · ${monthly.days_elapsed.toFixed(1)} days`}
        />
        <BillLine
          label="Demand (locked)"
          amount={`${cur}${monthly.demand_charge_so_far.toFixed(2)}`}
          sub={
            monthly.peak_kw > 0
              ? `${monthly.peak_kw.toFixed(2)} kW × ${cur}${demandRate} · peak ${peakAtLabel}`
              : 'no peak yet'
          }
          accent={monthly.demand_charge_so_far > 0 ? 'red' : 'plain'}
        />
        <BillLine
          label="Energy used"
          amount={`${cur}${monthly.energy_cost_so_far.toFixed(2)}`}
          sub="metered · grows with use"
        />
        <BillLine
          label="Projected end-of-month"
          amount={`${cur}${monthly.projected_total.toFixed(2)}`}
          sub={`${(monthly.projected_total / monthly.days_in_month).toFixed(2)}/day avg`}
          accent="amber"
        />
      </div>
    </section>
  );
}

/**
 * Profitability guard card. Shows the live break-even math and the guard's
 * current state (profitable / in-grace / paused). Only rendered when the guard
 * is enabled in settings.
 */
function ProfitabilityCard({ profit }: { profit: ProfitState }) {
  const s = profit.snapshot;
  const tripped = profit.guard.tripped;
  const belowGrace = !tripped && profit.guard.below_for_seconds != null;

  const fmtUsd = (n: number | null | undefined, dp = 0) =>
    n == null
      ? '—'
      : `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

  const status = tripped
    ? { label: 'Paused — unprofitable', led: 'led--red', text: 'text-red' }
    : belowGrace
    ? { label: 'Below break-even (grace)', led: 'led--amber', text: 'text-accent' }
    : { label: 'Profitable', led: 'led--green', text: 'text-green' };

  const thresholdLabel = s.manual_floor_active ? 'Floor (manual)' : 'Break-even';
  const profitAccent = s.profit_per_day_usd != null && s.profit_per_day_usd < 0 ? 'red' : 'green';

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4 fade-up">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`led ${status.led}`} />
          <h3 className="text-sm font-medium">Profitability</h3>
          <span className={`text-[10px] uppercase tracking-[0.18em] ${status.text}`}>{status.label}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl data text-foreground">{fmtUsd(s.btc_price_usd)}</span>
          <span className="text-xs text-muted">BTC now</span>
          <span className="text-muted">·</span>
          <span className={`text-2xl data ${s.unprofitable ? 'text-red' : 'text-accent'}`}>
            {fmtUsd(s.threshold_usd)}
          </span>
          <span className="text-xs text-muted">{s.manual_floor_active ? 'floor' : 'break-even'}</span>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <BillLine
          label={thresholdLabel}
          amount={fmtUsd(s.threshold_usd)}
          sub={
            s.running_watts > 0
              ? `${(s.running_watts / 1000).toFixed(2)} kW @ ${s.rate_cents_per_kwh.toFixed(2)}¢`
              : 'no power data yet'
          }
          accent={s.unprofitable ? 'red' : 'plain'}
        />
        <BillLine
          label="BTC / day"
          amount={s.btc_per_day != null ? s.btc_per_day.toFixed(5) : '—'}
          sub={s.btc_per_day_method ? s.btc_per_day_method.replace(/_/g, ' ') : 'pool unreachable'}
        />
        <BillLine
          label="Revenue / day"
          amount={fmtUsd(s.revenue_per_day_usd, 2)}
          sub={`energy ${fmtUsd(s.daily_energy_cost_usd, 2)}`}
        />
        <BillLine
          label="Profit / day"
          amount={fmtUsd(s.profit_per_day_usd, 2)}
          sub={s.rate_period === 'peak' ? 'peak rate' : 'off-peak rate'}
          accent={profitAccent}
        />
      </div>

      <p className="text-[11px] text-muted data">{s.reason}</p>
    </section>
  );
}

function BillLine({
  label,
  amount,
  sub,
  accent = 'plain',
}: {
  label: string;
  amount: string;
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
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</div>
      <div className={`text-xl data ${cls}`}>{amount}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5 data">{sub}</div>}
    </div>
  );
}

function MinerCard({
  miner: m,
  sparkData,
  delay,
  onAction,
  ratePerKwh,
  currency,
  currentPeriod,
}: {
  miner: MinerRow;
  sparkData: { ts: number; v: number | undefined }[];
  delay: number;
  onAction: () => void;
  ratePerKwh: number;
  currency: string;
  currentPeriod?: 'peak' | 'offpeak';
}) {
  const stats = m.stats;
  const onlineSparkData = sparkData
    .filter((p) => typeof p.v === 'number')
    .map((p) => ({ ts: p.ts, hashrate: p.v as number }));

  // Per-device cost at the CURRENT rate. Daily is the hourly × 24 assuming
  // constant rate / 24h continuous operation. The "Last 24h spend" hero stat
  // already shows actual consumption — these numbers project from right-now.
  const watts = stats?.power_w ?? 0;
  const costPerHour = (watts / 1000) * ratePerKwh;
  const costPerDay = costPerHour * 24;

  async function act(action: 'pause' | 'resume' | 'restart') {
    if (action === 'restart' && !confirm('Restart this miner?')) return;
    const r = await fetch(`/api/miners/${m.id}/${action}`, { method: 'POST' }).then((x) => x.json());
    if (!r.ok && r.error) {
      alert(`Failed: ${r.error}`);
    }
    onAction();
  }

  return (
    <article
      className="rounded-lg border border-border bg-surface p-5 space-y-4 fade-up card-hover"
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{m.name}</h2>
            <StatusLed status={stats?.status ?? 'offline'} />
          </div>
          <div className="text-xs text-muted data mt-0.5">{m.ip}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl data text-foreground">
            {stats ? stats.hashrate_th.toFixed(1) : '—'}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted data">TH/s</div>
        </div>
      </header>

      {/* Sparkline */}
      <div className="h-[36px]">
        {onlineSparkData.length >= 2 ? (
          <Sparkline data={onlineSparkData} dataKey="hashrate" />
        ) : (
          <div className="h-full flex items-center text-[10px] text-muted uppercase tracking-wider">
            collecting…
          </div>
        )}
      </div>

      {/* Per-board strip */}
      {stats && stats.hashboards.length > 0 && (
        <BoardStrip
          boards={stats.hashboards.map((b) => ({
            id: b.id,
            chip: b.temp_chip,
            outlet: b.temp_outlet,
            inlet: b.temp_inlet,
            hashrate_th: b.hashrate_th,
            enabled: b.enabled,
          }))}
        />
      )}

      {/* Per-device cost: hourly and daily projection at current rate */}
      <CostBlock
        watts={watts}
        costPerHour={costPerHour}
        costPerDay={costPerDay}
        currency={currency}
        currentPeriod={currentPeriod}
      />

      {/* Footer: uptime + action buttons */}
      <div className="flex items-center justify-between pt-1 border-t border-border">
        <div className="text-xs text-muted">
          <span className="data text-foreground">{formatUptime(stats?.uptime_s)}</span>
          <span className="ml-2">uptime</span>
        </div>
        <div className="flex gap-1">
          <ActionBtn onClick={() => act('pause')}>Pause</ActionBtn>
          <ActionBtn onClick={() => act('resume')}>Resume</ActionBtn>
          <ActionBtn onClick={() => act('restart')}>Restart</ActionBtn>
        </div>
      </div>
    </article>
  );
}

/**
 * Three-up block: instant power, $/hr, $/day. Used on miner cards and the
 * plug card. Subtle dim color when off (0 watts) so it doesn't visually pop.
 */
function CostBlock({
  watts,
  costPerHour,
  costPerDay,
  currency,
  currentPeriod,
}: {
  watts: number;
  costPerHour: number;
  costPerDay: number;
  currency: string;
  currentPeriod?: 'peak' | 'offpeak';
}) {
  const dim = watts <= 0;
  const dimClass = dim ? 'text-muted' : 'text-foreground';
  const periodTag =
    currentPeriod === 'peak' ? 'peak rate' : currentPeriod === 'offpeak' ? 'off-peak' : '';
  return (
    <div className="grid grid-cols-3 gap-2 rounded border border-border bg-surface-2 px-3 py-2.5">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted">Power</div>
        <div className={`text-base data ${dimClass}`}>{watts > 0 ? `${watts}W` : '—'}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted">Cost / hr</div>
        <div className={`text-base data ${dimClass}`}>
          {dim ? '—' : `${currency}${costPerHour.toFixed(2)}`}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted">Cost / day</div>
        <div className={`text-base data ${dimClass}`}>
          {dim ? '—' : `${currency}${costPerDay.toFixed(2)}`}
        </div>
        {periodTag && !dim && (
          <div className="text-[9px] uppercase tracking-wider text-muted/70 mt-0.5">{periodTag}</div>
        )}
      </div>
    </div>
  );
}

function PlugCard({
  powerW,
  energyKwh,
  ratePerKwh,
  currency,
  currentPeriod,
  delay,
}: {
  powerW: number | null;
  energyKwh: number | null;
  ratePerKwh: number;
  currency: string;
  currentPeriod: 'peak' | 'offpeak';
  delay: number;
}) {
  const watts = powerW ?? 0;
  const costPerHour = (watts / 1000) * ratePerKwh;
  const costPerDay = costPerHour * 24;
  const status: 'mining' | 'paused' = watts > 5 ? 'mining' : 'paused';
  // Plug "mining" is a misnomer — we just want the green LED for ON, amber for OFF.

  return (
    <article
      className="rounded-lg border border-border bg-surface p-5 space-y-4 fade-up card-hover"
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-medium">Fan Outlet</h2>
            <StatusLed status={status} />
          </div>
          <div className="text-xs text-muted data mt-0.5">Eve Energy · via HA</div>
        </div>
        <div className="text-right">
          <div className="text-2xl data text-foreground">
            {energyKwh != null ? energyKwh.toFixed(2) : '—'}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted data">kWh total</div>
        </div>
      </header>

      <CostBlock
        watts={watts}
        costPerHour={costPerHour}
        costPerDay={costPerDay}
        currency={currency}
        currentPeriod={currentPeriod}
      />

      <div className="text-xs text-muted">
        Powers the cooling fans. Mirrors miner state — turns off when miners pause.
      </div>
    </article>
  );
}

function ActionBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:border-border-strong transition-colors"
    >
      {children}
    </button>
  );
}

function formatUptime(s: number | null | undefined): string {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatWindowLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.round(minutes / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
