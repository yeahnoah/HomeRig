import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { setSettingValue, getLatestPlugHistory } from '@/lib/db';
import {
  getElectricityConfig,
  currentRateCentsPerKwh,
  currentRatePeriod,
  ELECTRICITY_KEYS,
  getSpendSummary,
  getMonthlySummary,
  invalidateCostCache,
  type ElectricityConfigPatch,
} from '@/lib/cost';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  ensureInitialized();
  // Optional ?window_minutes=N to pick a different integration window.
  const { searchParams } = new URL(req.url);
  const windowMinutes = parseInt(searchParams.get('window_minutes') ?? `${24 * 60}`, 10);

  // Latest plug sample is updated by the poller every ~10s, so reading from
  // SQLite is fresh enough without making the dashboard wait on a fresh HA call.
  const latest = getLatestPlugHistory();
  const plug = latest
    ? { power_w: latest.plug_power_w, energy_kwh: latest.plug_energy_kwh, ts: latest.ts }
    : null;

  return NextResponse.json({
    config: getElectricityConfig(),
    current_period: currentRatePeriod(),
    current_rate_cents_per_kwh: currentRateCentsPerKwh(),
    spend: getSpendSummary(windowMinutes),
    monthly: getMonthlySummary(),
    plug,
  });
}

export async function PUT(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as ElectricityConfigPatch;
  if (body.currency !== undefined) setSettingValue(ELECTRICITY_KEYS.currency, body.currency);
  if (body.rate_offpeak_cents !== undefined)
    setSettingValue(ELECTRICITY_KEYS.rate_offpeak_cents, String(body.rate_offpeak_cents));
  if (body.rate_peak_cents !== undefined)
    setSettingValue(ELECTRICITY_KEYS.rate_peak_cents, String(body.rate_peak_cents));
  if (body.use_blackout_as_peak !== undefined)
    setSettingValue(ELECTRICITY_KEYS.use_blackout_as_peak, body.use_blackout_as_peak ? '1' : '0');
  if (body.service_charge_cents_per_day !== undefined)
    setSettingValue(ELECTRICITY_KEYS.service_charge_cents_per_day, String(body.service_charge_cents_per_day));
  if (body.demand_charge_dollars_per_kw !== undefined)
    setSettingValue(ELECTRICITY_KEYS.demand_charge_dollars_per_kw, String(body.demand_charge_dollars_per_kw));
  // Rates changed — drop memoized summaries so the new rates take effect now.
  invalidateCostCache();
  return NextResponse.json({ ok: true, config: getElectricityConfig() });
}
