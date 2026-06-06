'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, Miner } from '@/types';

// API shape from /api/miners (not the raw DB row — `enabled` is boolean here).
interface SafeMiner extends Omit<Miner, 'password_encrypted' | 'enabled'> {
  enabled: boolean;
  has_password?: boolean;
}

interface PlugView {
  enabled: boolean;
  mirror_miners: boolean;
  ha_url: string;
  ha_entity_id: string;
  has_token: boolean;
  safety_require_plug_on: boolean;
  alert_webhook_url: string;
  alert_webhook_enabled: boolean;
  startup_stagger_enabled: boolean;
  startup_stagger_seconds: number;
  notify_on_miner_pause: boolean;
  notify_on_miner_resume: boolean;
}

interface SettingsView {
  settings: AppSettings;
  plug: PlugView;
}

interface ElectricityCfg {
  currency: string;
  rate_offpeak_cents: number;
  rate_peak_cents: number;
  use_blackout_as_peak: boolean;
  service_charge_cents_per_day: number;
  demand_charge_dollars_per_kw: number;
}

interface MonthlySummary {
  month: string;
  days_elapsed: number;
  days_in_month: number;
  peak_kw: number;
  peak_at: string | null;
  service_charge_so_far: number;
  demand_charge_so_far: number;
  energy_cost_so_far: number;
  total_so_far: number;
  projected_total: number;
  currency: string;
}

interface ElectricityResponse {
  config: ElectricityCfg;
  current_period: 'peak' | 'offpeak';
  current_rate_cents_per_kwh: number;
  monthly?: MonthlySummary;
}

interface ProfitCfg {
  enabled: boolean;
  has_token: boolean;
  price_source: string;
  pause_below_minutes: number;
  resume_margin_pct: number;
  manual_floor_enabled: boolean;
  manual_floor_usd: number;
  running_watts_override: number;
  notify_on_trip: boolean;
  notify_on_recover: boolean;
}

interface ProfitSnapshot {
  enabled: boolean;
  btc_price_usd: number | null;
  btc_per_day: number | null;
  btc_per_day_method: string | null;
  hashrate_ths: number;
  running_watts: number;
  rate_period: 'peak' | 'offpeak';
  rate_cents_per_kwh: number;
  daily_energy_cost_usd: number;
  break_even_usd: number | null;
  threshold_usd: number | null;
  manual_floor_active: boolean;
  revenue_per_day_usd: number | null;
  profit_per_day_usd: number | null;
  unprofitable: boolean;
  reason: string;
}

interface ProfitResponse {
  config: ProfitCfg;
  snapshot: ProfitSnapshot;
  guard: { tripped: boolean; below_for_seconds: number | null };
}

interface ThermalCfg {
  enabled: boolean;
  chip_ceiling_c: number;
  board_ceiling_c: number;
  reset_margin_c: number;
  faulty: { miner_id: number; board_id: number }[];
}

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [miners, setMiners] = useState<SafeMiner[]>([]);
  const [electricity, setElectricity] = useState<ElectricityResponse | null>(null);
  const [profit, setProfit] = useState<ProfitResponse | null>(null);
  const [thermal, setThermal] = useState<ThermalCfg | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, m, e, p, t] = await Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/miners').then((r) => r.json()),
      fetch('/api/electricity').then((r) => r.json()),
      fetch('/api/profitability').then((r) => r.json()),
      fetch('/api/thermal').then((r) => r.json()),
    ]);
    setView(s);
    setMiners(m.miners ?? []);
    setElectricity(e ?? null);
    setProfit(p ?? null);
    setThermal(t?.config ?? null);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!view) return <div className="text-muted text-sm">Loading…</div>;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">Miners, plug, electricity, polling, and credentials</p>
      </header>

      {msg && (
        <div className="text-sm text-accent border border-accent-dim/40 bg-accent/5 px-3 py-2 rounded">
          {msg}
        </div>
      )}

      <MinersSection miners={miners} onChange={refresh} setBusy={setBusy} setMsg={setMsg} busy={busy} />

      <PlugSection plug={view.plug} onChange={refresh} setMsg={setMsg} />

      {electricity && (
        <ElectricitySection electricity={electricity} onChange={refresh} setMsg={setMsg} />
      )}

      {profit && (
        <ProfitabilitySection profit={profit} onChange={refresh} setMsg={setMsg} />
      )}

      {thermal && (
        <ThermalSettingsSection thermal={thermal} onChange={refresh} setMsg={setMsg} />
      )}

      <PollingSection settings={view.settings} onChange={refresh} setMsg={setMsg} />
    </div>
  );
}

