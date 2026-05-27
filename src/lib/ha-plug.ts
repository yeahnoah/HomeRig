/**
 * Home Assistant REST bridge for plug control.
 *
 * Architecture:
 *   HomeRig → HA REST API → Matter Server → Thread network → Eve plug
 *
 * Why HA in the middle: the plug speaks Matter-over-Thread, and Matter Server
 * has to be commissioned with proper Thread credentials (a separate setup ceremony
 * involving the user's Apple home hub). HA handles that whole chain. Our job is just
 * to call HA's services.
 *
 * Endpoints we use:
 *   POST /api/services/switch/turn_on   {entity_id}
 *   POST /api/services/switch/turn_off  {entity_id}
 *   GET  /api/states/<entity_id>
 *
 * Auth: long-lived access token in `Authorization: Bearer <token>`.
 */

import { decrypt } from './crypto';
import { getPlugConfig } from './db';

interface PlugRuntime {
  url: string;
  token: string;
  entity_id: string;
}

function getRuntime(): PlugRuntime | null {
  const cfg = getPlugConfig();
  if (!cfg.enabled) return null;
  if (!cfg.ha_url || !cfg.ha_token_encrypted || !cfg.ha_entity_id) return null;
  let token = '';
  try {
    token = decrypt(cfg.ha_token_encrypted);
  } catch {
    return null;
  }
  return {
    url: cfg.ha_url.replace(/\/$/, ''),
    token,
    entity_id: cfg.ha_entity_id,
  };
}

async function callService(
  rt: PlugRuntime,
  service: 'turn_on' | 'turn_off' | 'toggle',
  timeoutMs = 5000
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${rt.url}/api/services/switch/${service}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rt.token}`,
      },
      body: JSON.stringify({ entity_id: rt.entity_id }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`HA ${service} failed: HTTP ${resp.status} ${await resp.text().catch(() => '')}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function setPower(on: boolean): Promise<void> {
  const rt = getRuntime();
  if (!rt) return; // disabled or unconfigured — silent no-op
  await callService(rt, on ? 'turn_on' : 'turn_off');
}

// ── Energy metering ──────────────────────────────────────────────────────────
// Eve Energy reports both instantaneous power (W) and cumulative energy (kWh)
// to HA via the Matter integration. The HA entity_ids follow the pattern:
//   switch.eve_energy_<device>           — the switch itself (in plug_config)
//   sensor.eve_energy_<device>_power     — current draw, unit W
//   sensor.eve_energy_<device>_energy    — cumulative use since pairing, unit kWh

function powerEntityId(switchEntityId: string): string {
  // switch.eve_energy_xxxxx → sensor.eve_energy_xxxxx_power
  return switchEntityId.replace(/^switch\./, 'sensor.') + '_power';
}

function energyEntityId(switchEntityId: string): string {
  return switchEntityId.replace(/^switch\./, 'sensor.') + '_energy';
}

async function fetchEntityState(rt: PlugRuntime, entityId: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(`${rt.url}/api/states/${encodeURIComponent(entityId)}`, {
      headers: { Authorization: `Bearer ${rt.token}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { state?: string };
    return data.state ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Current power draw of the plug in watts. Returns null if unavailable. */
export async function getPlugPowerW(): Promise<number | null> {
  const rt = getRuntime();
  if (!rt) return null;
  const state = await fetchEntityState(rt, powerEntityId(rt.entity_id));
  if (state === null || state === 'unavailable' || state === 'unknown') return null;
  const n = parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

/** Cumulative energy used by the plug since pairing, in kWh. Returns null if unavailable. */
export async function getPlugEnergyKwh(): Promise<number | null> {
  const rt = getRuntime();
  if (!rt) return null;
  const state = await fetchEntityState(rt, energyEntityId(rt.entity_id));
  if (state === null || state === 'unavailable' || state === 'unknown') return null;
  const n = parseFloat(state);
  return Number.isFinite(n) ? n : null;
}

/**
 * Safety check: is the plug confirmed ON right now?
 *
 * Returns:
 *   { state: 'on' }  — verified ON; safe to mine
 *   { state: 'off' } — verified OFF; do not mine
 *   { state: 'unknown', reason } — couldn't determine (HA down, token bad, etc.)
 *
 * The scheduler treats 'unknown' as fail-closed (don't mine) when safety is enabled.
 */
export async function getSafetyState(): Promise<
  | { state: 'on' }
  | { state: 'off' }
  | { state: 'unknown'; reason: string }
> {
  const cfg = getPlugConfig();
  if (!cfg.enabled) return { state: 'unknown', reason: 'plug integration disabled' };
  if (!cfg.ha_url || !cfg.ha_entity_id || !cfg.ha_token_encrypted) {
    return { state: 'unknown', reason: 'plug not configured' };
  }
  const r = await ping();
  if (!r.ok) return { state: 'unknown', reason: r.error };
  if (r.state === 'on') return { state: 'on' };
  if (r.state === 'off') return { state: 'off' };
  return { state: 'unknown', reason: `unexpected entity state: ${r.state}` };
}

export async function getPower(): Promise<boolean | null> {
  const rt = getRuntime();
  if (!rt) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(`${rt.url}/api/states/${encodeURIComponent(rt.entity_id)}`, {
      headers: { Authorization: `Bearer ${rt.token}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { state?: string };
    if (data.state === 'on') return true;
    if (data.state === 'off') return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health probe — used by the Settings "Test" button.
 * Verifies token + URL + entity exist. Reports the current state.
 *
 * Pass `override` to test with values that haven't been saved yet (so the
 * user can verify before committing them).
 */
export async function ping(override?: {
  ha_url?: string;
  ha_token?: string;
  ha_entity_id?: string;
}): Promise<
  | { ok: true; state: string; friendly_name?: string }
  | { ok: false; error: string }
> {
  let url: string;
  let token: string;
  let entity_id: string;
  if (override && override.ha_url && override.ha_token && override.ha_entity_id) {
    url = override.ha_url.replace(/\/$/, '');
    token = override.ha_token;
    entity_id = override.ha_entity_id;
  } else {
    const rt = getRuntime();
    if (!rt) return { ok: false, error: 'Plug not configured or not enabled' };
    url = rt.url;
    token = rt.token;
    entity_id = rt.entity_id;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(`${url}/api/states/${encodeURIComponent(entity_id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (resp.status === 401) return { ok: false, error: 'Invalid HA token' };
    if (resp.status === 404) return { ok: false, error: `Entity not found: ${entity_id}` };
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = (await resp.json()) as {
      state?: string;
      attributes?: { friendly_name?: string };
    };
    return {
      ok: true,
      state: data.state ?? 'unknown',
      friendly_name: data.attributes?.friendly_name,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
