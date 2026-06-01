'use client';
import { useEffect, useState } from 'react';
import type { EventLogEntry } from '@/types';

// event_log timestamps are stored as SQLite UTC strings ("YYYY-MM-DD HH:MM:SS"),
// same as stats_history/plug_history. Append 'Z' so the browser parses them as UTC
// and renders in the viewer's local timezone — keeping the log in sync with the
// schedule (which the server evaluates in its local TZ).
function fmtLocal(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return ts; // fall back to raw string if unparseable
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export default function LogsPage() {
  const [events, setEvents] = useState<EventLogEntry[]>([]);

  useEffect(() => {
    const load = () => fetch('/api/logs').then((r) => r.json()).then((d) => setEvents(d.events ?? []));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Event Log</h1>
        <p className="text-sm text-muted">Recent automated and manual actions</p>
      </header>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted bg-surface-2">
              <th className="text-left px-3 py-2">Time</th>
              <th className="text-left px-3 py-2">Miner</th>
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Result</th>
              <th className="text-left px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={6} className="text-center text-muted py-8">No events yet</td></tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="px-3 py-2 data text-xs text-muted whitespace-nowrap">{fmtLocal(e.ts)}</td>
                <td className="px-3 py-2 data">{e.miner_id ?? '—'}</td>
                <td className="px-3 py-2">{e.action}</td>
                <td className="px-3 py-2 text-muted">{e.source}</td>
                <td className={'px-3 py-2 ' + (e.result === 'error' ? 'text-red' : 'text-green')}>
                  {e.result}
                </td>
                <td className="px-3 py-2 text-xs text-muted truncate max-w-md">{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
