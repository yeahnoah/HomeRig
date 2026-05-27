import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getMiner, logEvent } from '@/lib/db';
import { resumeMining } from '@/lib/braiins-api';
import { gateForResume } from '@/lib/safety-gate';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: RouteContext<'/api/miners/[id]/resume'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const miner = getMiner(parseInt(id, 10));
  if (!miner) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Safety: ensure the plug is ON before allowing miners to draw heat.
  // If mirror is enabled, this also auto-turns-on the plug to avoid deadlock.
  const gate = await gateForResume();
  if (!gate.ok) {
    logEvent({
      miner_id: miner.id,
      action: 'resume',
      source: 'manual:UI',
      result: 'error',
      detail: gate.error,
    });
    return NextResponse.json({ ok: false, error: gate.error, code: gate.code }, { status: gate.status });
  }

  try {
    const result = await resumeMining(miner);
    logEvent({
      miner_id: miner.id,
      action: 'resume',
      source: 'manual:UI',
      result: 'success',
      detail: gate.note ?? null,
    });
    return NextResponse.json({ ok: true, ...result, ...(gate.note ? { note: gate.note } : {}) });
  } catch (err) {
    const msg = (err as Error).message;
    logEvent({ miner_id: miner.id, action: 'resume', source: 'manual:UI', result: 'error', detail: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