// ----- Miners -----

function MinersSection({
  miners, onChange, setBusy, setMsg, busy,
}: {
  miners: SafeMiner[]; onChange: () => void; setBusy: (b: boolean) => void; setMsg: (m: string) => void; busy: boolean;
}) {
  const [adding, setAdding] = useState(false);

  async function test(id: number) {
    setBusy(true);
    const r = await fetch(`/api/miners/${id}/test`, { method: 'POST' }).then((x) => x.json());
    setBusy(false);
    setMsg(r.ok ? `Connection OK — ${r.details.status} @ ${r.details.hashrate_th.toFixed(1)} TH/s` : `Failed: ${r.error}`);
  }
  async function remove(id: number) {
    if (!confirm('Delete this miner?')) return;
    await fetch(`/api/miners/${id}`, { method: 'DELETE' });
    onChange();
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Miners</h2>
        <button
          onClick={() => setAdding(true)}
          className="text-xs uppercase tracking-wider text-accent hover:underline"
        >
          + Add Miner
        </button>
      </div>
      <div className="space-y-3">
        {miners.map((m) => (
          <MinerEditor key={m.id} miner={m} onChange={onChange} onTest={() => test(m.id)} onRemove={() => remove(m.id)} busy={busy} />
        ))}
      </div>
      {adding && <MinerCreator onClose={() => setAdding(false)} onCreated={() => { setAdding(false); onChange(); }} />}
    </section>
  );
}

