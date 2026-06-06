/**
 * Braiins OS+ gRPC client.
 *
 * Talks to BOSer on port 50051 using @grpc/grpc-js + proto-loader.
 * Loads .proto files from ./proto/bos/v1/.
 *
 * Auth flow:
 *   1. Call AuthenticationService.Login(username, password) → returns token + timeout_s.
 *   2. Send token in 'authorization' metadata on every subsequent call.
 *   3. Token validity refreshes with each request; we re-login on UNAUTHENTICATED.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { decrypt } from './crypto';
import type { Miner, MinerStats, HashboardStats } from '@/types';

const PROTO_ROOT = path.resolve(process.cwd(), 'proto');
const PROTO_FILES = [
  'bos/v1/authentication.proto',
  'bos/v1/actions.proto',
  'bos/v1/miner.proto',
  'bos/v1/performance.proto',
  'bos/v1/pool.proto',
  'bos/v1/common.proto',
  'bos/v1/units.proto',
  'bos/v1/work.proto',
  'bos/v1/cooling.proto',
];

/**
 * HMR-safe caches. Without these, every dev rebuild would:
 *   - Re-parse all proto files (heavy)
 *   - Create new gRPC clients (each holds an HTTP/2 connection + state)
 *   - Lose tokens, forcing re-login
 * Anchoring on globalThis means we share one set across reloads.
 */
interface BosServices {
  auth: grpc.Client;
  actions: grpc.Client;
  miner: grpc.Client;
}
interface TokenCacheEntry {
  token: string;
  expires_at: number;
}
interface ApiCache {
  proto: grpc.GrpcObject | null;
  services: Map<string, BosServices>;
  tokens: Map<string, TokenCacheEntry>;
}
const g = globalThis as unknown as { __homerigApi?: ApiCache };
const cache: ApiCache =
  g.__homerigApi ??
  (g.__homerigApi = { proto: null, services: new Map(), tokens: new Map() });

function loadProto(): grpc.GrpcObject {
  if (cache.proto) return cache.proto;
  const pkgDef = protoLoader.loadSync(PROTO_FILES, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });
  cache.proto = grpc.loadPackageDefinition(pkgDef);
  return cache.proto;
}

function servicesKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function getServices(host: string, port: number): BosServices {
  const key = servicesKey(host, port);
  const existing = cache.services.get(key);
  if (existing) return existing;
  const proto = loadProto();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns: any = (proto as any).braiins.bos.v1;
  const target = `${host}:${port}`;
  const creds = grpc.credentials.createInsecure();
  // Keepalive: send pings so idle connections don't get half-closed by NAT/router.
  // Limits keep memory bounded.
  const options: grpc.ChannelOptions = {
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_receive_message_length': 4 * 1024 * 1024,
    'grpc.max_send_message_length': 1 * 1024 * 1024,
  };
  const services: BosServices = {
    auth: new ns.AuthenticationService(target, creds, options),
    actions: new ns.ActionsService(target, creds, options),
    miner: new ns.MinerService(target, creds, options),
  };
  cache.services.set(key, services);
  return services;
}

/** Close all cached gRPC clients. Useful on shutdown. */
export function closeAllClients() {
  for (const s of cache.services.values()) {
    try { s.auth.close(); } catch {}
    try { s.actions.close(); } catch {}
    try { s.miner.close(); } catch {}
  }
  cache.services.clear();
}

function callUnary<TReq, TRes>(
  client: grpc.Client,
  method: string,
  request: TReq,
  metadata: grpc.Metadata,
  timeoutMs: number
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)[method](
      request,
      metadata,
      { deadline },
      (err: grpc.ServiceError | null, response: TRes) => {
        if (err) reject(err);
        else resolve(response);
      }
    );
  });
}

function tokenKey(miner: Miner): string {
  return `${miner.id}:${miner.ip}:${miner.username}`;
}

async function getToken(miner: Miner, services: BosServices, timeoutMs: number): Promise<string> {
  const key = tokenKey(miner);
  const cached = cache.tokens.get(key);
  if (cached && cached.expires_at > Date.now() + 5_000) {
    return cached.token;
  }
  const password = miner.password_encrypted ? decrypt(miner.password_encrypted) : '';
  interface LoginResponse {
    token: string;
    timeoutS?: number;
    timeout_s?: number;
  }
  const resp = await callUnary<{ username: string; password: string }, LoginResponse>(
    services.auth,
    'Login',
    { username: miner.username, password },
    new grpc.Metadata(),
    timeoutMs
  );
  const timeout_s = resp.timeoutS ?? resp.timeout_s ?? 600;
  cache.tokens.set(key, { token: resp.token, expires_at: Date.now() + timeout_s * 1000 });
  return resp.token;
}

function authMetadata(token: string): grpc.Metadata {
  const md = new grpc.Metadata();
  md.set('authorization', token);
  return md;
}

