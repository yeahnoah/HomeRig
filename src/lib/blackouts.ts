/**
 * Blackout window evaluator.
 *
 * A blackout window means "miners must be PAUSED during this period."
 *
 * A window is "active now" if ALL of these hold:
 *   1. window.enabled
 *   2. today's date is within the date range (see below)
 *   3. today's day-of-week bit is set in dow_mask
 *   4. current local HH:MM falls inside AT LEAST ONE of the time_ranges
 *      (each range supports overnight wraparound, e.g. 22:00 → 06:00)
 *
 * Date range semantics:
 *   - If repeat_annually is false (default), date_start/date_end are compared as
 *     full YYYY-MM-DD strings. The window runs from date_start through date_end once.
 *   - If repeat_annually is true, only the MM-DD portion is considered, and the
 *     comparison handles year wrap (Oct 1 → May 31 spans two calendar years).
 *
 * Null start/end means "open ended on that side."
 */

import type { BlackoutWindow, TimeRange } from '@/types';

export interface BlackoutEvaluation {
  /** true if any active blackout targets this miner (or 'all') */
  shouldPause: boolean;
  /** which window(s) caused the pause */
  activeWindows: BlackoutWindow[];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function isInOneRange(now: Date, range: TimeRange): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(range.start);
  const end = toMinutes(range.end);
  if (start === end) return false; // empty range
  if (start < end) return cur >= start && cur < end;
  // overnight: cur >= start OR cur < end
  return cur >= start || cur < end;
}

function isInAnyRange(now: Date, ranges: TimeRange[]): boolean {
  for (const r of ranges) {
    if (isInOneRange(now, r)) return true;
  }
  return false;
}

function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthDayOf(yyyymmdd: string): string {
  // Tolerate "YYYY-MM-DD" or any other ISO-ish prefix; we only need the last 5 chars after the year.
  // Indexing on "-" is safer than fixed offset, in case of edge cases.
  const parts = yyyymmdd.split('-');
  if (parts.length < 3) return '';
  return `${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

function isInDateRangeAbsolute(today: string, date_start: string | null, date_end: string | null): boolean {
  if (date_start && today < date_start) return false;
  if (date_end && today > date_end) return false;
  return true;
}

function isInDateRangeAnnual(
  todayMd: string,
  date_start: string | null,
  date_end: string | null
): boolean {
  const startMd = date_start ? monthDayOf(date_start) : null;
  const endMd = date_end ? monthDayOf(date_end) : null;
  if (!startMd && !endMd) return true;
  if (startMd && endMd) {
    if (startMd <= endMd) {
      // Non-wrapping window (e.g. Jun 1 → Sep 30)
      return todayMd >= startMd && todayMd <= endMd;
    }
    // Wrapping window (e.g. Oct 1 → May 31)
    return todayMd >= startMd || todayMd <= endMd;
  }
  if (startMd) return todayMd >= startMd;
  if (endMd) return todayMd <= endMd;
  return true;
}

function isInDateRange(
  now: Date,
  date_start: string | null,
  date_end: string | null,
  repeat_annually: boolean
): boolean {
  if (!date_start && !date_end) return true; // unbounded
  const today = formatDateLocal(now);
  if (!repeat_annually) {
    return isInDateRangeAbsolute(today, date_start, date_end);
  }
  return isInDateRangeAnnual(monthDayOf(today), date_start, date_end);
}

function isDowMatch(now: Date, mask: number): boolean {
  // JS getDay(): Sun=0, Mon=1, ..., Sat=6 → bit = 1 << getDay()
  const bit = 1 << now.getDay();
  return (mask & bit) !== 0;
}

export function windowIsActive(w: BlackoutWindow, now: Date = new Date()): boolean {
  if (!w.enabled) return false;
  if (!isInDateRange(now, w.date_start, w.date_end, w.repeat_annually === 1)) return false;
  if (!isDowMatch(now, w.dow_mask)) return false;
  if (!w.time_ranges || w.time_ranges.length === 0) return false;
  if (!isInAnyRange(now, w.time_ranges)) return false;
  return true;
}

export function evaluateForMiner(
  minerId: number,
  windows: BlackoutWindow[],
  now: Date = new Date()
): BlackoutEvaluation {
  const active = windows.filter((w) => {
    if (!windowIsActive(w, now)) return false;
    return w.target === 'all' || w.target === String(minerId);
  });
  return {
    shouldPause: active.length > 0,
    activeWindows: active,
  };
}

export const DOW_MASK_ALL = 127; // 1111111 → all 7 days

export const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function dowMaskToLabel(mask: number): string {
  if (mask === DOW_MASK_ALL) return 'Every day';
  if (mask === 0b0111110) return 'Weekdays';
  if (mask === 0b1000001) return 'Weekends';
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (mask & (1 << i)) days.push(DOW_NAMES[i]);
  }
  return days.join(', ');
}

function describeTimeRanges(ranges: TimeRange[]): string {
  if (!ranges.length) return '—';
  return ranges.map((r) => `${r.start}–${r.end}`).join(' & ');
}

function describeDateRange(w: BlackoutWindow): string | null {
  if (!w.date_start && !w.date_end) return null;
  const fmt = (d: string | null) => (d ? (w.repeat_annually ? monthDayOf(d) : d) : '…');
  const label = `${fmt(w.date_start)} → ${fmt(w.date_end)}`;
  return w.repeat_annually ? `${label} (yearly)` : label;
}

export function describeWindow(w: BlackoutWindow): string {
  const parts: string[] = [];
  parts.push(describeTimeRanges(w.time_ranges));
  parts.push(dowMaskToLabel(w.dow_mask));
  const dateLabel = describeDateRange(w);
  if (dateLabel) parts.push(dateLabel);
  return parts.join(' · ');
}
