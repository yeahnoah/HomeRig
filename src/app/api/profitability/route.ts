import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getProfitConfig, updateProfitConfig, type ProfitConfigPatch } from '@/lib/db';
import { evaluateProfitability } from '@/lib/profitability';
import { getProfitState } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureInitialized();
  const cfg = getProfitConfig();
  // Fresh snapshot for the live numbers (internally cached, so cheap). The
  // tripped/below state lives in the scheduler's guard state.
  const snapshot = await evaluateProfitability();
  const guard = getProfitState();

  return NextResponse.json({
    config: {
      enabled: cfg.enabled === 1,
      has_token: Boolean(cfg.pool_token_encrypted),
      price_source: cfg.price_source,
      pause_below_minutes: cfg.pause_below_minutes,
      resume_margin_pct: cfg.resume_margin_pct,
      manual_floor_enabled: cfg.manual_floor_enabled === 1,
      manual_floor_usd: cfg.manual_floor_usd,
      running_watts_override: cfg.running_watts_override,
      notify_on_trip: cfg.notify_on_trip === 1,
      notify_on_recover: cfg.notify_on_recover === 1,
    },
    snapshot,
    guard: { tripped: guard.tripped, below_for_seconds: guard.below_for_seconds },
  });
}

interface PutBody {
  enabled?: boolean;
  pool_token?: string; // plaintext from form; encrypted in updateProfitConfig
  price_source?: string;
  pause_below_minutes?: number;
  resume_margin_pct?: number;
  manual_floor_enabled?: boolean;
  manual_floor_usd?: number;
  running_watts_override?: number;
  notify_on_trip?: boolean;
  notify_on_recover?: boolean;
}

export async function PUT(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as PutBody;
  const patch: ProfitConfigPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.pool_token !== undefined) patch.pool_token = body.pool_token;
  if (body.price_source !== undefined) patch.price_source = body.price_source;
  if (body.pause_below_minutes !== undefined) patch.pause_below_minutes = body.pause_below_minutes;
  if (body.resume_margin_pct !== undefined) patch.resume_margin_pct = body.resume_margin_pct;
  if (body.manual_floor_enabled !== undefined) patch.manual_floor_enabled = body.manual_floor_enabled;
  if (body.manual_floor_usd !== undefined) patch.manual_floor_usd = body.manual_floor_usd;
  if (body.running_watts_override !== undefined)
    patch.running_watts_override = body.running_watts_override;
  if (body.notify_on_trip !== undefined) patch.notify_on_trip = body.notify_on_trip;
  if (body.notify_on_recover !== undefined) patch.notify_on_recover = body.notify_on_recover;
  updateProfitConfig(patch);
  return NextResponse.json({ ok: true });
}