async function withAuth<T>(
  miner: Miner,
  timeoutMs: number,
  fn: (services: BosServices, md: grpc.Metadata) => Promise<T>
): Promise<T> {
  // NOTE: services are cached per host:port — do NOT close them here.
  // Closing on every call was leaking HTTP/2 connections in dev under HMR.
  const services = getServices(miner.ip, miner.grpc_port);
  try {
    const token = await getToken(miner, services, timeoutMs);
    return await fn(services, authMetadata(token));
  } catch (err) {
    const code = (err as grpc.ServiceError).code;
    if (code === grpc.status.UNAUTHENTICATED || code === grpc.status.PERMISSION_DENIED) {
      cache.tokens.delete(tokenKey(miner));
      const token = await getToken(miner, services, timeoutMs);
      return await fn(services, authMetadata(token));
    }
    throw err;
  }
}

// ----- Public API -----

export async function pauseMining(miner: Miner, timeoutMs = 5000): Promise<{ alreadyPaused: boolean }> {
  return withAuth(miner, timeoutMs, async (services, md) => {
    interface Resp { alreadyPaused?: boolean; already_paused?: boolean }
    const resp = await callUnary<Record<string, never>, Resp>(
      services.actions,
      'PauseMining',
      {},
      md,
      timeoutMs
    );
    return { alreadyPaused: Boolean(resp.alreadyPaused ?? resp.already_paused) };
  });
}

export async function resumeMining(
  miner: Miner,
  timeoutMs = 5000
): Promise<{ alreadyMining: boolean }> {
  return withAuth(miner, timeoutMs, async (services, md) => {
    interface Resp { alreadyMining?: boolean; already_mining?: boolean }
    const resp = await callUnary<Record<string, never>, Resp>(
      services.actions,
      'ResumeMining',
      {},
      md,
      timeoutMs
    );
    return { alreadyMining: Boolean(resp.alreadyMining ?? resp.already_mining) };
  });
}

export async function restartMining(miner: Miner, timeoutMs = 5000): Promise<void> {
  return withAuth(miner, timeoutMs, async (services, md) => {
    await callUnary(services.actions, 'Restart', {}, md, timeoutMs);
  });
}

export async function rebootMiner(miner: Miner, timeoutMs = 10000): Promise<void> {
  return withAuth(miner, timeoutMs, async (services, md) => {
    await callUnary(services.actions, 'Reboot', {}, md, timeoutMs);
  });
}

/**
 * Fetch live stats for a single miner.
 * Returns offline status with an error message if the miner is unreachable.
 */
