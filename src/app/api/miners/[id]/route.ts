import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getMiner, updateMiner, deleteMiner } from '@/lib/db';
import type { MinerInput } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/miners/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const m = getMiner(parseInt(id, 10));
  if (!m) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { password_encrypted: _password_encrypted, ...safe } = m;
  return NextResponse.json({ miner: { ...safe, has_password: Boolean(_password_encrypted) } });
}

export async function PUT(req: NextRequest, ctx: RouteContext<'/api/miners/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const body = (await req.json()) as Partial<MinerInput>;
  const updated = updateMiner(parseInt(id, 10), body);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { password_encrypted: _password_encrypted, ...safe } = updated;
  return NextResponse.json({ miner: safe });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/miners/[id]'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  deleteMiner(parseInt(id, 10));
  return NextResponse.json({ ok: true });
}
