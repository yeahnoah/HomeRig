import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { ping } from '@/lib/ha-plug';

export const dynamic = 'force-dynamic';

interface TestBody {
  ha_url?: string;
  ha_token?: string;
  ha_entity_id?: string;
}

export async function POST(req: NextRequest) {
  ensureInitialized();
  // Optional inline-test mode: try with values from the body before saving.
  let body: TestBody | null = null;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    // Body may be empty when the user just wants to test saved config.
  }
  const result = await ping(body ?? undefined);
  return NextResponse.json(result);
}
