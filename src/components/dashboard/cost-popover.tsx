'use client';
import { useCallback, useEffect, useState } from 'react';

interface ElectricityCfg {
  currency: string;
  rate_offpeak_cents: number;
  rate_peak_cents: number;
  use_blackout_as_peak: boolean;
  // Read through but not editable in this popover — Settings page handles them.
  service_charge_cents_per_day: number;
  demand_charge_dollars_per_kw: number;
}

/**
 * Inline electricity-rate editor. Opens as a small floating panel so we don't
 * have to touch the Settings page.
 */
export function CostPopover({
  cfg,
  onSaved,
}: {
  cfg: ElectricityCfg;
  onSaved: (next: ElectricityCfg) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState(cfg.currency);
  const [off, setOff] = useState(cfg.rate_offpeak_cents);
  const [peak, setPeak] = useState(cfg.rate_peak_cents);
  const [useBlackout, setUseBlackout] = useState(cfg.use_blackout_as_peak);

  useEffect(() => {
    setCurrency(cfg.currency);
    setOff(cfg.rate_offpeak_cents);
    setPeak(cfg.rate_peak_cents);
    setUseBlackout(cfg.use_blackout_as_peak);
  }, [cfg]);

  const save = useCallback(async () => {
    const r = await fetch('/api/electricity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currency,
        rate_offpeak_cents: off,
        rate_peak_cents: peak,
        use_blackout_as_peak: useBlackout,
      }),
    }).then((x) => x.json());
    if (r.config) onSaved(r.config);
    setOpen(false);
  }, [currency, off, peak, useBlackout, onSaved]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
        aria-label="Edit electricity rate"
      >
        {open ? '✕ close' : 'edit rate'}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-30 w-72 rounded-lg border border-border-strong bg-surface p-4 shadow-2xl">
          <div className="text-xs uppercase tracking-wider text-muted mb-3">Electricity rate</div>
          <div className="space-y-3">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted">Currency</span>
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-1 w-full bg-surface-2 border border-border rounded px-2.5 py-1.5 text-sm data"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted">Off-peak ¢/kWh</span>
                <input
                  type="number"
                  step={0.1}
                  value={off}
                  onChange={(e) => setOff(parseFloat(e.target.value) || 0)}
                  className="mt-1 w-full bg-surface-2 border border-border rounded px-2.5 py-1.5 text-sm data"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted">Peak ¢/kWh</span>
                <input
                  type="number"
                  step={0.1}
                  value={peak}
                  onChange={(e) => setPeak(parseFloat(e.target.value) || 0)}
                  className="mt-1 w-full bg-surface-2 border border-border rounded px-2.5 py-1.5 text-sm data"
                />
              </label>
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={useBlackout}
                onChange={(e) => setUseBlackout(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-muted">
                Treat blackout windows as <span className="text-foreground">peak hours</span> for cost
                calculations
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setOpen(false)}
                className="text-xs px-2.5 py-1 text-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="text-xs px-2.5 py-1 rounded bg-accent text-black hover:bg-accent/90"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
