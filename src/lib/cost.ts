/**
 * Cost / energy calculations for the dashboard.
 *
 * Configuration lives in the `settings` table as key-value pairs:
 *   electricity_currency           — currency symbol/code, e.g. "$" or "USD"
 *   electricity_rate_offpeak_cents — off-peak rate, in cents per kWh
 *   electricity_rate_peak_cents    — peak rate, in cents per kWh
 *   electricity_use_blackout_as_peak — "1" if blackout windows define peak hours
 *
 * If `use_blackout_as_peak` is set, the rate selector checks whether the current
 * time falls inside any active blackout window — if so, use peak rate. This makes
 * the cost reflect what the user WOULD pay if they ignored the schedule and let
 * miners run, which is more informative than always quoting off-peak.
 */

import {
  getSettingValue,
  getEnabledBlackouts,
  getStatsHistory,
  getPlugHistory,
  type PlugHistoryRow,
} from './db';
import { windowIsActive } from './blackouts';

/**
 * Defaults match Georgia Power's TOU-RD-11 residential tariff (effective Jan 2025):
 *   - Basic Service Charge ........ $0.4603 / day  (46.03 cents/day)
 *   - On-Peak Energy .............. 14.2986¢ / kWh
 *   - Off-Peak Energy .............. 1.5288¢ / kWh
 *   - Demand Charge ............... $12.21 / kW of highest 60-min average for the month
 *
 * Update via the Settings page if your tariff or rates differ.
 */
export interface ElectricityConfig {
  currency: string;
  rate_offpeak_cents: number;
  rate_peak_cents: number;
  use_blackout_as_peak: boolean;
  /** Daily fixed charge (e.g. 46.03 = $0.4603/day). */
  service_charge_cents_per_day: number;
  /** Demand charge in dollars per kW of peak monthly demand (e.g. 12.21 = $12.21/kW). */
  demand_charge_dollars_per_kw: number;
}

export function getElectricityConfig(): ElectricityConfig {
  return {
    currency: getSettingValue('electricity_currency') ?? '$',
    rate_offpeak_cents: parseFloat(getSettingValue('electricity_rate_offpeak_cents') ?? '1.5288'),
    rate_peak_cents: parseFloat(getSettingValue('electricity_rate_peak_cents') ?? '14.2986'),
    use_blackout_as_peak: (getSettingValue('electricity_use_blackout_as_peak') ?? '1') === '1',
    service_charge_cents_per_day: parseFloat(
      getSettingValue('electricity_service_charge_cents_per_day') ?? '46.03'
    ),
    demand_charge_dollars_per_kw: parseFloat(
      getSettingValue('electricity_demand_charge_dollars_per_kw') ?? '12.21'
    ),
  };
}

export interface ElectricityConfigPatch {
  currency?: string;
  rate_offpeak_cents?: number;
  rate_peak_cents?: number;
  use_blackout_as_peak?: boolean;
  service_charge_cents_per_day?: number;
  demand_charge_dollars_per_kw?: number;
}

// Using the same key-value setter from db.ts (re-imported by callers).
export const ELECTRICITY_KEYS = {
  currency: 'electricity_currency',
  rate_offpeak_cents: 'electricity_rate_offpeak_cents',
  rate_peak_cents: 'electricity_rate_peak_cents',
  use_blackout_as_peak: 'electricity_use_blackout_as_peak',
  service_charge_cents_per_day: 'electricity_service_charge_cents_per_day',
  demand_charge_dollars_per_kw: 'electricity_demand_charge_dollars_per_kw',
} as const;

export type RatePeriod = 'peak' | 'offpeak';

export function currentRatePeriod(now: Date = new Date()): RatePeriod {
  const cfg = getElectricityConfig();
  if (!cfg.use_blackout_as_peak) return 'offpeak';
  const windows = getEnabledBlackouts();
  for (const w of windows) {
    if (windowIsActive(w, now)) return 'peak';
  }
  return 'offpeak';
}