export async function getMinerStats(miner: Miner, timeoutMs = 5000): Promise<MinerStats> {
  const fetched_at = new Date().toISOString();
  try {
    return await withAuth(miner, timeoutMs, async (services, md) => {
      // NOTE on status detection: the proto has a GetMinerStatus RPC with a clean
      // MinerStatus enum, but it isn't implemented on every BOSer build (e.g. the
      // 0.1.0-db69f9bc / API 3.7 build on this rig hangs instead of returning an
      // 'UNIMPLEMENTED' error). We use a hashrate-based heuristic instead — see
      // status detection block below. If a future BOSer fixes this we can switch
      // back to GetMinerStatus cleanly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [details, stats, hashboardsResp] = await Promise.all([
        callUnary<Record<string, never>, any>(services.miner, 'GetMinerDetails', {}, md, timeoutMs),
        callUnary<Record<string, never>, any>(services.miner, 'GetMinerStats', {}, md, timeoutMs),
        callUnary<Record<string, never>, any>(services.miner, 'GetHashboards', {}, md, timeoutMs),
      ]);

      // ---- Hashrate windows ----
      // For DISPLAY we prefer last_5m (smoothed, matches what miner UIs show).
      // For STATUS detection we use ghsInstant (last_5s) because the 5m window
      // stays elevated for ~5 minutes after a PauseMining call — long enough
      // for the scheduler to misclassify a paused miner as still mining and
      // skip the Resume command. This was the cause of "scheduler resumed plug
      // but didn't resume miners."
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ghs = (rh: any): number => {
        if (!rh) return 0;
        const win = rh.last5m ?? rh.last_5m ?? rh.last1m ?? rh.last_1m ?? rh.last30s ?? rh.last_30s;
        return Number(win?.gigahashPerSecond ?? win?.gigahash_per_second ?? 0);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ghsInstant = (rh: any): number => {
        if (!rh) return 0;
        const win =
          rh.last5s ?? rh.last_5s ?? rh.last15s ?? rh.last_15s ?? rh.last30s ?? rh.last_30s ?? rh.last1m ?? rh.last_1m;
        return Number(win?.gigahashPerSecond ?? win?.gigahash_per_second ?? 0);
      };
      const minerStats = stats.minerStats ?? stats.miner_stats ?? {};
      const hashrate_th = ghs(minerStats.realHashrate ?? minerStats.real_hashrate) / 1000;
      const hashrate_th_instant =
        ghsInstant(minerStats.realHashrate ?? minerStats.real_hashrate) / 1000;

      const poolStats = stats.poolStats ?? stats.pool_stats ?? {};
      const acceptedShares =
        poolStats.acceptedShares?.number ?? poolStats.accepted_shares?.number ?? null;
      const rejectedShares =
        poolStats.rejectedShares?.number ?? poolStats.rejected_shares?.number ?? null;

      const power = stats.powerStats ?? stats.power_stats ?? {};
      const approxConsumption =
        power.approximatedConsumption?.watt ?? power.approximated_consumption?.watt ?? null;

      const uptime =
        details.bosminerUptimeS ?? details.bosminer_uptime_s ?? details.systemUptimeS ?? null;

      const hashboards = (hashboardsResp.hashboards ?? []) as Array<Record<string, unknown>>;
      // Track instant board hashrate alongside the displayed (smoothed) value
      // so status detection isn't fooled by smoothing lag after a Pause.
      let totalBoardHrInstant = 0;
      const boardStats: HashboardStats[] = hashboards.map((hb, idx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const h = hb as any;
        const board_hr = ghs(h.stats?.realHashrate ?? h.stats?.real_hashrate) / 1000;
        const board_hr_instant =
          ghsInstant(h.stats?.realHashrate ?? h.stats?.real_hashrate) / 1000;
        totalBoardHrInstant += board_hr_instant;
        const chipSensor = h.highestChipTemp ?? h.highest_chip_temp;
        const chipTemp = Number(
          chipSensor?.temperature?.degreeC ?? chipSensor?.temperature?.degree_c ?? 0
        );
        const chipSensorIdRaw = chipSensor?.id;
        const chipSensorId =
          chipSensorIdRaw == null || chipSensorIdRaw === ''
            ? null
            : Number(
                typeof chipSensorIdRaw === 'object' ? chipSensorIdRaw.value : chipSensorIdRaw
              );
        const boardTemp = Number(h.boardTemp?.degreeC ?? h.board_temp?.degree_c ?? 0);
        const inletTemp = Number(
          h.lowestInletTemp?.degreeC ?? h.lowest_inlet_temp?.degree_c ?? 0
        );
        const outletTemp = Number(
          h.highestOutletTemp?.degreeC ?? h.highest_outlet_temp?.degree_c ?? 0
        );
        const chipsCountWrapped = h.chipsCount ?? h.chips_count;
        const chipsCount =
          typeof chipsCountWrapped === 'object' && chipsCountWrapped !== null
            ? Number(chipsCountWrapped.value ?? 0)
            : Number(chipsCountWrapped ?? 0);
        return {
          id: Number(h.id ?? idx + 1),
          hashrate_th: board_hr,
          temp_chip: chipTemp,
          temp_board: boardTemp,
          temp_inlet: inletTemp || boardTemp, // fallback if inlet sensor not reported
          temp_outlet: outletTemp || boardTemp,
          chip_sensor_id: Number.isFinite(chipSensorId as number) ? (chipSensorId as number) : null,
          chips_count: chipsCount,
          enabled: Boolean(h.enabled),
        };
      });

      // ---- Status detection (heuristic) ----
      // After PauseMining, BOSer's bosminer stays alive but stops processing work.
      // The 5m smoothed hashrate drops slowly; the instant (5s) window drops within
      // seconds. We use the INSTANT value so a paused miner is detected as paused
      // within ~10 seconds of the pause command, not 5 minutes.
      //
      // Cross-check with miner-level instant hashrate too — if EITHER board sum or
      // overall instant hashrate shows activity, treat as mining (defensive). This
      // avoids the inverse failure of treating a briefly-stuttering miner as paused.
      const minimumActiveTh = 1; // 1 TH/s threshold (vs nominal ~250 TH/s)
      const isMining =
        totalBoardHrInstant >= minimumActiveTh || hashrate_th_instant >= minimumActiveTh;
      const status: MinerStats['status'] = isMining ? 'mining' : 'paused';

      return {
        minerId: miner.id,
        status,
        hashrate_th,
        power_w: approxConsumption !== null ? Number(approxConsumption) : null,
        uptime_s: uptime !== null ? Number(uptime) : null,
        hashboards: boardStats,
        pool_url: null,
        pool_user: null,
        shares_accepted: acceptedShares !== null ? Number(acceptedShares) : null,
        shares_rejected: rejectedShares !== null ? Number(rejectedShares) : null,
        fetched_at,
      };
    });
  } catch (err) {
    return {
      minerId: miner.id,
      status: 'offline',
      hashrate_th: 0,
      power_w: null,
      uptime_s: null,
      hashboards: [],
      pool_url: null,
      pool_user: null,
      shares_accepted: null,
      shares_rejected: null,
      fetched_at,
      error: (err as Error).message,
    };
  }
}

/** Probe connectivity + auth — used by Test Connection in Settings. */
export async function testConnection(
  miner: Miner,
  timeoutMs = 5000
): Promise<{ ok: true; details: { hashrate_th: number; status: string } } | { ok: false; error: string }> {
  try {
    const s = await getMinerStats(miner, timeoutMs);
    if (s.status === 'offline') {
      return { ok: false, error: s.error ?? 'Unknown error' };
    }
    return { ok: true, details: { hashrate_th: s.hashrate_th, status: s.status } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
