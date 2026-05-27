import { NextResponse, type NextRequest } from 'next/server';
import { ensureInitialized } from '@/lib/init';
import { getSettings, updateSettings, getPlugConfig, updatePlugConfig, type PlugConfigPatch } from '@/lib/db';
import { restartScheduler } from '@/lib/scheduler';
import type { AppSettings } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureInitialized();
  const plug = getPlugConfig();
  return NextResponse.json({
    settings: getSettings(),
    plug: {
      enabled: plug.enabled === 1,
      mirror_miners: plug.mirror_miners === 1,
      ha_url: plug.ha_url,
      ha_entity_id: plug.ha_entity_id,
      has_token: Boolean(plug.ha_token_encrypted),
      safety_require_plug_on: plug.safety_require_plug_on === 1,
      alert_webhook_url: plug.alert_webhook_url,
      alert_webhook_enabled: plug.alert_webhook_enabled === 1,
      startup_stagger_enabled: plug.startup_stagger_enabled === 1,
      startup_stagger_seconds: plug.startup_stagger_seconds,
      notify_on_miner_pause: plug.notify_on_miner_pause === 1,
      notify_on_miner_resume: plug.notify_on_miner_resume === 1,
    },
  });
}

interface PutBody {
  settings?: Partial<AppSettings>;
  plug?: {
    enabled?: boolean;
    mirror_miners?: boolean;
    ha_url?: string;
    ha_token?: string; // plaintext from form; encrypted in updatePlugConfig
    ha_entity_id?: string;
    safety_require_plug_on?: boolean;
    alert_webhook_url?: string;
    alert_webhook_enabled?: boolean;
    startup_stagger_enabled?: boolean;
    startup_stagger_seconds?: number;
    notify_on_miner_pause?: boolean;
    notify_on_miner_resume?: boolean;
  };
}

export async function PUT(req: NextRequest) {
  ensureInitialized();
  const body = (await req.json()) as PutBody;
  if (body.settings) {
    updateSettings(body.settings);
    restartScheduler();
  }
  if (body.plug) {
    const patch: PlugConfigPatch = {};
    if (body.plug.enabled !== undefined) patch.enabled = body.plug.enabled;
    if (body.plug.mirror_miners !== undefined) patch.mirror_miners = body.plug.mirror_miners;
    if (body.plug.ha_url !== undefined) patch.ha_url = body.plug.ha_url;
    if (body.plug.ha_entity_id !== undefined) patch.ha_entity_id = body.plug.ha_entity_id;
    if (body.plug.ha_token !== undefined) patch.ha_token = body.plug.ha_token;
    if (body.plug.safety_require_plug_on !== undefined)
      patch.safety_require_plug_on = body.plug.safety_require_plug_on;
    if (body.plug.alert_webhook_url !== undefined)
      patch.alert_webhook_url = body.plug.alert_webhook_url;
    if (body.plug.alert_webhook_enabled !== undefined)
      patch.alert_webhook_enabled = body.plug.alert_webhook_enabled;
    if (body.plug.startup_stagger_enabled !== undefined)
      patch.startup_stagger_enabled = body.plug.startup_stagger_enabled;
    if (body.plug.startup_stagger_seconds !== undefined)
      patch.startup_stagger_seconds = body.plug.startup_stagger_seconds;
    if (body.plug.notify_on_miner_pause !== undefined)
      patch.notify_on_miner_pause = body.plug.notify_on_miner_pause;
    if (body.plug.notify_on_miner_resume !== undefined)
      patch.notify_on_miner_resume = body.plug.notify_on_miner_resume;
    updatePlugConfig(patch);
  }
  return NextResponse.json({ ok: true });
}