export function currentRateCentsPerKwh(now: Date = new Date()): number {
  const cfg = getElectricityConfig();
  return currentRatePeriod(now) === 'peak' ? cfg.rate_peak_cents : cfg.rate_offpeak_cents;
}

/**
 * Build a reusable rate-period resolver. CRITICAL for the integration loops:
 * `currentRatePeriod()` issues a fresh `getEnabledBlackouts()` DB query on every
 * call, so calling it per history row is O(rows) SQLite queries — tens of
 * thousands per request once history fills up, which blocks the event loop for
 * tens of seconds. This fetches the windows ONCE and returns a pure closure that
 * evaluates each timestamp in memory.
 */
function makeRatePeriodResolver(cfg: ElectricityConfig): (ts: Date) => RatePeriod {
  if (!cfg.use_blackout_as_peak) return () => 'offpeak';
  const windows = getEnabledBlackouts(); // one query, reused for every row
  return (ts: Date) => {
    for (const w of windows) if (windowIsActive(w, ts)) return 'peak';
    return 'offpeak';
  };
}

/** Convert watts × rate (cents/kWh) → dollars per hour. */
export function costPerHour(watts: number, rateCentsPerKwh: number): number {
  if (!watts || watts <= 0) return 0;
  const kw = watts / 1000;
  return (kw * rateCentsPerKwh) / 100;
}

/** Convenience: current $/hr using current rate. */
export function currentCostPerHour(watts: number, now: Date = new Date()): number {
  return costPerHour(watts, currentRateCentsPerKwh(now));
}

/**
 * Project the next 24h cost assuming the schedule continues to apply.
 * This is a rough estimate: walk forward in 15-minute slices, asking for each
 * whether it's peak (and miners would be paused) or off-peak (mining at `wattsRunning`).
 * The schedule semantics treat peak = blackout = miners OFF, so peak hours
 * contribute nothing if the scheduler is honored. When `assumeAlwaysRunning` is
 * true we instead show what it would cost to ignore the schedule.
 */
export function projectNext24h(
  wattsRunning: number,
  opts: { assumeAlwaysRunning?: boolean; now?: Date } = {}
): { offpeakHours: number; peakHours: number; cost: number } {
  const now = opts.now ?? new Date();
  const cfg = getElectricityConfig();
  const slices = 24 * 4; // 15-minute slices
  let offpeakHours = 0;
  let peakHours = 0;
  let cost = 0;
  for (let i = 0; i < slices; i++) {
    const t = new Date(now.getTime() + i * 15 * 60_000);
    const period = currentRatePeriod(t);
    const hours = 0.25;
    if (period === 'peak') {
      peakHours += hours;
      if (opts.assumeAlwaysRunning) {
        cost += costPerHour(wattsRunning, cfg.rate_peak_cents) * hours;
      }
      // else: miners are paused during peak — no cost contribution
    } else {
      offpeakHours += hours;
      cost += costPerHour(wattsRunning, cfg.rate_offpeak_cents) * hours;
    }
  }
  return { offpeakHours, peakHours, cost };
}

/**
 * Estimate today's cost so far by walking the stats_history and integrating.
 * Caller should pass in the relevant history rows (already filtered to today).
 */
export function estimateCostFromHistory(
  history: { ts: string; power_w: number | null }[],
  cfg: ElectricityConfig = getElectricityConfig()
): number {
  if (history.length === 0) return 0;
  const resolvePeriod = makeRatePeriodResolver(cfg);
  let cost = 0;
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i];
    const b = history[i + 1];
    const watts = a.power_w ?? 0;
    if (watts <= 0) continue;
    const dtMs = new Date(b.ts).getTime() - new Date(a.ts).getTime();
    if (dtMs <= 0 || dtMs > 10 * 60_000) continue; // skip gaps > 10 min (offline)
    const hours = dtMs / 3_600_000;
    const period = resolvePeriod(new Date(a.ts));
    const rate = period === 'peak' ? cfg.rate_peak_cents : cfg.rate_offpeak_cents;
    cost += costPerHour(watts, rate) * hours;
  }
  return cost;
}

