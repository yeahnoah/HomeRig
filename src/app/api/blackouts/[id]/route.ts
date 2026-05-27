import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { updateBlackout, deleteBlackout, getBlackout } from '@/lib/db';
import type { BlackoutInput } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/blackouts/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const b = getBlackout(parseInt(id, 10));
  if (!b) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ blackout: b });
}

export async function PUT(req: NextRequest, ctx: RouteContext<'/api/blackouts/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const body = (await req.json()) as Partial<BlackoutInput>;
  const updated = updateBlackout(parseInt(id, 10), body);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ blackout: updated });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/blackouts/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  deleteBlackout(parseInt(id, 10));
  return NextResponse.json({ ok: true });
}
