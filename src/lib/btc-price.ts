/**
 * Live BTC/USD spot price.
 *
 * Keyless public feeds, so no credentials to manage:
 *   - Coinbase: GET /v2/prices/BTC-USD/spot → { data: { amount: "67000.12" } }
 *   - Kraken:   GET /0/public/Ticker?pair=XBTUSD → { result: { XXBTZUSD: { c: ["67000.1", ...] } } }
 *
 * The configured source is tried first; the other is used as a fallback so a
 * single provider hiccup doesn't blind the profitability guard. Cached briefly
 * (prices move, but not faster than the scheduler tick).
 *
 * Returns null when BOTH sources fail — callers MUST treat null as "don't act"
 * (fail safe: never pause the rig on a missing price).
 */

const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 60 * 1000;

export type PriceSource = 'coinbase' | 'kraken';

interface Cache {
  price: number | null;
  at: number;
}
const g = globalThis as unknown as { __homerigPrice?: Cache };
const cache: Cache = g.__homerigPrice ?? (g.__homerigPrice = { price: null, at: 0 });

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromCoinbase(): Promise<number | null> {
  const data = (await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot')) as {
    data?: { amount?: string };
  };
  const amount = parseFloat(data?.data?.amount ?? '');
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

async function fromKraken(): Promise<number | null> {
  const data = (await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')) as {
    result?: Record<string, { c?: string[] }>;
  };
  const pair = data?.result ? Object.values(data.result)[0] : undefined;
  const last = parseFloat(pair?.c?.[0] ?? '');
  return Number.isFinite(last) && last > 0 ? last : null;
}

const FETCHERS: Record<PriceSource, () => Promise<number | null>> = {
  coinbase: fromCoinbase,
  kraken: fromKraken,
};

/**
 * Current BTC/USD spot price. Tries the configured source first, then the other.
 * Cached for CACHE_TTL_MS. Returns null only when every source fails (and there
 * is no fresh cached value to fall back on).
 */
export async function getBtcPriceUsd(source: PriceSource = 'coinbase'): Promise<number | null> {
  if (cache.price != null && Date.now() - cache.at < CACHE_TTL_MS) return cache.price;

  const order: PriceSource[] = source === 'kraken' ? ['kraken', 'coinbase'] : ['coinbase', 'kraken'];
  for (const s of order) {
    try {
      const p = await FETCHERS[s]();
      if (p != null) {
        cache.price = p;
        cache.at = Date.now();
        return p;
      }
    } catch (err) {
      console.error(`[btc-price] ${s} failed:`, (err as Error).message);
    }
  }
  // Both failed. Prefer a slightly-stale cached price over null if we have one.
  return cache.price;
}