// ─── Spend summary (more accurate than instantaneous watts × rate) ───────────
//
// Two parts:
//   1. MINER cost — integrate per-miner power from stats_history. We have to
//      do this because miners don't expose a cumulative meter; instantaneous
//      watts × time is the best we can do.
//   2. FAN/PLUG cost — use the plug's CUMULATIVE kWh meter directly. We walk
//      adjacent samples in plug_history, take the kWh delta, and apply the
//      rate that was in effect at the older sample. This is meter-accurate
//      and captures rate transitions correctly.

export interface SpendSummary {
  miner_cost: number;
  plug_cost: number;
  total_cost: number;
  miner_kwh: number;
  plug_kwh: number;
  /** Currency symbol/code from config. */
  currency: string;
  /** Window covered, in minutes. */
  window_minutes: number;
}

function integrateMinerCost(minutes: number, cfg: ElectricityConfig): { cost: number; kwh: number } {
  const rows = getStatsHistory({ minutes });
  if (rows.length === 0) return { cost: 0, kwh: 0 };
  // Per-miner integration. Group rows by miner_id, walk pairs.
  const byMiner = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!byMiner.has(r.miner_id)) byMiner.set(r.miner_id, []);
    byMiner.get(r.miner_id)!.push(r);
  }
  const resolvePeriod = makeRatePeriodResolver(cfg);
  let cost = 0;
  let kwh = 0;
  for (const list of byMiner.values()) {
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const watts = a.power_w ?? 0;
      if (watts <= 0) continue;
      const dtMs = new Date(b.ts).getTime() - new Date(a.ts).getTime();
      if (dtMs <= 0 || dtMs > 10 * 60_000) continue;
      const hours = dtMs / 3_600_000;
      const period = resolvePeriod(new Date(a.ts));
      const rate = period === 'peak' ? cfg.rate_peak_cents : cfg.rate_offpeak_cents;
      cost += costPerHour(watts, rate) * hours;
      kwh += (watts / 1000) * hours;
    }
  }
  return { cost, kwh };
}

function integratePlugCost(minutes: number, cfg: ElectricityConfig): { cost: number; kwh: number } {
  const rows = getPlugHistory({ minutes });
  if (rows.length < 2) return { cost: 0, kwh: 0 };
  // Use the cumulative kWh meter. Walk adjacent rows, sum positive deltas
  // weighted by the rate at the older sample. Negative deltas (meter reset
  // after firmware update) are skipped.
  const resolvePeriod = makeRatePeriodResolver(cfg);
  let cost = 0;
  let kwh = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a: PlugHistoryRow = rows[i];
    const b: PlugHistoryRow = rows[i + 1];
    if (a.plug_energy_kwh == null || b.plug_energy_kwh == null) continue;
    const delta = b.plug_energy_kwh - a.plug_energy_kwh;
    if (!Number.isFinite(delta) || delta <= 0 || delta > 1) continue; // 1kWh per interval is sanity ceiling
    const period = resolvePeriod(new Date(a.ts));
    const rate = period === 'peak' ? cfg.rate_peak_cents : cfg.rate_offpeak_cents;
    cost += (delta * rate) / 100;
    kwh += delta;
  }
  return { cost, kwh };
}

// ─── Summary cache ───────────────────────────────────────────────────────────
//
// getSpendSummary + getMonthlySummary integrate days of history rows on each
// call (synchronous SQLite + JS loops). The dashboard polls /api/electricity
// every ~10s, but these numbers barely move second-to-second, so we memoize for
// a short TTL to keep that work — and the event-loop block it causes — off the
// hot path. Rate edits call invalidateCostCache() so Settings changes are
// reflected immediately rather than after the TTL.
const SUMMARY_TTL_MS = 30_000;
interface CacheBox<T> {
  value: T;
  at: number;
}
const cacheG = globalThis as unknown as {
  __homerigCost?: {
    spend: Map<number, CacheBox<SpendSummary>>;
    monthly: CacheBox<MonthlySummary> | null;
  };
};
const costCache =
  cacheG.__homerigCost ?? (cacheG.__homerigCost = { spend: new Map(), monthly: null });

