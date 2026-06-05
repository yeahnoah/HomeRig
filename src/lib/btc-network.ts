/**
 * Bitcoin network stats (difficulty / hashrate) for the profitability projection.
 *
 * Keyless public feeds:
 *   - mempool.space: GET /api/v1/mining/hashrate/3d
 *       → { currentHashrate (H/s), currentDifficulty, ... }
 *   - blockchain.info fallback:
 *       GET /q/hashrate     → network hashrate in GH/s (plain number)
 *       GET /q/getblockcount, /q/getdifficulty
 *
 * Used to estimate "BTC mined per day" for a given hashrate WITHOUT relying on
 * the pool's recent reward (which is noisy and reflects our own uptime). This
 * gives the projection a clean, full-runtime baseline that we then decay with a
 * user-set difficulty-growth assumption.
 *
 * Cached ~30min — network hashrate moves slowly and this only seeds a model.
 */

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Current block subsidy in BTC (post-2024 halving; next halving ~2028). */
export const CURRENT_BLOCK_SUBSIDY_BTC = 3.125;
const BLOCKS_PER_DAY = 144;

export interface NetworkStats {
  /** Total network hashrate in TH/s. */
  network_ths: number;
  /** Network difficulty (unitless), if available. */
  difficulty: number | null;
  source: 'mempool' | 'blockchain.info';
}

interface Cache {
  value: NetworkStats | null;
  at: number;
}
const g = globalThis as unknown as { __homerigNet?: Cache };
const cache: Cache = g.__homerigNet ?? (g.__homerigNet = { value: null, at: 0 });

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

async function getText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fromMempool(): Promise<NetworkStats | null> {
  const data = (await getJson('https://mempool.space/api/v1/mining/hashrate/3d')) as {
    currentHashrate?: number; // H/s
    currentDifficulty?: number;
  };
  const hs = data?.currentHashrate;
  if (!hs || !Number.isFinite(hs)) return null;
  return {
    network_ths: hs / 1e12,
    difficulty: Number.isFinite(data?.currentDifficulty ?? NaN) ? (data!.currentDifficulty as number) : null,
    source: 'mempool',
  };
}

async function fromBlockchainInfo(): Promise<NetworkStats | null> {
  // /q/hashrate returns network hashrate in GH/s.
  const ghs = parseFloat(await getText('https://blockchain.info/q/hashrate'));
  if (!Number.isFinite(ghs) || ghs <= 0) return null;
  let difficulty: number | null = null;
  try {
    const d = parseFloat(await getText('https://blockchain.info/q/getdifficulty'));
    if (Number.isFinite(d)) difficulty = d;
  } catch {
    /* difficulty optional */
  }
  return { network_ths: ghs / 1000, difficulty, source: 'blockchain.info' };
}

/** Current network stats, cached. Returns null only if every source fails. */
export async function getNetworkStats(): Promise<NetworkStats | null> {
  if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  for (const fetcher of [fromMempool, fromBlockchainInfo]) {
    try {
      const v = await fetcher();
      if (v) {
        cache.value = v;
        cache.at = Date.now();
        return v;
      }
    } catch (err) {
      console.error('[btc-network] source failed:', (err as Error).message);
    }
  }
  return cache.value; // stale-but-better-than-nothing, or null
}

/**
 * Expected BTC mined per day for `ths` TH/s against a network of `networkThs`
 * TH/s, at the given block subsidy. Pure FPPS-style expectation (ignores fees
 * and pool fee — close enough for a planning model).
 */
export function expectedBtcPerDay(
  ths: number,
  networkThs: number,
  subsidy: number = CURRENT_BLOCK_SUBSIDY_BTC
): number {
  if (!ths || !networkThs || networkThs <= 0) return 0;
  return (ths / networkThs) * BLOCKS_PER_DAY * subsidy;
}
