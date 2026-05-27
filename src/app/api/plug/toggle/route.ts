import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { setPower } from '@/lib/ha-plug';
import { logEvent } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as { on: boolean };
  try {
    await setPower(body.on);
    logEvent({
      miner_id: null,
      action: body.on ? 'plug_on' : 'plug_off',
      source: 'manual:UI',
      result: 'success',
      detail: null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    logEvent({
      miner_id: null,
      action: body.on ? 'plug_on' : 'plug_off',
      source: 'manual:UI',
      result: 'error',
      detail: msg,
    });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
