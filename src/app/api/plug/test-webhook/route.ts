import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { testWebhook } from '@/lib/alerts';
import { getPlugConfig } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  ensureInitialized();
  // Allow the user to test a URL they've typed but not saved yet.
  let body: { url?: string } | null = null;
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    // empty body — fall back to saved URL
  }
  const url = body?.url ?? getPlugConfig().alert_webhook_url;
  if (!url) {
    return NextResponse.json({ ok: false, error: 'No webhook URL provided' }, { status: 400 });
  }
  const result = await testWebhook(url);
  return NextResponse.json(result);
}
