import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { listBlackouts, createBlackout } from '@/lib/db';
import type { BlackoutInput } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureInitialized();
  return NextResponse.json({ blackouts: listBlackouts() });
}

export async function POST(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as BlackoutInput;
  if (!body.label) {
    return NextResponse.json({ error: 'Label is required' }, { status: 400 });
  }
  if (!Array.isArray(body.time_ranges) || body.time_ranges.length === 0) {
    return NextResponse.json({ error: 'At least one time range is required' }, { status: 400 });
  }
  for (const r of body.time_ranges) {
    if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) {
      return NextResponse.json({ error: 'Time range must be HH:MM' }, { status: 400 });
    }
  }
  try {
    const created = createBlackout(body);
    return NextResponse.json({ blackout: created }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
