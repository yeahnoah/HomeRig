/**
 * Profitability evaluator.
 *
 * Answers: "at the current BTC price, does running the rig earn more than the
 * marginal energy it burns?" The break-even price is:
 *
 *     break_even_$ = daily_energy_cost ÷ EXPECTED_BTC_per_day
 *
 * where both are at FULL (24h) runtime:
 *     daily_energy_cost   = running_kW × off-peak_rate × 24h
 *     expected_BTC_per_day = (rig_hashrate ÷ network_hashrate) × 144 × subsidy
 *
 * Why EXPECTED productivity, not the pool's measured reward:
 *   The pool's recent daily reward collapses whenever the rig is paused (by a
 *   blackout or the guard itself). Dividing energy by a suppressed reward made
 *   break-even spike (e.g. to $100k) and trip again — a slow death spiral where
 *   the guard's own pausing fed back into its threshold. Expected productivity
 *   is derived from the rig's share of the LIVE NETWORK and does not depend on
 *   whether we're currently running, so break-even is stable: it only moves with
 *   network hashrate, the BTC subsidy, the electricity rate, and the rig's own
 *   efficiency. Both numerator and denominator are full-runtime, so runtime
 *   cancels and the result is a clean marginal break-even.
 *
 * Notes:
 *   - MARGINAL cost only — the off-peak per-kWh rate (miners run off-peak), not
 *     demand/service charges.
 *   - FAIL SAFE: if price, network stats, or rig data are missing, `unprofitable`
 *     is false (never pause on missing data). The scheduler resets hysteresis.
 *   - The Braiins Pool token is no longer required for the dynamic break-even.
 *
 * This module is pure economics — it does NOT decide to pause. Hysteresis and
 * the actual pause/resume live in the scheduler, which owns the guard state.
 */

import { getProfitConfig } from './db';
import { getElectricityConfig, getLiveEfficiency, type RatePeriod } from './cost';
import { getBtcPriceUsd, type PriceSource } from './btc-price';
import { getNetworkStats, expectedBtcPerDay } from './btc-network';

export interface ProfitSnapshot {
  /** Whether the guard is enabled in config. */
  enabled: boolean;
  /** Live BTC/USD spot, or null if unavailable. */
  btc_price_usd: number | null;
  /** EXPECTED BTC mined per day at full runtime (rig share of the live network). */
  btc_per_day: number | null;
  /** How btc_per_day was derived (e.g. "network (mempool)"). */
  btc_per_day_method: string | null;
  /** Rig hashrate used for the math, in TH/s (0 if unknown). */
  hashrate_ths: number;
  /** Rig running power used for the math, in watts. */
  running_watts: number;
  /** Current marginal rate period + ¢/kWh. */
  rate_period: 'peak' | 'offpeak';
  rate_cents_per_kwh: number;
  /** Marginal energy cost for a full day at running power + current rate, in USD. */
  daily_energy_cost_usd: number;
  /** Break-even BTC price in USD (daily energy cost ÷ BTC/day), or null. */
  break_even_usd: number | null;
  /** The price threshold actually in force (manual floor overrides break-even). */
  threshold_usd: number | null;
  /** True when a manual floor is overriding the dynamic break-even. */
  manual_floor_active: boolean;
  /** Projected gross revenue per day at current price, USD. */
  revenue_per_day_usd: number | null;
  /** Projected net profit per day (revenue − marginal energy), USD. */
  profit_per_day_usd: number | null;
  /** Whether the guard has enough data to make a real decision this tick. */
  evaluable: boolean;
  /** Raw economics flag: price < threshold. NO hysteresis applied here. */
  unprofitable: boolean;
  /** Short human-readable explanation. */
  reason: string;
}

function disabledSnapshot(reason: string, enabled: boolean): ProfitSnapshot {
  return {
    enabled,
    btc_price_usd: null,
    btc_per_day: null,
    btc_per_day_method: null,
    hashrate_ths: 0,
    running_watts: 0,
    rate_period: 'offpeak',
    rate_cents_per_kwh: 0,
    daily_energy_cost_usd: 0,
    break_even_usd: null,
    threshold_usd: null,
    manual_floor_active: false,
    revenue_per_day_usd: null,
    profit_per_day_usd: null,
    evaluable: false,
    unprofitable: false,
    reason,
  };
}

