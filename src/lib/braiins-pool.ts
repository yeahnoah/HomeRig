/**
 * Braiins Pool reward client.
 *
 * IMPORTANT: this talks to the POOL (pool.braiins.com), not the miner firmware.
 * Braiins OS+ (the firmware we reach over gRPC) is a separate system; payout
 * data lives on the pool side. This client fetches the pool-reported hashrate
 * and FPPS rewards so we can estimate BTC mined per day for the profitability
 * guard.
 *
 * Auth: a pool access-profile token in the `Pool-Auth-Token` header. (The pool
 * was formerly "Slush Pool"; we also send the legacy `SlushPool-Auth-Token`
 * header so older token scopes keep working — extra headers are harmless.)
 *
 * Endpoints:
 *   GET /stats/json/btc/             — live hashrate + reward summary
 *   GET /accounts/rewards/json/btc/  — daily reward history (FPPS)
 *
 * Because Braiins pays FPPS, the daily reward is smooth and predictable — far
 * better for break-even math than a theoretical hashrate × difficulty estimate.
 * We still expose the hashrate so callers can fall back to a formula if the
 * pool is unreachable.
 */

const BASE = 'https://pool.braiins.com';
const TIMEOUT_MS = 8000;
// Pool rewards barely move minute-to-minute (FPPS), so cache aggressively to
// avoid hammering the pool API on every scheduler tick.
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PoolStats {
  /** Combined account hashrate over the trailing 24h, normalized to TH/s. */
  hashrate_ths: number;
  ok_workers: number | null;
  /** Reward accrued so far today (BTC), if reported. */
  today_reward_btc: number | null;
  /** Pool's projection for the current round/day (BTC), if reported. */
  estimated_reward_btc: number | null;
}

export interface BtcPerDay {
  /** Estimated BTC mined per 24h. */
  btc_per_day: number;
  /** Which signal produced the estimate. */
  method: 'daily_reward' | 'estimated_reward' | 'today_scaled';
  /** Trailing-24h hashrate in TH/s (0 if unknown). */
  hashrate_ths: number;
}

interface Cache {
  perDay: { value: BtcPerDay | null; at: number; tokenHash: string } | null;
}
const g = globalThis as unknown as { __homerigPool?: Cache };
const cache: Cache = g.__homerigPool ?? (g.__homerigPool = { perDay: null });

/** Cheap non-cryptographic fingerprint so a token change busts the cache. */
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

function headers(token: string): Record<string, string> {
  return {
    'Pool-Auth-Token': token,
    'SlushPool-Auth-Token': token,
    Accept: 'application/json',
  };
}

async function getJson(path: string, token: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: headers(token),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`pool ${path} → HTTP ${resp.status} ${await resp.text().catch(() => '')}`.trim());
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a possibly-string numeric field; returns null if not finite. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a hashrate value + Braiins unit string ("Gh/s", "Th/s", "Ph/s", ...)
 * into TH/s. Defaults to treating a bare number as already-TH/s.
 */
function toThs(value: number | null, unit: unknown): number {
  if (value == null) return 0;
  const u = String(unit ?? 'Th/s').toLowerCase();
  if (u.startsWith('ph')) return value * 1000;
  if (u.startsWith('th')) return value;
  if (u.startsWith('gh')) return value / 1000;
  if (u.startsWith('mh')) return value / 1_000_000;
  if (u.startsWith('eh')) return value * 1_000_000;
  return value;
}

/** Fetch the live /stats summary for the BTC account. */
export async function fetchPoolStats(token: string): Promise<PoolStats> {
  const data = (await getJson('/stats/json/btc/', token)) as Record<string, unknown>;
  // Shape: { btc: { hash_rate_24h, hash_rate_unit, ok_workers, today_reward, estimated_reward, ... } }
  const btc = (data.btc ?? data) as Record<string, unknown>;
  const unit = btc.hash_rate_unit;
  return {
    hashrate_ths: toThs(num(btc.hash_rate_24h) ?? num(btc.hash_rate_5m), unit),
    ok_workers: num(btc.ok_workers),
    today_reward_btc: num(btc.today_reward),
    estimated_reward_btc: num(btc.estimated_reward),
  };
}

