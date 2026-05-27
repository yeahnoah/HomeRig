/**
 * Scheduler — reconciles miner + plug state to match active blackout windows.
 *
 * Runs every minute. For each enabled miner:
 *   - If any active blackout targets it → ensure it's paused.
 *   - Otherwise → ensure it's running.
 * Then evaluates the plug:
 *   - If plug.mirror_miners and ALL enabled miners are paused → plug off.
 *   - If ANY enabled miner is mining → plug on.
 *
 * This runs alongside a poller that refreshes stats every poll_interval_s.
 * The poller is the source of truth for `latestStats`; the scheduler only
 * issues commands when current state diverges from desired state.
 */

import { Cron } from 'croner';
import {
  getEnabledMiners,
  getEnabledBlackouts,
  getPlugConfig,
  getSettings,
  logEvent,
  insertStatsHistory,
  pruneStatsHistory,
  insertPlugHistory,
  prunePlugHistory,
} from './db';
import { getMinerStats, pauseMining, resumeMining } from './braiins-api';
import {
  setPower as setPlugPower,
  getSafetyState,
  getPlugPowerW,
  getPlugEnergyKwh,
} from './ha-plug';
import { evaluateForMiner } from './blackouts';
import { sendAlert, clearAlertDedup } from './alerts';
import type { Miner, MinerStats } from '@/types';

/**
 * HMR-safe singleton state.
 *
 * In dev, Next.js Turbopack re-evaluates modules on every file change. Without
 * sharing through `globalThis`, each rebuild would: (a) leave the previous
 * scheduler's cron jobs running, (b) build a parallel `latestStats` map, and
 * (c) leak gRPC clients. Within minutes you'd have dozens of pollers all
 * hammering the miners — exactly what crashed the machine before.
 *
 * Anchoring on `globalThis` keeps a single set of timers + maps across reloads.
 */
interface SchedulerState {
  latestStats: Map<number, MinerStats>;
  pollJob: Cron | null;
  reconcileJob: Cron | null;
  started: boolean;
  /** ms epoch when the scheduler last started; used for the startup grace period. */
  startedAt: number;
  /** Count consecutive ticks where the plug safety state was 'unknown'. */
  unknownStateStreak: number;
  /**
   * Track miners we've issued Resume to that returned `alreadyMining: true` but
   * are still showing 0 hashrate. After N consecutive cycles like this we stop
   * retrying and fire an urgent alert — the miner is in a stuck state only the
   * user can resolve (via a manual web-UI reboot).
   */
  stuckResumeStreak: Map<number, number>;
}
const g = globalThis as unknown as { __homerig?: SchedulerState };
const state: SchedulerState =
  g.__homerig ??
  (g.__homerig = {
    latestStats: new Map<number, MinerStats>(),
    pollJob: null,
    reconcileJob: null,
    started: false,
    startedAt: 0,
    unknownStateStreak: 0,
    stuckResumeStreak: new Map(),
  });

// ── Guard tunables ──
const STARTUP_GRACE_MS = 60_000; // skip safety override for 60s after start
const UNKNOWN_STATE_THRESHOLD = 3; // ticks before we trust an 'unknown' plug state
const STUCK_RESUME_THRESHOLD = 3; // ticks of "alreadyMining + 0 hashrate" before alerting

export function getLatestStats(): MinerStats[] {
  return Array.from(state.latestStats.values());
}

export function getLatestStatsFor(minerId: number): MinerStats | undefined {
  return state.latestStats.get(minerId);
}

export function setLatestStats(stats: MinerStats) {
  state.latestStats.set(stats.minerId, stats);
}

// Polls per hour. Used to throttle prune calls so we don't run them every poll.
let pollsSinceLastPrune = 0;
const PRUNE_EVERY_N_POLLS = 60; // ~30min at 30s interval; ~10min at 10s

