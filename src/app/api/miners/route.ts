import { NextResponse } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { listMiners } from '@/lib/db';
import { getLatestStats } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureInitialized();
  const miners = listMiners();
  const stats = new Map(getLatestStats().map((s) => [s.minerId, s]));
  return NextResponse.json({
    miners: miners.map((m) => ({
      id: m.id,
      name: m.name,
      ip: m.ip,
      grpc_port: m.grpc_port,
      username: m.username,
      enabled: m.enabled === 1,
      has_password: Boolean(m.password_encrypted),
      stats: stats.get(m.id) ?? null,
    })),
  });
}
