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

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [miners, setMiners] = useState<SafeMiner[]>([]);
  const [electricity, setElectricity] = useState<ElectricityResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, m, e] = await Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/miners').then((r) => r.json()),
      fetch('/api/electricity').then((r) => r.json()),
    ]);
    setView(s);
    setMiners(m.miners ?? []);
    setElectricity(e ?? null);
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