function MinerEditor({
  miner, onChange, onTest, onRemove, busy,
}: { miner: SafeMiner; onChange: () => void; onTest: () => void; onRemove: () => void; busy: boolean }) {
  const [name, setName] = useState(miner.name);
  const [ip, setIp] = useState(miner.ip);
  const [username, setUsername] = useState(miner.username ?? '');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(Boolean(miner.enabled));

  async function save() {
    await fetch(`/api/miners/${miner.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, username, password, enabled }),
    });
    setPassword('');
    onChange();
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Name"><Input value={name} onChange={setName} /></Field>
        <Field label="IP Address"><Input value={ip} onChange={setIp} className="data" /></Field>
        <Field label="Username"><Input value={username} onChange={setUsername} /></Field>
        <Field label="Password (leave blank to keep)">
          <Input value={password} onChange={setPassword} type="password" placeholder="••••••••" />
        </Field>
      </div>
      <div className="flex items-center gap-3 justify-between pt-1">
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <div className="flex gap-2">
          <button onClick={onTest} disabled={busy} className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim">
            {busy ? 'Testing…' : 'Test Connection'}
          </button>
          <button onClick={save} className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90">
            Save
          </button>
          <button onClick={onRemove} className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-red hover:border-red/30">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function MinerCreator({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('root');
  async function save() {
    await fetch('/api/miners/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, username, password }),
    });
    onCreated();
  }
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-md p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-medium">Add Miner</h3>
        <Field label="Name"><Input value={name} onChange={setName} placeholder="Miner 3" /></Field>
        <Field label="IP Address"><Input value={ip} onChange={setIp} placeholder="192.168.5.17" className="data" /></Field>
        <Field label="Username"><Input value={username} onChange={setUsername} /></Field>
        <Field label="Password"><Input value={password} onChange={setPassword} type="password" /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-muted hover:text-foreground">Cancel</button>
          <button onClick={save} className="px-3 py-1.5 text-sm bg-accent text-black rounded">Add</button>
        </div>
      </div>
    </div>
  );
}

// ----- Plug (HomeKit direct pairing) -----

function PlugSection({ plug, onChange, setMsg }: { plug: PlugView; onChange: () => void; setMsg: (s: string) => void }) {
  const [enabled, setEnabled] = useState(plug.enabled);
  const [mirror, setMirror] = useState(plug.mirror_miners);
  const [haUrl, setHaUrl] = useState(plug.ha_url);
  const [haEntityId, setHaEntityId] = useState(plug.ha_entity_id);
  const [haToken, setHaToken] = useState('');
  const [safetyRequirePlugOn, setSafetyRequirePlugOn] = useState(plug.safety_require_plug_on);
  const [staggerEnabled, setStaggerEnabled] = useState(plug.startup_stagger_enabled);
  const [staggerSeconds, setStaggerSeconds] = useState(plug.startup_stagger_seconds);
  const [webhookEnabled, setWebhookEnabled] = useState(plug.alert_webhook_enabled);
  const [webhookUrl, setWebhookUrl] = useState(plug.alert_webhook_url);
  const [notifyOnPause, setNotifyOnPause] = useState(plug.notify_on_miner_pause);
  const [notifyOnResume, setNotifyOnResume] = useState(plug.notify_on_miner_resume);
  const [testing, setTesting] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);

  async function save() {
    const body: Record<string, unknown> = {
      plug: {
        enabled,
        mirror_miners: mirror,
        ha_url: haUrl,
        ha_entity_id: haEntityId,
        ...(haToken ? { ha_token: haToken } : {}),
        safety_require_plug_on: safetyRequirePlugOn,
        alert_webhook_url: webhookUrl,
        alert_webhook_enabled: webhookEnabled,
        startup_stagger_enabled: staggerEnabled,
        startup_stagger_seconds: staggerSeconds,
        notify_on_miner_pause: notifyOnPause,
        notify_on_miner_resume: notifyOnResume,
      },
    };
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setHaToken('');
    setMsg('Plug settings saved');
    onChange();
  }

  async function testWebhookBtn() {
    setTestingWebhook(true);
    const r = await fetch('/api/plug/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    }).then((x) => x.json());
    setTestingWebhook(false);
    setMsg(r.ok ? 'Webhook delivered — check your Discord/Slack channel.' : `Webhook failed: ${r.error}`);
  }

  async function test() {
    setTesting(true);
    // If the user has typed but not saved values, test against those instead
    // of whatever's currently in the DB.
    const body: Record<string, unknown> = {};
    if (haUrl !== plug.ha_url || haEntityId !== plug.ha_entity_id || haToken) {
      body.ha_url = haUrl;
      body.ha_entity_id = haEntityId;
      if (haToken) body.ha_token = haToken;
    }
    const r = await fetch('/api/plug/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    setTesting(false);
    if (r.ok) {
      setMsg(`Plug OK — ${r.friendly_name ?? haEntityId} is ${r.state.toUpperCase()}`);
    } else {
      setMsg(`Plug test failed: ${r.error}`);
    }
  }

  async function toggle(on: boolean) {
    const r = await fetch('/api/plug/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    }).then((x) => x.json());
    setMsg(r.ok ? `Plug turned ${on ? 'ON' : 'OFF'}` : `Failed: ${r.error}`);
  }

  const configured = plug.ha_url && plug.ha_entity_id && plug.has_token;

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Eve Smart Plug (via Home Assistant)</h2>
      <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Home Assistant URL">
            <Input value={haUrl} onChange={setHaUrl} placeholder="http://umbrel.local:8123" className="data" />
          </Field>
          <Field label="Switch entity ID">
            <Input value={haEntityId} onChange={setHaEntityId} placeholder="switch.eve_energy_xxxxx" className="data" />
          </Field>
          <Field label="Long-lived access token">
            <Input
              value={haToken}
              onChange={setHaToken}
              placeholder={plug.has_token ? 'Saved — leave blank to keep' : 'eyJhbGc...'}
              type="password"
              className="data"
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Generate a token in HA at <span className="data">Profile → Security → Long-Lived Access Tokens</span>.
          The token is stored encrypted and never sent to the browser after saving.
        </p>

        <div className="flex items-center gap-6 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror miner state
          </label>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          {configured && (
            <>
              <button onClick={() => toggle(true)} className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim">
                Turn ON
              </button>
              <button onClick={() => toggle(false)} className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim">
                Turn OFF
              </button>
            </>
          )}
          <button
            onClick={test}
            disabled={testing || !haUrl || !haEntityId || (!plug.has_token && !haToken)}
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button onClick={save} className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90">
            Save
          </button>
        </div>

        {/* ── Safety interlock ── */}
        <div className="pt-3 border-t border-border space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted">Safety</div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={safetyRequirePlugOn}
              onChange={(e) => setSafetyRequirePlugOn(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block">Require fan plug ON for miners to run</span>
              <span className="block text-xs text-muted">
                If the plug is off or unreachable, the scheduler force-pauses miners and the manual
                Resume/Restart buttons return an error. Recommended for anything generating real heat.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={staggerEnabled}
              onChange={(e) => setStaggerEnabled(e.target.checked)}
              className="mt-1"
            />
            <span className="flex-1">
              <span className="block">Stagger miner startup after fans turn on</span>
              <span className="block text-xs text-muted">
                When the scheduler turns the plug ON to end a blackout, wait this many seconds before
                resuming the miners so the fans are up to speed first.
              </span>
              <span className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={5}
                  value={staggerSeconds}
                  onChange={(e) => setStaggerSeconds(parseInt(e.target.value) || 0)}
                  disabled={!staggerEnabled}
                  className="w-24 bg-surface-2 border border-border rounded px-3 py-1.5 text-sm data disabled:opacity-50"
                />
                <span className="text-xs text-muted">seconds (max 600)</span>
              </span>
            </span>
          </label>
        </div>

        {/* ── Notifications ── */}
        <div className="pt-3 border-t border-border space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted">Notifications</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={webhookEnabled}
              onChange={(e) => setWebhookEnabled(e.target.checked)}
            />
            <span>Enable notifications</span>
          </label>
          <Field label="Webhook URL (ntfy.sh, Discord, Slack, or any HTTP endpoint)">
            <Input
              value={webhookUrl}
              onChange={setWebhookUrl}
              placeholder="https://ntfy.sh/HomeRig"
              className="data"
            />
          </Field>
          <p className="text-xs text-muted">
            Auto-detects format. <strong>ntfy.sh</strong> URLs get headers (Title, Priority,
            Tags) for native iOS/Android notifications via the ntfy app.{' '}
            <strong>Discord/Slack</strong> URLs get a JSON body. Repeated alerts of the same
            type are deduped for 10 minutes.
          </p>

          <div className="space-y-1.5 pt-1">
            <div className="text-[10px] uppercase tracking-wider text-muted">Notify on</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyOnPause}
                onChange={(e) => setNotifyOnPause(e.target.checked)}
                disabled={!webhookEnabled}
              />
              <span className={!webhookEnabled ? 'text-muted' : ''}>
                Miner paused <span className="text-muted text-xs">(normal priority)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyOnResume}
                onChange={(e) => setNotifyOnResume(e.target.checked)}
                disabled={!webhookEnabled}
              />
              <span className={!webhookEnabled ? 'text-muted' : ''}>
                Miner resumed <span className="text-muted text-xs">(normal priority)</span>
              </span>
            </label>
            <div className="text-sm text-muted flex items-center gap-2 pt-1">
              <span className="led led--red" />
              Safety interlock fires <span className="text-foreground">automatically as urgent</span>
              {' '}(priority 5, can't be disabled while notifications are on)
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={testWebhookBtn}
              disabled={testingWebhook || !webhookUrl}
              className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim disabled:opacity-50"
            >
              {testingWebhook ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ----- Electricity rates -----

function ElectricitySection({
  electricity, onChange, setMsg,
}: {
  electricity: ElectricityResponse;
  onChange: () => void;
  setMsg: (s: string) => void;
}) {
  const [currency, setCurrency] = useState(electricity.config.currency);
  const [offpeak, setOffpeak] = useState(electricity.config.rate_offpeak_cents);
  const [peak, setPeak] = useState(electricity.config.rate_peak_cents);
  const [useBlackout, setUseBlackout] = useState(electricity.config.use_blackout_as_peak);
  const [serviceChargeDay, setServiceChargeDay] = useState(
    electricity.config.service_charge_cents_per_day
  );
  const [demandCharge, setDemandCharge] = useState(electricity.config.demand_charge_dollars_per_kw);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch('/api/electricity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currency,
        rate_offpeak_cents: offpeak,
        rate_peak_cents: peak,
        use_blackout_as_peak: useBlackout,
        service_charge_cents_per_day: serviceChargeDay,
        demand_charge_dollars_per_kw: demandCharge,
      }),
    });
    setSaving(false);
    setMsg('Electricity rates saved');
    onChange();
  }

  const period = electricity.current_period;
  const periodLabel = period === 'peak' ? 'peak' : 'off-peak';
  const periodColor = period === 'peak' ? 'text-red' : 'text-green';
  const rateNow = electricity.current_rate_cents_per_kwh;
  const monthly = electricity.monthly;
  const cur = currency || '$';

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Electricity rates</h2>
      <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
        {/* Live status */}
        <div className="flex items-center gap-3 text-sm">
          <span className="text-[10px] uppercase tracking-wider text-muted">Right now</span>
          <span className={`led ${period === 'peak' ? 'led--red' : 'led--green'}`} />
          <span className={`data uppercase tracking-wider text-xs ${periodColor}`}>{periodLabel}</span>
          <span className="text-muted text-xs">·</span>
          <span className="data text-foreground">{rateNow.toFixed(4)}¢/kWh</span>
        </div>

        {/* ── Energy rates ── */}
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted">Energy charges</div>
          <div className="grid md:grid-cols-3 gap-3">
            <Field label="Currency">
              <Input value={currency} onChange={setCurrency} placeholder="$" className="data" />
            </Field>
            <Field label="Off-peak (¢/kWh)">
              <Input
                value={String(offpeak)}
                onChange={(v) => setOffpeak(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
            <Field label="On-peak (¢/kWh)">
              <Input
                value={String(peak)}
                onChange={(v) => setPeak(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
          </div>
        </div>

        {/* ── Fixed monthly charges ── */}
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted">Fixed charges</div>
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Basic service charge (¢/day)">
              <Input
                value={String(serviceChargeDay)}
                onChange={(v) => setServiceChargeDay(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
            <Field label={`Demand charge (${cur}/kW of monthly peak)`}>
              <Input
                value={String(demandCharge)}
                onChange={(v) => setDemandCharge(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            The <strong>demand charge</strong> is the killer on TOU-RD plans: it's billed monthly
            based on the <strong>highest 60-minute average kW</strong> drawn during the month
            (any time, off-peak or peak). At a 6.5 kW rig load, that's{' '}
            <span className="data">{cur}{(6.5 * demandCharge).toFixed(2)}/mo</span> regardless of total kWh used.
            HomeRig tracks your current month's peak below.
          </p>
        </div>

        {/* ── Blackout = peak toggle ── */}
        <label className="flex items-start gap-2 text-sm pt-2 border-t border-border">
          <input
            type="checkbox"
            checked={useBlackout}
            onChange={(e) => setUseBlackout(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block">Treat blackout windows as peak hours</span>
            <span className="block text-xs text-muted">
              The dashboard shows the <strong>on-peak rate</strong> during your scheduled blackout
              windows (when miners are paused anyway). Useful for "what would it have cost if
              we didn't pause" math.
            </span>
          </span>
        </label>

        {/* ── This month's bill projection ── */}
        {monthly && (
          <div className="rounded border border-border bg-surface-2 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted">
                This month ({monthly.month}) — {monthly.days_elapsed.toFixed(1)}/{monthly.days_in_month} days elapsed
              </div>
              {monthly.peak_kw > 0 && (
                <div className="text-xs text-muted">
                  Peak load: <span className="data text-red">{monthly.peak_kw.toFixed(2)} kW</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Stat label="Service" value={`${cur}${monthly.service_charge_so_far.toFixed(2)}`} />
              <Stat
                label="Demand (locked)"
                value={`${cur}${monthly.demand_charge_so_far.toFixed(2)}`}
                accent={monthly.demand_charge_so_far > 0 ? 'red' : 'plain'}
              />
              <Stat label="Energy so far" value={`${cur}${monthly.energy_cost_so_far.toFixed(2)}`} />
              <Stat
                label="Projected total"
                value={`${cur}${monthly.projected_total.toFixed(2)}`}
                accent="amber"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  accent = 'plain',
}: {
  label: string;
  value: string;
  accent?: 'red' | 'amber' | 'green' | 'plain';
}) {
  const cls =
    accent === 'red' ? 'text-red' :
    accent === 'amber' ? 'text-accent' :
    accent === 'green' ? 'text-green' :
    'text-foreground';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-base data ${cls}`}>{value}</div>
    </div>
  );
}