export async function pollAllMiners(): Promise<MinerStats[]> {
  const miners = getEnabledMiners();
  const settings = getSettings();
  const results = await Promise.all(
    miners.map((m) => getMinerStats(m, settings.connection_timeout_ms))
  );
  for (const r of results) {
    state.latestStats.set(r.minerId, r);
    // Persist a history row for dashboard charts. Skip offline (no signal).
    if (r.status !== 'offline') {
      try {
        const maxChip = r.hashboards.reduce(
          (acc, b) => (b.temp_chip > acc ? b.temp_chip : acc),
          0
        );
        insertStatsHistory({
          miner_id: r.minerId,
          hashrate_th: r.hashrate_th,
          power_w: r.power_w,
          max_chip_temp: maxChip > 0 ? maxChip : null,
          status: r.status,
        });
      } catch (err) {
        console.error('[poll] failed to write history:', err);
      }
    }
  }
  // Sample the plug's electricity meter on the same cadence. Run in parallel
  // with the miner polls would be ideal but it's a separate HA call — doing
  // it after is simpler and the latency is negligible. Skip silently if HA
  // is unreachable; a null row is more useful than nothing for later integration.
  const plug = getPlugConfig();
  if (plug.enabled && plug.ha_url && plug.ha_entity_id && plug.ha_token_encrypted) {
    try {
      const [powerW, energyKwh] = await Promise.all([
        getPlugPowerW().catch(() => null),
        getPlugEnergyKwh().catch(() => null),
      ]);
      if (powerW !== null || energyKwh !== null) {
        insertPlugHistory({ plug_power_w: powerW, plug_energy_kwh: energyKwh });
      }
    } catch (err) {
      console.error('[poll] plug energy fetch error:', err);
    }
  }

  pollsSinceLastPrune++;
  if (pollsSinceLastPrune >= PRUNE_EVERY_N_POLLS) {
    pollsSinceLastPrune = 0;
    try {
      pruneStatsHistory(7 * 24); // keep last 7 days
      prunePlugHistory(30 * 24); // keep last 30 days of plug data for monthly cost
    } catch (err) {
      console.error('[poll] prune error:', err);
    }
  }
  return results;
}

/**
 * Result of one applyDesiredState call. The scheduler aggregates these across
 * all miners in a tick to produce one combined notification per action type
 * (instead of N separate pings to the user's phone). Failures are surfaced
 * individually since they typically indicate a specific problem with a specific
 * miner that's worth its own urgent notification.
 */
interface ApplyResult {
  miner: Miner;
  /** What we actually did (or didn't). */
  action: 'paused' | 'resumed' | 'already_paused' | 'already_mining' | 'noop_offline' | 'noop_match';
  /** Error message if the command threw. */
  error?: string;
  /** Source label, e.g. "scheduler:Peak summer" or "safety:plug-off". */
  source: string;
}

async function applyDesiredState(
  miner: Miner,
  shouldPause: boolean,
  source: string
): Promise<ApplyResult> {
  const current = state.latestStats.get(miner.id);
  // Treat 'offline' as unknown — don't try to flip it, just log.
  if (current?.status === 'offline') {
    console.log(`[scheduler] miner ${miner.id} offline, skipping`);
    return { miner, action: 'noop_offline', source };
  }

  const isPaused = current?.status === 'paused' || current?.status === 'stopping';
  const curStatus = current?.status ?? 'unknown';
  console.log(
    `[scheduler] miner ${miner.id}: current=${curStatus} desired=${shouldPause ? 'paused' : 'mining'} source=${source}`
  );

  if (shouldPause && !isPaused) {
    try {
      const r = await pauseMining(miner);
      logEvent({
        miner_id: miner.id,
        action: 'pause',
        source,
        result: 'success',
        detail: r.alreadyPaused ? 'already paused' : null,
      });
      return { miner, action: r.alreadyPaused ? 'already_paused' : 'paused', source };
    } catch (err) {
      const msg = (err as Error).message;
      logEvent({ miner_id: miner.id, action: 'pause', source, result: 'error', detail: msg });
      return { miner, action: 'paused', source, error: msg };
    }
  } else if (!shouldPause && isPaused) {
    // ── Stuck-state guard ──
    // If we're in a stuck-resume streak (BOSer keeps saying alreadyMining=true
    // but no hashing is actually happening), stop retrying. The streak resets
    // when we observe actual mining or when the user resolves it.
    const streak = state.stuckResumeStreak.get(miner.id) ?? 0;
    if (streak >= STUCK_RESUME_THRESHOLD) {
      console.log(
        `[scheduler] miner ${miner.id} appears STUCK (streak=${streak}). Not retrying Resume; user must reboot the miner.`
      );
      return { miner, action: 'noop_match', source, error: 'stuck — see alert' };
    }

    try {
      const r = await resumeMining(miner);
      logEvent({
        miner_id: miner.id,
        action: 'resume',
        source,
        result: 'success',
        detail: r.alreadyMining ? 'already mining' : null,
      });

      // If BOSer claims alreadyMining but the cached stats say paused (i.e.
      // miner is actually paused with 0 hashrate), increment the stuck streak.
      // We'll fire an alert once the streak crosses the threshold.
      if (r.alreadyMining && isPaused) {
        state.stuckResumeStreak.set(miner.id, streak + 1);
      } else {
        state.stuckResumeStreak.delete(miner.id);
        clearAlertDedup(`miner_stuck:${miner.id}`);
      }

      return { miner, action: r.alreadyMining ? 'already_mining' : 'resumed', source };
    } catch (err) {
      const msg = (err as Error).message;
      logEvent({ miner_id: miner.id, action: 'resume', source, result: 'error', detail: msg });
      return { miner, action: 'resumed', source, error: msg };
    }
  }

  // Healthy path: a mining miner staying mining clears any stuck streak.
  if (!shouldPause && !isPaused) {
    if (state.stuckResumeStreak.has(miner.id)) {
      state.stuckResumeStreak.delete(miner.id);
      clearAlertDedup(`miner_stuck:${miner.id}`);
    }
  }

  return { miner, action: 'noop_match', source };
}

