import { NextResponse } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { pollAllMiners } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function POST() {
  ensureInitialized();
  const stats = await pollAllMiners();
  return NextResponse.json({ stats });
}
