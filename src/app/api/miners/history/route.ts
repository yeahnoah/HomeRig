import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getStatsHistory, listMiners } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Returns history grouped by miner for the requested window.
 *
 *   GET /api/miners/history?minutes=60[&miner_id=1]
 *
 * Default 60 minutes. Cap is 7 days to bound query cost.
 */
export async function GET(req: NextRequest) {
  ensureInitialized();
  const { searchParams } = new URL(req.url);
  const minutes = parseInt(searchParams.get('minutes') ?? '60', 10);
  const minerIdParam = searchParams.get('miner_id');
  const minerIdFilter = minerIdParam ? parseInt(minerIdParam, 10) : undefined;

  const miners = listMiners();
  const minerMap = new Map(miners.map((m) => [m.id, m.name]));

  const rows = getStatsHistory({ miner_id: minerIdFilter, minutes });

  // Group by miner for client convenience.
  const byMiner = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!byMiner.has(r.miner_id)) byMiner.set(r.miner_id, []);
    byMiner.get(r.miner_id)!.push(r);
  }

  const series = Array.from(byMiner.entries()).map(([miner_id, points]) => ({
    miner_id,
    name: minerMap.get(miner_id) ?? `Miner ${miner_id}`,
    points: points.map((p) => ({
      ts: p.ts,
      hashrate_th: p.hashrate_th,
      power_w: p.power_w,
      max_chip_temp: p.max_chip_temp,
      status: p.status,
    })),
  }));

  return NextResponse.json({ minutes, series });
}