/** Drop all memoized summaries — call after any electricity-rate change. */
export function invalidateCostCache() {
  costCache.spend.clear();
  costCache.monthly = null;
}

/**
 * Compute a spend summary over the given window (default: today, last 24h).
 * Combines integrated miner power and the plug's meter-based fan energy.
 * Memoized for SUMMARY_TTL_MS, keyed by window.
 */
export function getSpendSummary(windowMinutes: number = 24 * 60): SpendSummary {
  const cached = costCache.spend.get(windowMinutes);
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;
  const cfg = getElectricityConfig();
  const miner = integrateMinerCost(windowMinutes, cfg);
  const plug = integratePlugCost(windowMinutes, cfg);
  const value: SpendSummary = {
    miner_cost: miner.cost,
    plug_cost: plug.cost,
    total_cost: miner.cost + plug.cost,
    miner_kwh: miner.kwh,
    plug_kwh: plug.kwh,
    currency: cfg.currency,
    window_minutes: windowMinutes,
  };
  costCache.spend.set(windowMinutes, { value, at: Date.now() });
  return value;
}

// ─── Typical running power ───────────────────────────────────────────────────
//
// The profitability guard needs the rig's power draw WHEN RUNNING, not the
// instantaneous draw (which is ~0 while paused). We average recent samples that
// look like active mining (per miner) plus the plug's active draw. This answers
// "if the rig runs, what does it cost?" — the right basis for a go/no-go call.

/** Per-miner "running" threshold in watts; below this we treat the miner as paused/idle. */
const RUNNING_MINER_THRESHOLD_W = 500;
/** Plug "on" threshold in watts. */
const RUNNING_PLUG_THRESHOLD_W = 5;

/**
 * Estimate the rig's total running power in watts (miners + plug). If
 * `overrideW > 0`, returns that directly. Otherwise averages active samples
 * from the last `lookbackMinutes`. Returns 0 when there's no running history —
 * callers treat 0 as "unknown" and fail safe (don't pause on profitability).
 */
export function getTypicalRunningPowerW(overrideW = 0, lookbackMinutes = 180): number {
  if (overrideW > 0) return overrideW;

  const rows = getStatsHistory({ minutes: lookbackMinutes });
  const byMiner = new Map<number, { sum: number; count: number }>();
  for (const r of rows) {
    if (r.power_w == null || r.power_w < RUNNING_MINER_THRESHOLD_W) continue;
    let m = byMiner.get(r.miner_id);
    if (!m) {
      m = { sum: 0, count: 0 };
      byMiner.set(r.miner_id, m);
    }
    m.sum += r.power_w;
    m.count += 1;
  }
  let minerW = 0;
  for (const m of byMiner.values()) if (m.count > 0) minerW += m.sum / m.count;

  const plugRows = getPlugHistory({ minutes: lookbackMinutes });
  let plugSum = 0;
  let plugCount = 0;
  for (const r of plugRows) {
    if (r.plug_power_w == null || r.plug_power_w < RUNNING_PLUG_THRESHOLD_W) continue;
    plugSum += r.plug_power_w;
    plugCount += 1;
  }
  const plugW = plugCount > 0 ? plugSum / plugCount : 0;

  return minerW + plugW;
}

// ─── Live mining efficiency (J/TH) ───────────────────────────────────────────
//
// Energy efficiency = power (W) / hashrate (TH/s) = J/TH. Computed from recent
// samples where the miner was actually hashing (hashrate > 0 and power above the
// running threshold), so spin-up/paused transients don't skew it.

export interface LiveEfficiency {
  /** Combined running hashrate, TH/s. */
  hashrate_ths: number;
  /** Combined running power, W. */
  power_w: number;
  /** Efficiency in J/TH (= W per TH/s). 0 if not enough data. */
  jth: number;
  /** Number of miners contributing running samples. */
  miner_count: number;
}