/** Nameplate fallback for 2× Antminer S21 XP, used only if there's no recent
 *  running history at all (e.g. fresh install). Keeps the guard stable rather
 *  than blind. running_watts_override (if set) takes priority over both. */
const NAMEPLATE_THS = 540;
const NAMEPLATE_WATTS = 7290;

/**
 * Compute the current profitability snapshot. Async (network + price, both
 * cached), so it's cheap to call every tick.
 */
export async function evaluateProfitability(now: Date = new Date()): Promise<ProfitSnapshot> {
  void now;
  const cfg = getProfitConfig();
  if (!cfg.enabled) return disabledSnapshot('Profitability guard disabled', false);

  const manualActive = cfg.manual_floor_enabled === 1 && cfg.manual_floor_usd > 0;
  const source = (cfg.price_source === 'kraken' ? 'kraken' : 'coinbase') as PriceSource;

  // Live price + network stats (both cached internally).
  const [price, net] = await Promise.all([getBtcPriceUsd(source), getNetworkStats()]);

  const elec = getElectricityConfig();
  const ratePeriod: RatePeriod = 'offpeak';
  const rateCents = elec.rate_offpeak_cents;

  // Rig productivity inputs — averaged over RUNNING samples in the last 24h, so
  // they reflect full-runtime values and stay stable even if the rig is paused
  // part of the day. Override > recent-running > nameplate.
  const eff = getLiveEfficiency(24 * 60);
  const hashrateThs = eff.hashrate_ths > 0 ? eff.hashrate_ths : NAMEPLATE_THS;
  const runningWatts =
    cfg.running_watts_override > 0
      ? cfg.running_watts_override
      : eff.power_w > 0
        ? eff.power_w
        : NAMEPLATE_WATTS;

  // EXPECTED BTC/day at full runtime = rig's share of the live network. Stable;
  // does NOT collapse when the rig is paused, so the guard can't spiral.
  const expectedBtcDay =
    net && net.network_ths > 0 ? expectedBtcPerDay(hashrateThs, net.network_ths) : null;

  // Cost + break-even, both at full (24h) runtime → runtime cancels → stable.
  const dailyEnergyCost = (runningWatts / 1000) * 24 * (rateCents / 100);
  const breakEven =
    expectedBtcDay != null && expectedBtcDay > 0 ? dailyEnergyCost / expectedBtcDay : null;

  const threshold = manualActive ? cfg.manual_floor_usd : breakEven;

  const revenuePerDay = expectedBtcDay != null && price != null ? expectedBtcDay * price : null;
  const profitPerDay = revenuePerDay != null ? revenuePerDay - dailyEnergyCost : null;

  // Can we make a real decision? Manual floor needs only a price; the dynamic
  // break-even also needs network stats (to compute expected productivity).
  const evaluable =
    price != null && threshold != null && (manualActive || (expectedBtcDay != null && expectedBtcDay > 0));

  // Determine raw unprofitability + reason. Fail safe on any missing input.
  let unprofitable = false;
  let reason: string;
  if (price == null) {
    reason = 'BTC price unavailable — guard idle (fail safe)';
  } else if (!manualActive && (net == null || expectedBtcDay == null)) {
    reason = 'Network data unavailable — guard idle (fail safe)';
  } else if (threshold == null) {
    reason = 'Manual floor not set — guard idle';
  } else {
    unprofitable = price < threshold;
    const label = manualActive ? 'manual floor' : 'break-even';
    reason = unprofitable
      ? `Price $${Math.round(price).toLocaleString()} is BELOW ${label} $${Math.round(threshold).toLocaleString()}`
      : `Price $${Math.round(price).toLocaleString()} is above ${label} $${Math.round(threshold).toLocaleString()}`;
  }

  return {
    enabled: true,
    btc_price_usd: price,
    btc_per_day: expectedBtcDay,
    btc_per_day_method: net ? `network (${net.source})` : null,
    hashrate_ths: hashrateThs,
    running_watts: runningWatts,
    rate_period: ratePeriod,
    rate_cents_per_kwh: rateCents,
    daily_energy_cost_usd: dailyEnergyCost,
    break_even_usd: breakEven,
    threshold_usd: threshold,
    manual_floor_active: manualActive,
    revenue_per_day_usd: revenuePerDay,
    profit_per_day_usd: profitPerDay,
    evaluable,
    unprofitable,
    reason,
  };
}
