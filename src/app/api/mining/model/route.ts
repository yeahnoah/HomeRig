import { NextResponse } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getElectricityConfig, getLiveEfficiency } from '@/lib/cost';
import { getBtcPriceUsd } from '@/lib/btc-price';
import {
  getNetworkStats,
  expectedBtcPerDay,
  CURRENT_BLOCK_SUBSIDY_BTC,
} from '@/lib/btc-network';
import { getProfitConfig } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Consolidated seed data for the dashboard's projection calculator and the J/TH
 * efficiency chart. The heavy modelling math runs client-side so the user can
 * tweak assumptions live; this just provides current live + network values.
 */
export async function GET() {
  ensureInitialized();

  const eff = getLiveEfficiency();
  const elec = getElectricityConfig();
  const profitCfg = getProfitConfig();
  const source = (profitCfg.price_source === 'kraken' ? 'kraken' : 'coinbase') as
    | 'coinbase'
    | 'kraken';

  const [price, net] = await Promise.all([getBtcPriceUsd(source), getNetworkStats()]);

  // BTC/day for the live hashrate at full (24/7) runtime, from network share.
  const btcPerDayAtLiveHashrate =
    net && eff.hashrate_ths > 0
      ? expectedBtcPerDay(eff.hashrate_ths, net.network_ths)
      : null;

  return NextResponse.json({
    live: {
      hashrate_ths: eff.hashrate_ths,
      power_w: eff.power_w,
      jth: eff.jth,
      miner_count: eff.miner_count,
    },
    network: net
      ? {
          network_ths: net.network_ths,
          difficulty: net.difficulty,
          subsidy_btc: CURRENT_BLOCK_SUBSIDY_BTC,
          source: net.source,
        }
      : null,
    btc_price_usd: price,
    offpeak_cents_per_kwh: elec.rate_offpeak_cents,
    currency: elec.currency,
    // Full-runtime BTC/day for the current live hashrate — the projection seed.
    btc_per_day_full_runtime: btcPerDayAtLiveHashrate,
  });
}