export function getLiveEfficiency(lookbackMinutes = 180): LiveEfficiency {
  const rows = getStatsHistory({ minutes: lookbackMinutes });
  // Per miner: average power and hashrate over "running" samples.
  const byMiner = new Map<number, { pSum: number; hSum: number; n: number }>();
  for (const r of rows) {
    if (r.power_w == null || r.power_w < RUNNING_MINER_THRESHOLD_W) continue;
    if (!r.hashrate_th || r.hashrate_th <= 0) continue;
    let m = byMiner.get(r.miner_id);
    if (!m) {
      m = { pSum: 0, hSum: 0, n: 0 };
      byMiner.set(r.miner_id, m);
    }
    m.pSum += r.power_w;
    m.hSum += r.hashrate_th;
    m.n += 1;
  }
  let power = 0;
  let hashrate = 0;
  for (const m of byMiner.values()) {
    if (m.n > 0) {
      power += m.pSum / m.n;
      hashrate += m.hSum / m.n;
    }
  }
  const jth = hashrate > 0 ? power / hashrate : 0;
  return { hashrate_ths: hashrate, power_w: power, jth, miner_count: byMiner.size };
}

// ─── Monthly demand peak ─────────────────────────────────────────────────────
//
// Georgia Power TOU-RD bills demand based on the highest 60-minute average kW
// during the calendar month, applied year-round (not just during peak hours).
// Even one hour of running at 7 kW = $85 in demand charges for the month.
//
// We approximate by bucketing samples into aligned hourly windows
// (00:00-00:59, 01:00-01:59, ...) since SQLite timestamps are at second
// granularity. This matches what a smart meter would report well enough.

export interface MonthlySummary {
  /** "YYYY-MM" — the calendar month being summarized. */
  month: string;
  /** Days elapsed in the current month so far. */
  days_elapsed: number;
  /** Days in the current month. */
  days_in_month: number;
  /** Highest 60-min average kW (miners + plug combined) seen so far this month. */
  peak_kw: number;
  /** Time of the peak hour, ISO string. */
  peak_at: string | null;
  /** Monthly cost breakdown so far. */
  service_charge_so_far: number;
  demand_charge_so_far: number;
  energy_cost_so_far: number;
  total_so_far: number;
  /**
   * End-of-month projection if today's load continues. The demand charge piece
   * is "locked in" once a peak is hit, so projected = current peak × rate.
   * Energy + service grow with remaining days.
   */
  projected_total: number;
  currency: string;
}

function startOfCurrentMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

