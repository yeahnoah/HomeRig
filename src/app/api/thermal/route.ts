import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import {
  getThermalConfig,
  updateThermalConfig,
  type ThermalConfigPatch,
  type FaultySensor,
} from '@/lib/thermal-guard';
import { getThermalState } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureInitialized();
  return NextResponse.json({
    config: getThermalConfig(),
    state: getThermalState(),
  });
}

interface PutBody {
  enabled?: boolean;
  chip_ceiling_c?: number;
  board_ceiling_c?: number;
  reset_margin_c?: number;
  /** Replace the whole faulty-sensor list. */
  faulty?: FaultySensor[];
  /** Convenience: flip one board's faulty flag without sending the whole list. */
  toggle_faulty?: { miner_id: number; board_id: number };
}

export async function PUT(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as PutBody;
  const patch: ThermalConfigPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.chip_ceiling_c !== undefined) patch.chip_ceiling_c = body.chip_ceiling_c;
  if (body.board_ceiling_c !== undefined) patch.board_ceiling_c = body.board_ceiling_c;
  if (body.reset_margin_c !== undefined) patch.reset_margin_c = body.reset_margin_c;
  if (body.faulty !== undefined) patch.faulty = body.faulty;

  if (body.toggle_faulty) {
    const { miner_id, board_id } = body.toggle_faulty;
    const cur = getThermalConfig().faulty;
    const exists = cur.some((f) => f.miner_id === miner_id && f.board_id === board_id);
    patch.faulty = exists
      ? cur.filter((f) => !(f.miner_id === miner_id && f.board_id === board_id))
      : [...cur, { miner_id, board_id }];
  }

  updateThermalConfig(patch);
  return NextResponse.json({ ok: true, config: getThermalConfig() });
}
