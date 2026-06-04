/**
 * Profitability evaluator.
 *
 * Answers: "at the current BTC price, does running the rig earn more than the
 * marginal energy it burns?" The break-even price is:
 *
 *     break_even_$ = daily_marginal_energy_cost ÷ BTC_mined_per_day
 *
 * where daily_marginal_energy_cost = running_kW × current_marginal_rate × 24h.
 *
 * Notes on the model:
 *   - MARGINAL cost only. We use the per-kWh rate in effect right now (off-peak
 *     vs peak), NOT the demand/service charges. Those are largely fixed for the
 *     month, so the "should we run right now?" decision shouldn't include them.
 *   - Time-of-use aware: break-even is naturally higher during peak hours
 *     because the marginal rate is higher. Re-evaluated every tick.
 *   - FAIL SAFE: if we can't get the price or BTC/day, `unprofitable` is false
 *     (never pause the rig on missing data). The scheduler also resets its
 *     hysteresis timer in that case.
 *
 * This module is pure economics — it does NOT decide to pause. Hysteresis and
 * the actual pause/resume live in the scheduler, which owns the guard state.
 */

import { getProfitConfig } from './db';
import { decrypt } from './crypto';
import {
  getElectricityConfig,
  getSpendSummary,
  getTypicalRunningPowerW,
  type RatePeriod,
} from './cost';
import { getBtcPerDay } from './braiins-pool';
import { getBtcPriceUsd, type PriceSource } from './btc-price';

export interface ProfitSnapshot {
  /** Whether the guard is enabled in config. */
  enabled: boolean;
  /** Live BTC/USD spot, or null if unavailable. */
  btc_price_usd: number | null;
  /** Estimated BTC mined per day, or null if the pool is unreachable/unconfigured. */
  btc_per_day: number | null;
  /** How btc_per_day was derived (for transparency in the UI). */
  btc_per_day_method: string | null;
  /** Trailing-24h pool hashrate in TH/s (0 if unknown). */
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

/**
 * Compute the current profitability snapshot. Async (network: pool + price).
 * Both calls are internally cached, so this is cheap to call every tick.
 */
export async function evaluateProfitability(now: Date = new Date()): Promise<ProfitSnapshot> {
  const cfg = getProfitConfig();
  if (!cfg.enabled) return disabledSnapshot('Profitability guard disabled', false);

  let token = '';
  try {
    token = cfg.pool_token_encrypted ? decrypt(cfg.pool_token_encrypted) : '';
  } catch {
    token = '';
  }
  // A manual price floor is a pure price-vs-threshold decision — it needs no
  // pool data. The dynamic break-even path does require the pool token.
  const manualActive = cfg.manual_floor_enabled === 1 && cfg.manual_floor_usd > 0;
  if (!token && !manualActive) return disabledSnapshot('No Braiins Pool token configured', true);

  const source = (cfg.price_source === 'kraken' ? 'kraken' : 'coinbase') as PriceSource;

  // Fetch economics inputs in parallel (both cached internally). Skip the pool
  // call entirely when running on a manual floor with no token.
  const [perDay, price] = await Promise.all([
    token ? getBtcPerDay(token, now) : Promise.resolve(null),
    getBtcPriceUsd(source),
  ]);

  // Break-even is pinned to the OFF-PEAK rate: the miners only ever run during
  // off-peak hours (the blackout schedule pauses them during peak windows), so
  // off-peak is the marginal cost during the hours mining actually happens.
  const elec = getElectricityConfig();
  const ratePeriod: RatePeriod = 'offpeak';
  const rateCents = elec.rate_offpeak_cents;

  // Energy basis: the ACTUAL measured kWh over the last 24h, priced at off-peak.
  // Using the integral (not instantaneous power × 24h) is critical for two
  // reasons:
  //   1. It self-accounts for runtime — paused/blackout hours contribute no kWh,
  //      so it stays on the SAME calendar-day basis as the pool's daily reward
  //      (which is also earned over a partial day). Mixing a 24h energy cost with
  //      a partial-day reward would inflate break-even and make a profitable rig
  //      look unprofitable.
  //   2. It doesn't read 0 just because the rig happens to be paused right now
  //      (the old instantaneous detector returned 0 during every blackout).
  // A manual override means "assume continuous operation at this power" — the
  // escape hatch for a fresh install with no history yet.
  let runningWatts: number;
  let dailyKwh: number;
  if (cfg.running_watts_override > 0) {
    runningWatts = cfg.running_watts_override;
    dailyKwh = (runningWatts / 1000) * 24;
  } else {
    const spend = getSpendSummary(24 * 60);
    dailyKwh = spend.miner_kwh + spend.plug_kwh;
    // Display-only: typical draw while actually running (24h lookback so it's
    // populated even during a blackout).
    runningWatts = getTypicalRunningPowerW(0, 24 * 60);
  }
  const dailyEnergyCost = dailyKwh * (rateCents / 100);

  const btcPerDay = perDay?.btc_per_day ?? null;
  const breakEven = btcPerDay != null && btcPerDay > 0 ? dailyEnergyCost / btcPerDay : null;

  const threshold = manualActive ? cfg.manual_floor_usd : breakEven;

  const revenuePerDay = btcPerDay != null && price != null ? btcPerDay * price : null;
  const profitPerDay = revenuePerDay != null ? revenuePerDay - dailyEnergyCost : null;

  // Can we make a real decision? The manual floor needs only a price; the
  // dynamic break-even also needs measured energy (to compute the cost).
  const evaluable = price != null && threshold != null && (manualActive || dailyKwh > 0);

  // Determine raw unprofitability + reason. Fail safe on any missing input.
  let unprofitable = false;
  let reason: string;
  if (price == null) {
    reason = 'BTC price unavailable — guard idle (fail safe)';
  } else if (threshold == null) {
    reason = manualActive
      ? 'Manual floor not set — guard idle'
      : 'BTC/day unavailable — guard idle (fail safe)';
  } else if (!manualActive && dailyKwh <= 0) {
    reason = 'No energy history yet — guard idle (fail safe)';
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
    btc_per_day: btcPerDay,
    btc_per_day_method: perDay?.method ?? null,
    hashrate_ths: perDay?.hashrate_ths ?? 0,
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