interface DailyReward {
  /** Unix seconds for the reward day. */
  date: number;
  total_reward_btc: number;
}

/** Fetch daily reward history (most recent first), if the endpoint is available. */
async function fetchDailyRewards(token: string): Promise<DailyReward[]> {
  const data = (await getJson('/accounts/rewards/json/btc/', token)) as Record<string, unknown>;
  const btc = (data.btc ?? data) as Record<string, unknown>;
  const raw = btc.daily_rewards;
  if (!Array.isArray(raw)) return [];
  const out: DailyReward[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const date = num(r.date);
    const total = num(r.total_reward) ?? num(r.reward);
    if (date != null && total != null) out.push({ date, total_reward_btc: total });
  }
  // Sort newest-first so [0] is the latest entry.
  out.sort((a, b) => b.date - a.date);
  return out;
}

/**
 * Estimate BTC mined per day. Strategy, best → fallback:
 *   1. Last COMPLETE day's reward from the daily history (most accurate FPPS).
 *   2. The pool's estimated_reward projection.
 *   3. today_reward scaled up by the fraction of the day elapsed.
 *
 * Cached for CACHE_TTL_MS. Returns null only if the pool is unreachable or
 * reports nothing usable.
 */
export async function getBtcPerDay(token: string, now: Date = new Date()): Promise<BtcPerDay | null> {
  if (!token) return null;
  const fp = fingerprint(token);
  const cached = cache.perDay;
  if (cached && cached.tokenHash === fp && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  let result: BtcPerDay | null = null;
  try {
    const stats = await fetchPoolStats(token);

    // 1. Most recent complete day from history.
    try {
      const daily = await fetchDailyRewards(token);
      // Skip today's partial entry: take the first entry whose day is before
      // the current UTC day. Daily timestamps are at UTC midnight.
      const todayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
      const lastComplete = daily.find((d) => d.date < todayStart);
      if (lastComplete && lastComplete.total_reward_btc > 0) {
        result = {
          btc_per_day: lastComplete.total_reward_btc,
          method: 'daily_reward',
          hashrate_ths: stats.hashrate_ths,
        };
      }
    } catch {
      /* daily endpoint optional — fall through */
    }

    // 2. Pool's own projection.
    if (!result && stats.estimated_reward_btc && stats.estimated_reward_btc > 0) {
      result = {
        btc_per_day: stats.estimated_reward_btc,
        method: 'estimated_reward',
        hashrate_ths: stats.hashrate_ths,
      };
    }

    // 3. Scale today's partial reward by elapsed fraction of the UTC day.
    if (!result && stats.today_reward_btc && stats.today_reward_btc > 0) {
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const elapsedFrac = Math.max(0.01, (now.getTime() - dayStart) / 86_400_000);
      result = {
        btc_per_day: stats.today_reward_btc / elapsedFrac,
        method: 'today_scaled',
        hashrate_ths: stats.hashrate_ths,
      };
    }
  } catch (err) {
    console.error('[braiins-pool] getBtcPerDay failed:', (err as Error).message);
    // On error, return the last good cached value if we have one (better than
    // nothing), else null. Don't overwrite the cache with the failure.
    return cached?.tokenHash === fp ? cached.value : null;
  }

  cache.perDay = { value: result, at: Date.now(), tokenHash: fp };
  return result;
}

/** Used by the Settings "Test token" button. Verifies the token can read /stats. */
export async function testPoolToken(token: string): Promise<{ ok: true; stats: PoolStats } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: 'No pool token provided' };
  try {
    const stats = await fetchPoolStats(token);
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
