import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getMiner } from '@/lib/db';
import { testConnection } from '@/lib/braiins-api';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: RouteContext<'/api/miners/[id]/test'>) {
  ensureInitialized();
  const { id } = await ctx.params;
  const m = getMiner(parseInt(id, 10));
  if (!m) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const result = await testConnection(m);
  return NextResponse.json(result);
}
