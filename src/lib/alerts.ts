/**
 * Webhook alerts for safety / miner state events.
 *
 * Two transport formats, auto-detected from the URL:
 *
 *   1. ntfy.sh (and self-hosted ntfy)
 *      POST body=text. Headers control display:
 *         Title:    notification title
 *         Priority: 1=min … 3=default … 5=urgent (used for the safety interlock)
 *         Tags:     comma-separated emoji shortcodes (e.g. "rotating_light")
 *      Detection: URL contains "ntfy.sh" or path starts with /<topic> after a host
 *      we recognize. We keep it loose so self-hosted ntfy works too.
 *
 *   2. Discord / Slack / generic JSON webhook
 *      POST application/json with both `content` (Discord) and `text` (Slack).
 *
 * Dedupe: alerts carry a `key`. Same key won't refire within DEDUPE_MS so a
 * stuck-off plug doesn't spam your phone every scheduler tick.
 *
 * HMR-safe: dedupe state is anchored on globalThis so HMR reloads don't reset it.
 */

import { getPlugConfig } from './db';

const DEDUPE_MS = 10 * 60 * 1000; // 10 minutes

interface AlertCache {
  lastFired: Map<string, number>;
}
const g = globalThis as unknown as { __homerigAlerts?: AlertCache };
const cache: AlertCache = g.__homerigAlerts ?? (g.__homerigAlerts = { lastFired: new Map() });

/** ntfy priority levels: 1=min, 2=low, 3=default, 4=high, 5=urgent. */
export type Priority = 1 | 2 | 3 | 4 | 5;

export interface AlertPayload {
  /** Stable identifier for deduplication, e.g. "safety_pause:miner-1". */
  key: string;
  /** Short, single-line headline for the alert. */
  title: string;
  /** Optional longer detail line(s). */
  detail?: string;
  /** 1-5. Default 3. ntfy maps this to priority; Discord/Slack ignores it. */
  priority?: Priority;
  /** ntfy "Tags" — comma-separated emoji shortcodes, e.g. ["warning"]. */
  tags?: string[];
}

function isNtfyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // ntfy.sh, or anything pointing at /ntfy/, or self-hosted instances using
    // a non-standard host but the same path shape. We bias toward the well-known
    // public host; users with self-hosted instances can name their URL with "ntfy" in it.
    return u.hostname.includes('ntfy.sh') || /\bntfy\b/i.test(u.hostname);
  } catch {
    return false;
  }
}

function buildGenericBody(p: AlertPayload): string {
  const lines = [`[HomeRig] ${p.title}`];
  if (p.detail) lines.push(p.detail);
  const text = lines.join('\n');
  return JSON.stringify({ content: text, text });
}

interface SendInit {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

function buildRequest(url: string, p: AlertPayload, signal: AbortSignal): SendInit {
  if (isNtfyUrl(url)) {
    // ntfy: plain text body, headers carry metadata. Headers must be ASCII —
    // encode any non-ASCII chars in the title using ntfy's "Title*" RFC5987 form
    // is overkill; instead just strip non-ASCII as a safety net.
    const headers: Record<string, string> = {
      Title: toAscii(p.title),
      Priority: String(p.priority ?? 3),
    };
    if (p.tags && p.tags.length > 0) headers.Tags = p.tags.join(',');
    return {
      url,
      method: 'POST',
      headers,
      body: p.detail ?? p.title,
      signal,
    };
  }
  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: buildGenericBody(p),
    signal,
  };
}

function toAscii(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '');
}

async function doSend(url: string, p: AlertPayload): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const init = buildRequest(url, p, ctrl.signal);
    const resp = await fetch(init.url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status} ${body}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send an alert if the webhook is configured + enabled, and the key hasn't
 * fired recently. Returns true if the request was actually sent.
 */
export async function sendAlert(p: AlertPayload, opts: { force?: boolean } = {}): Promise<boolean> {
  const cfg = getPlugConfig();
  if (!cfg.alert_webhook_enabled || !cfg.alert_webhook_url) return false;

  if (!opts.force) {
    const last = cache.lastFired.get(p.key) ?? 0;
    if (Date.now() - last < DEDUPE_MS) return false;
  }
  cache.lastFired.set(p.key, Date.now());

  const r = await doSend(cfg.alert_webhook_url, p);
  if (!r.ok) {
    console.error(`[alerts] send failed: ${r.error}`);
    return false;
  }
  return true;
}

/** Clear the dedupe entry for a key — call when the underlying condition resolves. */
export function clearAlertDedup(key: string) {
  cache.lastFired.delete(key);
}

/**
 * Used by the Settings "Test Webhook" button.
 * Bypasses the enabled/configured checks; lets users verify a URL before saving.
 */
export async function testWebhook(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!url) return { ok: false, error: 'No webhook URL configured' };
  return doSend(url, {
    key: 'test',
    title: 'Test alert from HomeRig',
    detail: 'If you see this, your webhook is wired up correctly.',
    priority: 3,
    tags: ['white_check_mark'],
  });
}
