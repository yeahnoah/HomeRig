import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { testPoolToken } from '@/lib/braiins-pool';
import { getProfitConfig } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

/**
 * Verify a Braiins Pool token can read the account stats. Accepts a token typed
 * but not yet saved; falls back to the stored (decrypted) token otherwise.
 */
export async function POST(req: NextRequest) {
  ensureInitialized();
  let body: { token?: string } | null = null;
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    // empty body — fall back to saved token
  }

  let token = body?.token ?? '';
  if (!token) {
    const cfg = getProfitConfig();
    if (cfg.pool_token_encrypted) {
      try {
        token = decrypt(cfg.pool_token_encrypted);
      } catch {
        token = '';
      }
    }
  }
  if (!token) {
    return NextResponse.json({ ok: false, error: 'No pool token provided' }, { status: 400 });
  }

  const result = await testPoolToken(token);
  if (!result.ok) return NextResponse.json(result, { status: 502 });
  return NextResponse.json({
    ok: true,
    hashrate_ths: result.stats.hashrate_ths,
    ok_workers: result.stats.ok_workers,
  });
}
