'use client';
import { useCallback, useEffect, useState } from 'react';
import type { BlackoutWindow, BlackoutInput, TimeRange } from '@/types';
import { DOW_NAMES, DOW_MASK_ALL, describeWindow } from '@/lib/blackouts';

interface MinerRow { id: number; name: string }

export default function SchedulesPage() {
  const [blackouts, setBlackouts] = useState<BlackoutWindow[]>([]);
  const [miners, setMiners] = useState<MinerRow[]>([]);
  const [editing, setEditing] = useState<BlackoutWindow | 'new' | null>(null);

  const refresh = useCallback(async () => {
    const [b, m] = await Promise.all([
      fetch('/api/blackouts').then((r) => r.json()),
      fetch('/api/miners').then((r) => r.json()),
    ]);
    setBlackouts(b.blackouts ?? []);
    setMiners(m.miners ?? []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(b: BlackoutWindow) {
    await fetch(`/api/blackouts/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !b.enabled }),
    });
    refresh();
  }

  async function remove(b: BlackoutWindow) {
    if (!confirm(`Delete "${b.label}"?`)) return;
    await fetch(`/api/blackouts/${b.id}`, { method: 'DELETE' });
    refresh();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Blackout Windows</h1>
          <p className="text-sm text-muted">Define when miners must be paused. Outside these windows, miners run.</p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="text-xs uppercase tracking-wider px-3 py-1.5 rounded bg-accent text-black hover:bg-accent/90"
        >
          + New Window
        </button>
      </header>

      <ul className="space-y-2">
        {blackouts.length === 0 && (
          <li className="text-sm text-muted">No blackout windows yet. Click "New Window" to add one.</li>
        )}
        {blackouts.map((b) => (
          <li
            key={b.id}
            className="rounded-lg border border-border bg-surface p-4 flex items-center gap-4"
          >
            <button
              onClick={() => toggle(b)}
              aria-label="Toggle"
              className={
                'w-9 h-5 rounded-full relative transition-colors ' +
                (b.enabled ? 'bg-accent' : 'bg-border')
              }
            >
              <span
                className={
                  'absolute top-0.5 w-4 h-4 rounded-full bg-black transition-transform ' +
                  (b.enabled ? 'translate-x-4' : 'translate-x-0.5')
                }
              />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="font-medium">{b.label}</div>
                <span className="text-[10px] uppercase tracking-wider text-muted px-1.5 py-0.5 rounded bg-surface-2">
                  {b.target === 'all' ? 'All Miners' : `Miner ${b.target}`}
                </span>
              </div>
              <div className="text-xs text-muted data mt-0.5">{describeWindow(b)}</div>
            </div>
            <button
              onClick={() => setEditing(b)}
              className="text-xs text-muted hover:text-foreground px-2 py-1"
            >
              Edit
            </button>
            <button
              onClick={() => remove(b)}
              className="text-xs text-muted hover:text-red px-2 py-1"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <BlackoutEditor
          initial={editing === 'new' ? null : editing}
          miners={miners}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function BlackoutEditor({
  initial, miners, onClose, onSaved,
}: {
  initial: BlackoutWindow | null;
  miners: MinerRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [target, setTarget] = useState(initial?.target ?? 'all');
  const [dateStart, setDateStart] = useState(initial?.date_start ?? '');
  const [dateEnd, setDateEnd] = useState(initial?.date_end ?? '');
  const [repeatAnnually, setRepeatAnnually] = useState<boolean>(
    initial?.repeat_annually === 1
  );
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>(
    initial?.time_ranges?.length
      ? initial.time_ranges.map((r) => ({ start: r.start, end: r.end }))
      : [{ start: '14:00', end: '19:00' }]
  );
  const [dowMask, setDowMask] = useState(initial?.dow_mask ?? DOW_MASK_ALL);
  const [saving, setSaving] = useState(false);

  function toggleDow(i: number) {
    const bit = 1 << i;
    setDowMask((m) => (m & bit ? m & ~bit : m | bit));
  }

  function updateRange(idx: number, field: 'start' | 'end', value: string) {
    setTimeRanges((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }
  function addRange() {
    setTimeRanges((prev) => [...prev, { start: '06:00', end: '09:00' }]);
  }
  function removeRange(idx: number) {
    setTimeRanges((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function save() {
    setSaving(true);
    const body: BlackoutInput = {
      label: label || 'Blackout',
      target,
      dow_mask: dowMask,
      date_start: dateStart || null,
      date_end: dateEnd || null,
      time_ranges: timeRanges,
      repeat_annually: repeatAnnually,
      enabled: initial?.enabled !== 0,
    };
    if (initial) {
      await fetch(`/api/blackouts/${initial.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await fetch('/api/blackouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    setSaving(false);
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{initial ? 'Edit Window' : 'New Window'}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground">✕</button>
        </div>

        <Field label="Label">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="GA Power winter peak"
            className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Time slots (miners pause if NOW is inside any slot)">
          <div className="space-y-2">
            {timeRanges.map((r, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  type="time"
                  value={r.start}
                  onChange={(e) => updateRange(idx, 'start', e.target.value)}
                  className="flex-1 bg-surface-2 border border-border rounded px-3 py-2 text-sm data"
                />
                <span className="text-muted text-xs">to</span>
                <input
                  type="time"
                  value={r.end}
                  onChange={(e) => updateRange(idx, 'end', e.target.value)}
                  className="flex-1 bg-surface-2 border border-border rounded px-3 py-2 text-sm data"
                />
                <button
                  onClick={() => removeRange(idx)}
                  disabled={timeRanges.length <= 1}
                  aria-label="Remove slot"
                  className="px-2 py-1 text-muted hover:text-red disabled:opacity-30 disabled:hover:text-muted"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={addRange}
              className="text-xs text-accent hover:underline"
            >
              + Add another slot
            </button>
          </div>
        </Field>

        <Field label="Days of week">
          <div className="flex gap-1">
            {DOW_NAMES.map((d, i) => {
              const active = (dowMask & (1 << i)) !== 0;
              return (
                <button
                  key={d}
                  onClick={() => toggleDow(i)}
                  className={
                    'flex-1 text-xs py-1.5 rounded border transition-colors ' +
                    (active
                      ? 'bg-accent text-black border-accent'
                      : 'bg-surface-2 text-muted border-border hover:text-foreground')
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date range start (optional)">
            <input
              type="date"
              value={dateStart}
              onChange={(e) => setDateStart(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm data"
            />
          </Field>
          <Field label="Date range end (optional)">
            <input
              type="date"
              value={dateEnd}
              onChange={(e) => setDateEnd(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm data"
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={repeatAnnually}
            onChange={(e) => setRepeatAnnually(e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block">Repeat every year</span>
            <span className="block text-xs text-muted">
              Ignore the year portion of the date range. Wraps across New Year — e.g. Oct 1 → May 31 covers Oct, Nov, Dec, Jan, Feb, Mar, Apr, May every year.
            </span>
          </span>
        </label>

        <Field label="Target">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm"
          >
            <option value="all">All miners</option>
            {miners.map((m) => (
              <option key={m.id} value={String(m.id)}>{m.name}</option>
            ))}
          </select>
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-foreground">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm bg-accent text-black rounded hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
