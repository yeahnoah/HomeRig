/**
 * Safety gate for manual miner actions (Resume, Restart).
 *
 * Without this, a user could deadlock themselves: mirror_miners + safety
 * means the plug is OFF when miners are paused, but Resume refuses to run
 * with the plug OFF. The scheduler usually breaks this loop on blackout
 * transitions, but if a user wants to manually start their rig outside that
 * flow, there's no path forward.
 *
 * This helper does the right thing:
 *   1. If safety is disabled or plug is already ON → allow.
 *   2. Else, if mirror_miners is enabled → try turning the plug ON, wait briefly
 *      for it to settle, then re-check. Allow if it came up.
 *   3. Else (mirror off, plug off) → block with a clear, actionable error.
 *
 * The "wait briefly" here is shorter than the scheduler's full stagger because
 * we're in an HTTP request context — keep it under 5s.
 */

import { getPlugConfig } from './db';
import { getSafetyState, setPower } from './ha-plug';

const PLUG_ON_SETTLE_MS = 3000;
const POST_PLUG_RECHECK_DELAY_MS = 1500;

export type SafetyGateResult =
  | { ok: true; note?: string }
  | { ok: false; status: number; error: string; code: string };

export async function gateForResume(): Promise<SafetyGateResult> {
  const plug = getPlugConfig();
  const safetyOn =
    plug.enabled === 1 &&
    plug.safety_require_plug_on === 1 &&
    Boolean(plug.ha_url) &&
    Boolean(plug.ha_entity_id) &&
    Boolean(plug.ha_token_encrypted);
  if (!safetyOn) return { ok: true };

  const initial = await getSafetyState();
  if (initial.state === 'on') return { ok: true };

  // Plug is OFF or unknown. If mirror is enabled, try cascading the plug ON.
  if (plug.mirror_miners === 1) {
    try {
      await setPower(true);
      // Give the HA → Matter → Thread path a moment to settle.
      await new Promise((r) => setTimeout(r, POST_PLUG_RECHECK_DELAY_MS));
      // Recheck — wait up to PLUG_ON_SETTLE_MS total for it to flip to 'on'.
      const start = Date.now();
      let confirmed = await getSafetyState();
      while (confirmed.state !== 'on' && Date.now() - start < PLUG_ON_SETTLE_MS) {
        await new Promise((r) => setTimeout(r, 500));
        confirmed = await getSafetyState();
      }
      if (confirmed.state === 'on') {
        return { ok: true, note: 'plug auto-turned-on' };
      }
      const reason =
        confirmed.state === 'unknown'
          ? `Plug state still unknown: ${(confirmed as { reason: string }).reason}`
          : 'Plug did not report ON after we turned it on';
      return {
        ok: false,
        status: 502,
        code: 'plug_unreachable',
        error: `${reason}. Check Home Assistant and the Matter integration.`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        code: 'plug_command_failed',
        error: `Tried to turn the plug on but the command failed: ${(err as Error).message}`,
      };
    }
  }

  // Mirror not enabled — user is in charge of the plug.
  const reason =
    initial.state === 'off'
      ? 'fan plug is OFF'
      : `fan plug state unknown: ${(initial as { reason: string }).reason}`;
  return {
    ok: false,
    status: 409,
    code: 'plug_safety',
    error: `Safety interlock: ${reason}. Turn the plug ON in Settings, or enable "Mirror miner state" so HomeRig manages it for you.`,
  };
}