/**
 * Aggregate per-miner results into one notification per action type for the
 * scheduler tick. Failures are sent individually (urgent) so a stuck miner
 * doesn't get hidden inside a batch.
 */
async function notifyForReconcile(results: ApplyResult[]) {
  const plug = getPlugConfig();
  if (!plug.alert_webhook_enabled || !plug.alert_webhook_url) return;

  const paused: ApplyResult[] = [];
  const resumed: ApplyResult[] = [];
  const pauseFailures: ApplyResult[] = [];
  const resumeFailures: ApplyResult[] = [];

  for (const r of results) {
    if (r.error) {
      if (r.action === 'paused') pauseFailures.push(r);
      else if (r.action === 'resumed') resumeFailures.push(r);
      continue;
    }
    if (r.action === 'paused') paused.push(r);
    else if (r.action === 'resumed') resumed.push(r);
    // already_paused / already_mining / noops → no notification
  }

  // Combine sources into a readable label. Usually all miners share the same
  // window label, so this collapses to "Peak summer" rather than enumerating.
  const sourceLabel = (rs: ApplyResult[]) => {
    const uniq = Array.from(new Set(rs.map((r) => r.source.replace(/^scheduler:/, ''))));
    return uniq.length === 1 ? uniq[0] : uniq.join(' / ');
  };

  // Unique key per minute prevents accidental dedupe of legitimate
  // back-to-back transitions while still suppressing exact-same-tick repeats.
  const minuteKey = Math.floor(Date.now() / 60_000);

  if (paused.length > 0 && plug.notify_on_miner_pause) {
    const names = paused.map((r) => r.miner.name).join(', ');
    const src = sourceLabel(paused);
    const isSafety = src.includes('safety');
    await sendAlert({
      key: `scheduler:pause:${minuteKey}`,
      title: paused.length === 1 ? `${names} paused` : `${paused.length} miners paused`,
      detail: paused.length === 1 ? `Source: ${src}` : `${names} · source: ${src}`,
      priority: isSafety ? 5 : 3,
      tags: isSafety ? ['rotating_light', 'warning'] : ['pause_button'],
    });
  }

  if (resumed.length > 0 && plug.notify_on_miner_resume) {
    const names = resumed.map((r) => r.miner.name).join(', ');
    const src = sourceLabel(resumed);
    await sendAlert({
      key: `scheduler:resume:${minuteKey}`,
      title: resumed.length === 1 ? `${names} resumed` : `${resumed.length} miners resumed`,
      detail: resumed.length === 1 ? `Source: ${src}` : `${names} · source: ${src}`,
      priority: 3,
      tags: ['play_button'],
    });
  }

  // Stuck-state alerts: a miner whose Resume calls keep returning alreadyMining
  // but isn't actually hashing. Urgent — only manual intervention will fix it.
  for (const r of results) {
    const streak = state.stuckResumeStreak.get(r.miner.id) ?? 0;
    if (streak === STUCK_RESUME_THRESHOLD) {
      await sendAlert({
        key: `miner_stuck:${r.miner.id}`,
        title: `${r.miner.name} stuck — needs manual reboot`,
        detail: `BOSer reports the miner as mining but no hashrate is being produced. HomeRig has stopped retrying Resume. Open http://${r.miner.ip}/ and reboot from the BOSer UI, then HomeRig will recover automatically.`,
        priority: 5,
        tags: ['rotating_light', 'wrench'],
      });
    }
  }

  // Per-miner failure notifications stay individual + urgent.
  for (const r of pauseFailures) {
    if (!plug.notify_on_miner_pause) continue;
    await sendAlert({
      key: `miner_pause_fail:${r.miner.id}`,
      title: `${r.miner.name} pause FAILED`,
      detail: r.error,
      priority: 5,
      tags: ['rotating_light'],
    });
  }
  for (const r of resumeFailures) {
    if (!plug.notify_on_miner_resume) continue;
    await sendAlert({
      key: `miner_resume_fail:${r.miner.id}`,
      title: `${r.miner.name} could not start`,
      detail: r.error,
      priority: 5,
      tags: ['rotating_light', 'warning'],
    });
  }
}