// ----- Profitability guard -----

function ProfitabilitySection({
  profit, onChange, setMsg,
}: {
  profit: ProfitResponse;
  onChange: () => void;
  setMsg: (s: string) => void;
}) {
  const c = profit.config;
  const [enabled, setEnabled] = useState(c.enabled);
  const [token, setToken] = useState('');
  const [source, setSource] = useState(c.price_source);
  const [pauseBelow, setPauseBelow] = useState(c.pause_below_minutes);
  const [resumeMargin, setResumeMargin] = useState(c.resume_margin_pct);
  const [manualEnabled, setManualEnabled] = useState(c.manual_floor_enabled);
  const [manualUsd, setManualUsd] = useState(c.manual_floor_usd);
  const [wattsOverride, setWattsOverride] = useState(c.running_watts_override);
  const [notifyTrip, setNotifyTrip] = useState(c.notify_on_trip);
  const [notifyRecover, setNotifyRecover] = useState(c.notify_on_recover);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save() {
    setSaving(true);
    await fetch('/api/profitability', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        ...(token ? { pool_token: token } : {}),
        price_source: source,
        pause_below_minutes: pauseBelow,
        resume_margin_pct: resumeMargin,
        manual_floor_enabled: manualEnabled,
        manual_floor_usd: manualUsd,
        running_watts_override: wattsOverride,
        notify_on_trip: notifyTrip,
        notify_on_recover: notifyRecover,
      }),
    });
    setToken('');
    setSaving(false);
    setMsg('Profitability guard saved');
    onChange();
  }

  async function testToken() {
    setTesting(true);
    const r = await fetch('/api/profitability/test-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token ? { token } : {}),
    }).then((x) => x.json());
    setTesting(false);
    setMsg(
      r.ok
        ? `Pool OK — ${r.hashrate_ths?.toFixed(1) ?? '?'} TH/s, ${r.ok_workers ?? '?'} workers online`
        : `Pool token failed: ${r.error}`
    );
  }

  const s = profit.snapshot;
  const tripped = profit.guard.tripped;
  const fmtUsd = (n: number | null | undefined, dp = 0) =>
    n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  // Status LED: red when tripped, amber when below-but-in-grace, green when healthy.
  const belowGrace = !tripped && profit.guard.below_for_seconds != null;
  const led = !enabled ? 'led--gray' : tripped ? 'led--red' : belowGrace ? 'led--amber' : 'led--green';
  const statusLabel = !enabled
    ? 'disabled'
    : tripped
    ? 'paused — unprofitable'
    : belowGrace
    ? 'below break-even (grace)'
    : 'profitable';

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Profitability guard</h2>
      <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
        <p className="text-xs text-muted leading-relaxed">
          Pauses miners + fans when the live BTC price falls below break-even
          (marginal energy cost ÷ BTC mined per day), and resumes when it recovers.
          Uses the <strong>current marginal rate</strong> — demand and service charges are
          excluded, since they don&apos;t change with a single on/off decision.
        </p>

        {/* ── Live status ── */}
        <div className="rounded border border-border bg-surface-2 p-3 space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[10px] uppercase tracking-wider text-muted">Status</span>
            <span className={`led ${led}`} />
            <span className="data uppercase tracking-wider text-xs">{statusLabel}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="BTC price" value={fmtUsd(s.btc_price_usd)} />
            <Stat
              label="Break-even"
              value={fmtUsd(s.threshold_usd)}
              accent={s.unprofitable ? 'red' : 'plain'}
            />
            <Stat label="BTC / day" value={s.btc_per_day != null ? s.btc_per_day.toFixed(5) : '—'} />
            <Stat
              label="Profit / day"
              value={fmtUsd(s.profit_per_day_usd, 2)}
              accent={s.profit_per_day_usd != null && s.profit_per_day_usd < 0 ? 'red' : 'green'}
            />
            <Stat label="Revenue / day" value={fmtUsd(s.revenue_per_day_usd, 2)} />
            <Stat label="Energy / day" value={fmtUsd(s.daily_energy_cost_usd, 2)} />
            <Stat
              label="Running power"
              value={s.running_watts > 0 ? `${(s.running_watts / 1000).toFixed(2)} kW` : '—'}
            />
            <Stat
              label="Rate now"
              value={`${s.rate_cents_per_kwh.toFixed(2)}¢ ${s.rate_period === 'peak' ? '(peak)' : '(off-pk)'}`}
            />
          </div>
          <p className="text-xs text-muted">
            {s.reason}
            {s.btc_per_day_method && (
              <span className="text-muted/70"> · source: {s.btc_per_day_method.replace(/_/g, ' ')}</span>
            )}
          </p>
        </div>

        {/* ── Pool token ── */}
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Braiins Pool API token">
            <Input
              value={token}
              onChange={setToken}
              placeholder={c.has_token ? 'Saved — leave blank to keep' : 'paste pool access token'}
              type="password"
              className="data"
            />
          </Field>
          <Field label="BTC price source">
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm data"
            >
              <option value="coinbase">Coinbase (default)</option>
              <option value="kraken">Kraken</option>
            </select>
          </Field>
        </div>
        <p className="text-xs text-muted">
          Generate a token in the Braiins Pool dashboard at{' '}
          <span className="data">Settings → Access Profiles</span> (read access is enough).
          Stored encrypted; never sent back to the browser.
        </p>

        {/* ── Hysteresis ── */}
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted">Hysteresis (anti-flapping)</div>
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Pause after below for (min)">
              <Input
                value={String(pauseBelow)}
                onChange={(v) => setPauseBelow(parseInt(v) || 0)}
                className="data"
              />
            </Field>
            <Field label="Resume margin above break-even (%)">
              <Input
                value={String(resumeMargin)}
                onChange={(v) => setResumeMargin(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
          </div>
        </div>

        {/* ── Manual floor + power override ── */}
        <div className="space-y-2 pt-2 border-t border-border">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={manualEnabled}
              onChange={(e) => setManualEnabled(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block">Use a fixed price floor instead of dynamic break-even</span>
              <span className="block text-xs text-muted">
                When on, the guard trips below this $/BTC instead of the computed break-even.
              </span>
            </span>
          </label>
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="Manual floor ($/BTC)">
              <Input
                value={String(manualUsd)}
                onChange={(v) => setManualUsd(parseFloat(v) || 0)}
                className="data"
              />
            </Field>
            <Field label="Running power override (W, 0 = auto)">
              <Input
                value={String(wattsOverride)}
                onChange={(v) => setWattsOverride(parseInt(v) || 0)}
                className="data"
              />
            </Field>
          </div>
          <p className="text-xs text-muted">
            Power is auto-detected from recent mining history. Set an override only if you don&apos;t
            yet have enough history (e.g. right after install) — e.g. <span className="data">6700</span> for two S21 XP + fans.
          </p>
        </div>

        {/* ── Toggles + actions ── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm pt-2 border-t border-border">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Guard enabled
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={notifyTrip} onChange={(e) => setNotifyTrip(e.target.checked)} /> Notify on pause
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={notifyRecover} onChange={(e) => setNotifyRecover(e.target.checked)} /> Notify on resume
          </label>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <button
            onClick={testToken}
            disabled={testing || (!c.has_token && !token)}
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent-dim disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test token'}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ----- Thermal watchdog -----

function ThermalSettingsSection({
  thermal, onChange, setMsg,
}: {
  thermal: ThermalCfg;
  onChange: () => void;
  setMsg: (s: string) => void;
}) {
  const [enabled, setEnabled] = useState(thermal.enabled);
  const [boardCeil, setBoardCeil] = useState(thermal.board_ceiling_c);
  const [chipCeil, setChipCeil] = useState(thermal.chip_ceiling_c);
  const [resetMargin, setResetMargin] = useState(thermal.reset_margin_c);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch('/api/thermal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        board_ceiling_c: boardCeil,
        chip_ceiling_c: chipCeil,
        reset_margin_c: resetMargin,
      }),
    });
    setSaving(false);
    setMsg('Thermal watchdog saved');
    onChange();
  }

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Thermal watchdog</h2>
      <div className="rounded-lg border border-border bg-surface p-4 space-y-4">
        <p className="text-xs text-muted leading-relaxed">
          Safety backstop for running with the miner&apos;s firmware{' '}
          <span className="data">&ldquo;Override Chip Temperature Safety Check&rdquo;</span> enabled.
          HomeRig pauses a miner when the <strong>independent board/PCB sensor</strong> shows real
          heat — so a single faulty chip sensor (the phantom &ldquo;T2 = 110°C&rdquo; trips) won&apos;t
          stop the rig, but a genuine overheat still will. Flag faulty chip sensors by clicking a
          board on the dashboard&apos;s Hashboard thermals card.
        </p>

        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable thermal watchdog
        </label>

        <div className="grid md:grid-cols-3 gap-3">
          <Field label="Pause at PCB temp (°C)">
            <Input value={String(boardCeil)} onChange={(v) => setBoardCeil(parseFloat(v) || 0)} className="data" />
          </Field>
          <Field label="Pause at trusted chip (°C)">
            <Input value={String(chipCeil)} onChange={(v) => setChipCeil(parseFloat(v) || 0)} className="data" />
          </Field>
          <Field label="Resume margin (°C below)">
            <Input value={String(resetMargin)} onChange={(v) => setResetMargin(parseFloat(v) || 0)} className="data" />
          </Field>
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Measured healthy peak on your S21 XPs: ~83°C PCB / ~98°C chip at full load. Defaults
          (90°C PCB / 105°C chip) sit above that with margin and well below the ~95°C PCB that
          corresponds to a real 110°C chip. After {resetMargin}°C of cooling a paused miner
          auto-resumes; after repeated trips it&apos;s held off until you intervene.
        </p>

        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ----- Polling -----

function PollingSection({ settings, onChange, setMsg }: { settings: AppSettings; onChange: () => void; setMsg: (s: string) => void }) {
  const [poll, setPoll] = useState(settings.poll_interval_s);
  const [timeout, setTimeout] = useState(settings.connection_timeout_ms);
  async function save() {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { poll_interval_s: poll, connection_timeout_ms: timeout } }),
    });
    setMsg('Polling settings saved');
    onChange();
  }
  return (
    <section className="space-y-3">
      <h2 className="font-medium">Polling</h2>
      <div className="rounded-lg border border-border bg-surface p-4 grid md:grid-cols-2 gap-3">
        <Field label="Poll interval (s)">
          <Input value={String(poll)} onChange={(v) => setPoll(parseInt(v) || 30)} className="data" />
        </Field>
        <Field label="Connection timeout (ms)">
          <Input value={String(timeout)} onChange={(v) => setTimeout(parseInt(v) || 5000)} className="data" />
        </Field>
        <div className="md:col-span-2 flex justify-end">
          <button onClick={save} className="text-xs px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90">
            Save
          </button>
        </div>
      </div>
    </section>
  );
}

// ----- shared -----

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Input({
  value, onChange, type = 'text', placeholder, className,
}: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string; className?: string }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm ${className ?? ''}`}
    />
  );
}