function daysInMonth(now: Date): number {
  // Day 0 of next month = last day of current month
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/**
 * Bucket history rows into aligned hourly windows and return the max kW across
 * all buckets. The "kW" for an hour = average per-miner power across that hour,
 * summed across miners, plus the average plug power. This matches what a smart
 * meter measures: TOTAL hourly average load, not average load per device.
 */
function maxHourlyKw(
  monthStartSqlite: string,
  now: Date
): { peak_kw: number; peak_at: string | null } {
  const monthMinutes = Math.ceil((now.getTime() - new Date(monthStartSqlite).getTime()) / 60_000);
  if (monthMinutes < 1) return { peak_kw: 0, peak_at: null };

  const minerRows = getStatsHistory({ minutes: monthMinutes });
  const plugRows = getPlugHistory({ minutes: monthMinutes });

  // Aligned hourly bucket key: 'YYYY-MM-DD HH'
  const bucketOf = (ts: string) => ts.slice(0, 13);

  // Per-bucket data: miner power summed PER MINER (then averaged), plus plug.
  //   Map<bucketKey, { miners: Map<minerId, {sum, count}>, plug_sum, plug_count }>
  interface Bucket {
    miners: Map<number, { sum: number; count: number }>;
    plug_sum: number;
    plug_count: number;
  }
  const buckets = new Map<string, Bucket>();
  const ensure = (k: string): Bucket => {
    let b = buckets.get(k);
    if (!b) {
      b = { miners: new Map(), plug_sum: 0, plug_count: 0 };
      buckets.set(k, b);
    }
    return b;
  };

  for (const r of minerRows) {
    if (r.power_w == null) continue;
    const b = ensure(bucketOf(r.ts));
    let m = b.miners.get(r.miner_id);
    if (!m) {
      m = { sum: 0, count: 0 };
      b.miners.set(r.miner_id, m);
    }
    m.sum += r.power_w;
    m.count += 1;
  }
  for (const r of plugRows) {
    if (r.plug_power_w == null) continue;
    const b = ensure(bucketOf(r.ts));
    b.plug_sum += r.plug_power_w;
    b.plug_count += 1;
  }

  let peak_kw = 0;
  let peak_at: string | null = null;
  for (const [hourKey, b] of buckets) {
    // Total miner avg = sum of per-miner averages
    let minerTotalAvgW = 0;
    for (const m of b.miners.values()) {
      if (m.count > 0) minerTotalAvgW += m.sum / m.count;
    }
    const plugAvgW = b.plug_count > 0 ? b.plug_sum / b.plug_count : 0;
    const totalKw = (minerTotalAvgW + plugAvgW) / 1000;
    if (totalKw > peak_kw) {
      peak_kw = totalKw;
      peak_at = `${hourKey}:00:00`;
    }
  }
  return { peak_kw, peak_at };
}

/**
 * Current month's bill projection. Memoized for SUMMARY_TTL_MS — this is the
 * heaviest call (integrates the whole month-to-date plus an hourly demand-peak
 * scan), and the dashboard polls it every ~10s.
 */
export function getMonthlySummary(now: Date = new Date()): MonthlySummary {
  const cached = costCache.monthly;
  if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;
  const value = computeMonthlySummary(now);
  costCache.monthly = { value, at: Date.now() };
  return value;
}

function computeMonthlySummary(now: Date): MonthlySummary {
  const cfg = getElectricityConfig();
  const monthStart = startOfCurrentMonth(now);
  // SQLite stores as 'YYYY-MM-DD HH:MM:SS' UTC. Format ours the same way.
  const monthStartSqlite = monthStart
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');

  // Total minutes elapsed in this month, capped at 1 (avoid divide by zero issues).
  const elapsedMs = Math.max(60_000, now.getTime() - monthStart.getTime());
  const elapsedDays = elapsedMs / 86_400_000;
  const dim = daysInMonth(now);

  // Service charge accrues linearly per day.
  const service_charge_so_far = (cfg.service_charge_cents_per_day / 100) * elapsedDays;
  const service_charge_projected = (cfg.service_charge_cents_per_day / 100) * dim;

  // Demand charge: peak kW × rate. Locks in for the rest of the month once hit.
  const { peak_kw, peak_at } = maxHourlyKw(monthStartSqlite, now);
  const demand_charge_so_far = peak_kw * cfg.demand_charge_dollars_per_kw;

  // Energy cost so far this month (integrate from history).
  const monthMinutes = Math.ceil(elapsedMs / 60_000);
  const miner = integrateMinerCost(monthMinutes, cfg);
  const plug = integratePlugCost(monthMinutes, cfg);
  const energy_cost_so_far = miner.cost + plug.cost;

  // Projection: scale energy by remaining days, add full service + locked demand.
  const fractionElapsed = Math.min(1, elapsedDays / dim);
  const energy_projected = fractionElapsed > 0 ? energy_cost_so_far / fractionElapsed : 0;

  return {
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    days_elapsed: elapsedDays,
    days_in_month: dim,
    peak_kw,
    peak_at,
    service_charge_so_far,
    demand_charge_so_far,
    energy_cost_so_far,
    total_so_far: service_charge_so_far + demand_charge_so_far + energy_cost_so_far,
    projected_total:
      service_charge_projected + demand_charge_so_far /* locked once hit */ + energy_projected,
    currency: cfg.currency,
  };
}
