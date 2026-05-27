import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { createMiner } from '@/lib/db';
import type { MinerInput } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as MinerInput;
  if (!body.name || !body.ip || !body.username) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const created = createMiner(body);
  const { password_encrypted: _password_encrypted, ...safe } = created;
  return NextResponse.json({ miner: safe }, { status: 201 });
}