export async function reconcile() {
  const miners = getEnabledMiners();
  const windows = getEnabledBlackouts();
  const plug = getPlugConfig();

  const now = new Date();
  let anyShouldRun = false;
  const decisions = miners.map((m) => {
    const ev = evaluateForMiner(m.id, windows, now);
    if (!ev.shouldPause) anyShouldRun = true;
    return { miner: m, shouldPause: ev.shouldPause, source: ev.activeWindows[0]?.label ?? 'manual' };
  });
  console.log(
    `[scheduler] reconcile: ${decisions.length} miners, anyShouldRun=${anyShouldRun}, decisions=${decisions
      .map((d) => `${d.miner.id}:${d.shouldPause ? 'P' : 'R'}`)
      .join(',')}`
  );

  // Refresh stats once before deciding so we have current status.
  await pollAllMiners().catch(() => {});

  const plugFullyConfigured =
    plug.enabled && plug.ha_url && plug.ha_entity_id && plug.ha_token_encrypted;

  // ── Step 1: snapshot CURRENT plug state before we issue any commands ──
  // We need this to detect an OFF→ON transition for the stagger logic.
  let plugStateBefore: 'on' | 'off' | 'unknown' = 'unknown';
  if (plugFullyConfigured) {
    const s = await getSafetyState();
    plugStateBefore = s.state;
  }

  // ── Step 2: drive the plug to its desired state FIRST when mirroring is on ──
  // This ensures fans spin up before we try to resume miners, and miners are
  // already paused before the plug cuts power.
  let plugJustTurnedOn = false;
  if (plugFullyConfigured && plug.mirror_miners) {
    const desiredPlugOn = anyShouldRun;
    if (desiredPlugOn && plugStateBefore !== 'on') {
      plugJustTurnedOn = true;
    }
    try {
      await setPlugPower(desiredPlugOn);
      logEvent({
        miner_id: null,
        action: desiredPlugOn ? 'plug_on' : 'plug_off',
        source: 'scheduler:mirror',
        result: 'success',
        detail: null,
      });
    } catch (err) {
      // If the plug command failed, treat it as "didn't turn on" so we don't
      // skip the stagger AND skip safety.
      plugJustTurnedOn = false;
      logEvent({
        miner_id: null,
        action: desiredPlugOn ? 'plug_on' : 'plug_off',
        source: 'scheduler:mirror',
        result: 'error',
        detail: (err as Error).message,
      });
    }
  }

  // ── Step 3: stagger ──
  // If we just told the plug to turn ON and any miner needs to resume,
  // wait for the fans to spin up before issuing Resume calls. This runs
  // BEFORE the safety check so the post-stagger state check sees the
  // settled plug state, not a half-second-old "still off" reading.
  if (
    plugJustTurnedOn &&
    plug.startup_stagger_enabled &&
    plug.startup_stagger_seconds > 0 &&
    decisions.some((d) => !d.shouldPause)
  ) {
    const ms = plug.startup_stagger_seconds * 1000;
    logEvent({
      miner_id: null,
      action: 'system',
      source: 'scheduler:stagger',
      result: 'success',
      detail: `Waiting ${plug.startup_stagger_seconds}s for fans to spin up before resuming miners`,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  // ── Step 4: safety interlock ──
  // Before resuming any miner, verify the plug is actually ON. If not (or if we
  // can't tell), override that miner's decision to "pause" and fire an alert.
  //
  // Guards (added to prevent the "Umbrel deploy paused our miners" disaster):
  //   - STARTUP GRACE: ignore the first ~60s after boot. DNS, HA, network all
  //     need time to settle. A cold-start safety panic shouldn't yank live miners.
  //   - UNKNOWN DEBOUNCE: 'unknown' (HA unreachable) requires N consecutive
  //     ticks before pausing. Single failed probes don't override.
  //   - We still pause IMMEDIATELY on a definite 'off' reading — that's not a
  //     network glitch, the plug really is off.
  if (plugFullyConfigured && plug.safety_require_plug_on) {
    const safety = await getSafetyState();
    console.log(`[scheduler] safety check: plug state=${safety.state}`);

    const inStartupGrace = Date.now() - state.startedAt < STARTUP_GRACE_MS;
    let shouldOverride = false;

    if (safety.state === 'off') {
      // Definite off — always override (no debounce).
      state.unknownStateStreak = 0;
      shouldOverride = !inStartupGrace; // still respect grace
      if (inStartupGrace) {
        console.log('[scheduler] safety: plug OFF but in startup grace, deferring');
      }
    } else if (safety.state === 'unknown') {
      state.unknownStateStreak++;
      if (state.unknownStateStreak >= UNKNOWN_STATE_THRESHOLD && !inStartupGrace) {
        shouldOverride = true;
      } else {
        console.log(
          `[scheduler] safety: plug unknown (streak=${state.unknownStateStreak}/${UNKNOWN_STATE_THRESHOLD}${inStartupGrace ? ', in startup grace' : ''}) — not overriding yet`
        );
      }
    } else {
      // 'on' — clear streaks and dedupe entries.
      state.unknownStateStreak = 0;
      clearAlertDedup('safety:plug:off');
      clearAlertDedup('safety:plug:unknown');
    }

    if (shouldOverride) {
      let overrodeAny = false;
      for (const d of decisions) {
        if (!d.shouldPause) {
          d.shouldPause = true;
          d.source = `safety:plug-${safety.state}`;
          overrodeAny = true;
        }
      }
      if (overrodeAny) {
        const reasonDetail =
          safety.state === 'unknown'
            ? `Plug state unknown for ${state.unknownStateStreak} ticks: ${(safety as { reason: string }).reason}`
            : 'Plug is OFF';
        logEvent({
          miner_id: null,
          action: 'system',
          source: 'safety:plug-interlock',
          result: 'error',
          detail: reasonDetail,
        });
        await sendAlert({
          key: `safety:plug:${safety.state}`,
          title: 'Safety: miners paused — fan plug not ON',
          detail: `${reasonDetail}. Miners will stay paused until the plug is back ON.`,
          priority: 5,
          tags: ['rotating_light', 'fire'],
        });
      }
    }
  }

  // ── Step 5: apply final miner state in parallel ──
  const results = await Promise.all(
    decisions.map((d) =>
      applyDesiredState(d.miner, d.shouldPause, `scheduler:${d.source}`)
    )
  );

  // ── Step 6: send one combined notification per action type ──
  // (failures stay per-miner inside notifyForReconcile)
  await notifyForReconcile(results);
}

export function startScheduler() {
  if (state.started) return;
  state.started = true;
  state.startedAt = Date.now();
  state.unknownStateStreak = 0;
  state.stuckResumeStreak.clear();
  const settings = getSettings();

  // Poll loop
  const intervalSec = Math.max(10, settings.poll_interval_s || 30);
  state.pollJob = new Cron(`*/${intervalSec} * * * * *`, async () => {
    try {
      await pollAllMiners();
    } catch (err) {
      console.error('[scheduler] poll error:', err);
    }
  });

  // Reconcile every minute, plus an immediate run on startup.
  state.reconcileJob = new Cron('0 * * * * *', async () => {
    try {
      await reconcile();
    } catch (err) {
      console.error('[scheduler] reconcile error:', err);
    }
  });

  console.log(`[scheduler] started (poll=${intervalSec}s, reconcile=60s)`);

  // Fire-and-forget initial reconcile so we don't wait up to a minute on boot.
  reconcile().catch((err) => console.error('[scheduler] initial reconcile error:', err));
  logEvent({
    miner_id: null,
    action: 'system',
    source: 'startup',
    result: 'success',
    detail: `scheduler started, poll=${intervalSec}s`,
  });
}

export function stopScheduler() {
  state.pollJob?.stop();
  state.reconcileJob?.stop();
  state.pollJob = null;
  state.reconcileJob = null;
  state.started = false;
}

export function restartScheduler() {
  stopScheduler();
  startScheduler();
}
