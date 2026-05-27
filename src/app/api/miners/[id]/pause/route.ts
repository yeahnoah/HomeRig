import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getMiner, logEvent } from '@/lib/db';
import { pauseMining } from '@/lib/braiins-api';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: RouteContext<'/api/miners/[id]/pause'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const miner = getMiner(parseInt(id, 10));
  if (!miner) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const result = await pauseMining(miner);
    logEvent({ miner_id: miner.id, action: 'pause', source: 'manual:UI', result: 'success', detail: null });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    logEvent({ miner_id: miner.id, action: 'pause', source: 'manual:UI', result: 'error', detail: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
