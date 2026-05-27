import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { encrypt } from './crypto';
import type {
  Miner,
  MinerInput,
  BlackoutWindow,
  BlackoutInput,
  TimeRange,
  PlugConfig,
  EventLogEntry,
  AppSettings,
} from '@/types';

// HMR-safe singleton: reuse one DB handle across module reloads in dev,
// otherwise each Turbopack rebuild would open a new SQLite connection
// (file handle + WAL state) and never close the old one.
const dbGlobal = globalThis as unknown as { __homerigDb?: Database.Database };

function dbPath(): string {
  const raw = process.env.DB_PATH || './data/homerig.db';
  return resolve(process.cwd(), raw);
}

export function getDb(): Database.Database {
  if (dbGlobal.__homerigDb) return dbGlobal.__homerigDb;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  dbGlobal.__homerigDb = db;
  return db;
}

function migratePlugConfig(d: Database.Database) {
  // The plug_config schema has churned several times:
  //   v1: Homebridge fields (homebridge_url, accessory_unique_id, ...)
  //   v2: HAP direct pairing (active_pairing_id → hap_pairings)
  //   v3: Home Assistant REST bridge (ha_url, ha_token_encrypted, ha_entity_id)
  //   v4: v3 + safety_require_plug_on + alert_webhook_url + alert_webhook_enabled
  const cols = d.prepare(`PRAGMA table_info(plug_config)`).all() as { name: string }[];
  if (cols.length === 0) return; // fresh install
  const hasV1 = cols.some((c) => c.name === 'homebridge_url');
  const hasV2 = cols.some((c) => c.name === 'active_pairing_id');
  const hasV3Base = cols.some((c) => c.name === 'ha_url');
  if (hasV1 || hasV2 || !hasV3Base) {
    d.exec('DROP TABLE plug_config');
    d.exec('DROP TABLE IF EXISTS hap_pairings');
    return;
  }
  // v3 → v4: additive migration, preserves existing data
  const hasSafety = cols.some((c) => c.name === 'safety_require_plug_on');
  if (!hasSafety) {
    d.exec(`ALTER TABLE plug_config ADD COLUMN safety_require_plug_on INTEGER NOT NULL DEFAULT 1`);
    d.exec(`ALTER TABLE plug_config ADD COLUMN alert_webhook_url TEXT NOT NULL DEFAULT ''`);
    d.exec(`ALTER TABLE plug_config ADD COLUMN alert_webhook_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  // v4 → v5: additive migration for startup stagger
  const hasStagger = cols.some((c) => c.name === 'startup_stagger_enabled');
  if (!hasStagger) {
    d.exec(`ALTER TABLE plug_config ADD COLUMN startup_stagger_enabled INTEGER NOT NULL DEFAULT 1`);
    d.exec(`ALTER TABLE plug_config ADD COLUMN startup_stagger_seconds INTEGER NOT NULL DEFAULT 30`);
  }
  // v5 → v6: additive migration for per-event notification toggles
  const hasNotify = cols.some((c) => c.name === 'notify_on_miner_pause');
  if (!hasNotify) {
    d.exec(`ALTER TABLE plug_config ADD COLUMN notify_on_miner_pause INTEGER NOT NULL DEFAULT 1`);
    d.exec(`ALTER TABLE plug_config ADD COLUMN notify_on_miner_resume INTEGER NOT NULL DEFAULT 1`);
  }
}

function migrateBlackoutWindows(d: Database.Database) {
  // Original schema had `time_start` + `time_end` as a single TEXT pair on the row.
  // Newer schema replaces them with `time_ranges_json` (JSON array of {start,end})
  // and adds `repeat_annually` for windows that should apply every year.
  const cols = d.prepare(`PRAGMA table_info(blackout_windows)`).all() as { name: string }[];
  if (cols.length === 0) return; // fresh install — initSchema will create the new shape

  const hasOldCols = cols.some((c) => c.name === 'time_start');
  const hasNewCols = cols.some((c) => c.name === 'time_ranges_json');

  // Add new columns if missing
  if (!hasNewCols) {
    d.exec(`ALTER TABLE blackout_windows ADD COLUMN time_ranges_json TEXT NOT NULL DEFAULT '[]'`);
    d.exec(`ALTER TABLE blackout_windows ADD COLUMN repeat_annually INTEGER NOT NULL DEFAULT 0`);
  }

  // Backfill time_ranges_json from time_start/time_end on each existing row
  if (hasOldCols) {
    const rows = d
      .prepare(`SELECT id, time_start, time_end FROM blackout_windows WHERE time_ranges_json IN ('', '[]')`)
      .all() as { id: number; time_start: string; time_end: string }[];
    const upd = d.prepare(`UPDATE blackout_windows SET time_ranges_json = ? WHERE id = ?`);
    for (const r of rows) {
      const json = JSON.stringify([{ start: r.time_start, end: r.time_end }]);
      upd.run(json, r.id);
    }
    // SQLite ≥ 3.35 supports DROP COLUMN. Try it; if it fails (older SQLite), leave
    // the legacy columns in place — they're just unused.
    try {
      d.exec(`ALTER TABLE blackout_windows DROP COLUMN time_start`);
      d.exec(`ALTER TABLE blackout_windows DROP COLUMN time_end`);
    } catch {
      // Old SQLite — legacy columns remain but are ignored everywhere in code.
    }
  }
}

function initSchema(d: Database.Database) {
  migratePlugConfig(d);
  migrateBlackoutWindows(d);
  d.exec(`
    CREATE TABLE IF NOT EXISTS miners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL UNIQUE,
      grpc_port INTEGER NOT NULL DEFAULT 50051,
      username TEXT NOT NULL DEFAULT 'root',
      password_encrypted TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blackout_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      date_start TEXT,
      date_end TEXT,
      time_ranges_json TEXT NOT NULL DEFAULT '[]',
      dow_mask INTEGER NOT NULL DEFAULT 127,
      repeat_annually INTEGER NOT NULL DEFAULT 0,
      target TEXT NOT NULL DEFAULT 'all',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Home Assistant REST bridge config + safety interlock + alerting.
    -- safety_require_plug_on: when 1, miners refuse to mine if the plug isn't confirmed ON.
    -- alert_webhook_url: optional Discord/Slack webhook for safety/alert events.
    CREATE TABLE IF NOT EXISTS plug_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      mirror_miners INTEGER NOT NULL DEFAULT 1,
      ha_url TEXT NOT NULL DEFAULT '',
      ha_token_encrypted TEXT NOT NULL DEFAULT '',
      ha_entity_id TEXT NOT NULL DEFAULT '',
      safety_require_plug_on INTEGER NOT NULL DEFAULT 1,
      alert_webhook_url TEXT NOT NULL DEFAULT '',
      alert_webhook_enabled INTEGER NOT NULL DEFAULT 0,
      startup_stagger_enabled INTEGER NOT NULL DEFAULT 1,
      startup_stagger_seconds INTEGER NOT NULL DEFAULT 30,
      notify_on_miner_pause INTEGER NOT NULL DEFAULT 1,
      notify_on_miner_resume INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      miner_id INTEGER,
      action TEXT NOT NULL,
      source TEXT NOT NULL,
      result TEXT NOT NULL,
      detail TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_event_log_miner ON event_log (miner_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Append-only time series of poll results. One row per miner per poll.
    -- Used by the dashboard charts for hashrate / power / temp history.
    CREATE TABLE IF NOT EXISTS stats_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      miner_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      hashrate_th REAL NOT NULL,
      power_w INTEGER,
      max_chip_temp REAL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stats_history_ts ON stats_history (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_stats_history_miner_ts ON stats_history (miner_id, ts DESC);

    -- Snapshots of the plug's electricity meter. Sampled on the same cadence
    -- as the miner poller. plug_energy_kwh is a monotonic cumulative reading
    -- straight from HA — we compute deltas across rows for accurate cost.
    CREATE TABLE IF NOT EXISTS plug_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      plug_power_w REAL,
      plug_energy_kwh REAL
    );
    CREATE INDEX IF NOT EXISTS idx_plug_history_ts ON plug_history (ts DESC);
  `);
}

// ----- seeding -----

export function seedIfEmpty() {
  const d = getDb();
  const minerCount = d.prepare('SELECT COUNT(*) AS n FROM miners').get() as { n: number };
  if (minerCount.n === 0) {
    const insert = d.prepare(
      `INSERT INTO miners (name, ip, grpc_port, username, password_encrypted, enabled)
       VALUES (?, ?, 50051, 'root', ?, 1)`
    );
    insert.run('Miner 1', '192.168.5.15', encrypt('root'));
    insert.run('Miner 2', '192.168.5.16', encrypt('root'));
  }
  const plug = d.prepare('SELECT COUNT(*) AS n FROM plug_config').get() as { n: number };
  if (plug.n === 0) {
    d.prepare(
      `INSERT INTO plug_config (id, enabled, mirror_miners, ha_url, ha_token_encrypted, ha_entity_id,
                                safety_require_plug_on, alert_webhook_url, alert_webhook_enabled,
                                startup_stagger_enabled, startup_stagger_seconds,
                                notify_on_miner_pause, notify_on_miner_resume)
       VALUES (1, 0, 1, '', '', '', 1, '', 0, 1, 30, 1, 1)`
    ).run();
  }
  const settingsRow = d.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
  if (settingsRow.n === 0) {
    const ins = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    ins.run('poll_interval_s', '30');
    ins.run('connection_timeout_ms', '5000');
  }
}

// ----- miners -----

export function listMiners(): Miner[] {
  return getDb().prepare('SELECT * FROM miners ORDER BY id ASC').all() as Miner[];
}

export function getMiner(id: number): Miner | undefined {
  return getDb().prepare('SELECT * FROM miners WHERE id = ?').get(id) as Miner | undefined;
}

export function getEnabledMiners(): Miner[] {
  return getDb()
    .prepare('SELECT * FROM miners WHERE enabled = 1 ORDER BY id ASC')
    .all() as Miner[];
}

export function createMiner(input: MinerInput): Miner {
  const d = getDb();
  const result = d
    .prepare(
      `INSERT INTO miners (name, ip, grpc_port, username, password_encrypted, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.ip,
      input.grpc_port ?? 50051,
      input.username,
      encrypt(input.password),
      input.enabled === false ? 0 : 1
    );
  return getMiner(Number(result.lastInsertRowid))!;
}

export function updateMiner(id: number, patch: Partial<MinerInput>): Miner | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.ip !== undefined) {
    fields.push('ip = ?');
    values.push(patch.ip);
  }
  if (patch.grpc_port !== undefined) {
    fields.push('grpc_port = ?');
    values.push(patch.grpc_port);
  }
  if (patch.username !== undefined) {
    fields.push('username = ?');
    values.push(patch.username);
  }
  if (patch.password !== undefined && patch.password.length > 0) {
    fields.push('password_encrypted = ?');
    values.push(encrypt(patch.password));
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (fields.length === 0) return getMiner(id);
  values.push(id);
  getDb()
    .prepare(`UPDATE miners SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getMiner(id);
}

export function deleteMiner(id: number) {
  getDb().prepare('DELETE FROM miners WHERE id = ?').run(id);
}

// ----- blackout windows -----

type BlackoutRow = Omit<BlackoutWindow, 'time_ranges'> & { time_ranges_json: string };

function rowToWindow(r: BlackoutRow | undefined): BlackoutWindow | undefined {
  if (!r) return undefined;
  let time_ranges: TimeRange[] = [];
  try {
    const parsed = JSON.parse(r.time_ranges_json);
    if (Array.isArray(parsed)) {
      time_ranges = parsed.filter(
        (x): x is TimeRange =>
          x && typeof x === 'object' && typeof x.start === 'string' && typeof x.end === 'string'
      );
    }
  } catch {
    /* corrupt JSON — treat as no ranges */
  }
  const { time_ranges_json: _trj, ...rest } = r;
  void _trj;
  return { ...rest, time_ranges };
}

export function listBlackouts(): BlackoutWindow[] {
  const rows = getDb()
    .prepare('SELECT * FROM blackout_windows ORDER BY id ASC')
    .all() as BlackoutRow[];
  return rows.map((r) => rowToWindow(r)!);
}

export function getEnabledBlackouts(): BlackoutWindow[] {
  const rows = getDb()
    .prepare('SELECT * FROM blackout_windows WHERE enabled = 1 ORDER BY id ASC')
    .all() as BlackoutRow[];
  return rows.map((r) => rowToWindow(r)!);
}

export function getBlackout(id: number): BlackoutWindow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM blackout_windows WHERE id = ?')
    .get(id) as BlackoutRow | undefined;
  return rowToWindow(row);
}

export function createBlackout(input: BlackoutInput): BlackoutWindow {
  if (!input.time_ranges || input.time_ranges.length === 0) {
    throw new Error('At least one time range is required');
  }
  const result = getDb()
    .prepare(
      `INSERT INTO blackout_windows
        (label, enabled, date_start, date_end, time_ranges_json, dow_mask, repeat_annually, target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.label,
      input.enabled === false ? 0 : 1,
      input.date_start ?? null,
      input.date_end ?? null,
      JSON.stringify(input.time_ranges),
      input.dow_mask,
      input.repeat_annually ? 1 : 0,
      input.target
    );
  return getBlackout(Number(result.lastInsertRowid))!;
}

export function updateBlackout(
  id: number,
  patch: Partial<BlackoutInput>
): BlackoutWindow | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  const setField = (k: string, v: unknown) => {
    fields.push(`${k} = ?`);
    values.push(v);
  };
  if (patch.label !== undefined) setField('label', patch.label);
  if (patch.enabled !== undefined) setField('enabled', patch.enabled ? 1 : 0);
  if (patch.date_start !== undefined) setField('date_start', patch.date_start);
  if (patch.date_end !== undefined) setField('date_end', patch.date_end);
  if (patch.time_ranges !== undefined) {
    if (patch.time_ranges.length === 0) throw new Error('At least one time range is required');
    setField('time_ranges_json', JSON.stringify(patch.time_ranges));
  }
  if (patch.dow_mask !== undefined) setField('dow_mask', patch.dow_mask);
  if (patch.repeat_annually !== undefined) setField('repeat_annually', patch.repeat_annually ? 1 : 0);
  if (patch.target !== undefined) setField('target', patch.target);
  if (fields.length === 0) return getBlackout(id);
  values.push(id);
  getDb()
    .prepare(`UPDATE blackout_windows SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getBlackout(id);
}

export function deleteBlackout(id: number) {
  getDb().prepare('DELETE FROM blackout_windows WHERE id = ?').run(id);
}

// ----- plug config -----

export function getPlugConfig(): PlugConfig {
  return getDb().prepare('SELECT * FROM plug_config WHERE id = 1').get() as PlugConfig;
}

export interface PlugConfigPatch {
  enabled?: boolean | 0 | 1;
  mirror_miners?: boolean | 0 | 1;
  ha_url?: string;
  /** Plaintext token; encrypted at rest before persistence */
  ha_token?: string;
  ha_entity_id?: string;
  safety_require_plug_on?: boolean | 0 | 1;
  alert_webhook_url?: string;
  alert_webhook_enabled?: boolean | 0 | 1;
  startup_stagger_enabled?: boolean | 0 | 1;
  startup_stagger_seconds?: number;
  notify_on_miner_pause?: boolean | 0 | 1;
  notify_on_miner_resume?: boolean | 0 | 1;
}

export function updatePlugConfig(patch: PlugConfigPatch): PlugConfig {
  const fields: string[] = [];
  const values: unknown[] = [];
  const setField = (k: string, v: unknown) => {
    fields.push(`${k} = ?`);
    values.push(v);
  };
  if (patch.enabled !== undefined) setField('enabled', patch.enabled ? 1 : 0);
  if (patch.mirror_miners !== undefined) setField('mirror_miners', patch.mirror_miners ? 1 : 0);
  if (patch.ha_url !== undefined) setField('ha_url', patch.ha_url);
  if (patch.ha_entity_id !== undefined) setField('ha_entity_id', patch.ha_entity_id);
  if (patch.ha_token !== undefined && patch.ha_token.length > 0) {
    setField('ha_token_encrypted', encrypt(patch.ha_token));
  }
  if (patch.safety_require_plug_on !== undefined)
    setField('safety_require_plug_on', patch.safety_require_plug_on ? 1 : 0);
  if (patch.alert_webhook_url !== undefined) setField('alert_webhook_url', patch.alert_webhook_url);
  if (patch.alert_webhook_enabled !== undefined)
    setField('alert_webhook_enabled', patch.alert_webhook_enabled ? 1 : 0);
  if (patch.startup_stagger_enabled !== undefined)
    setField('startup_stagger_enabled', patch.startup_stagger_enabled ? 1 : 0);
  if (patch.startup_stagger_seconds !== undefined) {
    const clamped = Math.max(0, Math.min(600, Math.round(patch.startup_stagger_seconds)));
    setField('startup_stagger_seconds', clamped);
  }
  if (patch.notify_on_miner_pause !== undefined)
    setField('notify_on_miner_pause', patch.notify_on_miner_pause ? 1 : 0);
  if (patch.notify_on_miner_resume !== undefined)
    setField('notify_on_miner_resume', patch.notify_on_miner_resume ? 1 : 0);
  if (fields.length === 0) return getPlugConfig();
  values.push(1);
  getDb()
    .prepare(`UPDATE plug_config SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getPlugConfig();
}

// ----- event log -----

export function logEvent(entry: Omit<EventLogEntry, 'id' | 'ts'>) {
  getDb()
    .prepare(
      `INSERT INTO event_log (miner_id, action, source, result, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(entry.miner_id, entry.action, entry.source, entry.result, entry.detail);
}

export function listEvents(opts: { limit?: number; offset?: number } = {}): EventLogEntry[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  return getDb()
    .prepare('SELECT * FROM event_log ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as EventLogEntry[];
}

// ----- settings -----

export function getSettings(): AppSettings {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    poll_interval_s: parseInt(map.poll_interval_s ?? '30'),
    connection_timeout_ms: parseInt(map.connection_timeout_ms ?? '5000'),
  };
}

export function updateSettings(patch: Partial<AppSettings>) {
  const stmt = getDb().prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(k, String(v));
  }
}

/** Get/set arbitrary string key in the settings table (used by electricity rates). */
export function getSettingValue(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSettingValue(key: string, value: string) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

// ----- stats history -----

export interface StatsHistoryRow {
  id: number;
  miner_id: number;
  ts: string; // SQLite-formatted UTC: 'YYYY-MM-DD HH:MM:SS'
  hashrate_th: number;
  power_w: number | null;
  max_chip_temp: number | null;
  status: string;
}

export function insertStatsHistory(row: {
  miner_id: number;
  hashrate_th: number;
  power_w: number | null;
  max_chip_temp: number | null;
  status: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO stats_history (miner_id, hashrate_th, power_w, max_chip_temp, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(row.miner_id, row.hashrate_th, row.power_w, row.max_chip_temp, row.status);
}

export function getStatsHistory(opts: {
  miner_id?: number;
  minutes?: number;
}): StatsHistoryRow[] {
  const minutes = Math.max(1, Math.min(opts.minutes ?? 60, 7 * 24 * 60));
  const params: unknown[] = [`-${minutes} minutes`];
  let sql = `SELECT * FROM stats_history WHERE ts >= datetime('now', ?)`;
  if (opts.miner_id !== undefined) {
    sql += ' AND miner_id = ?';
    params.push(opts.miner_id);
  }
  sql += ' ORDER BY ts ASC';
  return getDb().prepare(sql).all(...params) as StatsHistoryRow[];
}

/** Delete rows older than `retainHours`. Cheap to run periodically. */
export function pruneStatsHistory(retainHours: number = 7 * 24) {
  getDb()
    .prepare(`DELETE FROM stats_history WHERE ts < datetime('now', ?)`)
    .run(`-${retainHours} hours`);
}

// ----- plug history -----

export interface PlugHistoryRow {
  id: number;
  ts: string;
  plug_power_w: number | null;
  plug_energy_kwh: number | null;
}

export function insertPlugHistory(row: {
  plug_power_w: number | null;
  plug_energy_kwh: number | null;
}) {
  getDb()
    .prepare(`INSERT INTO plug_history (plug_power_w, plug_energy_kwh) VALUES (?, ?)`)
    .run(row.plug_power_w, row.plug_energy_kwh);
}

/** All plug history rows within the window (UTC SQLite time). */
export function getPlugHistory(opts: { minutes?: number }): PlugHistoryRow[] {
  const minutes = Math.max(1, Math.min(opts.minutes ?? 60, 7 * 24 * 60));
  return getDb()
    .prepare(`SELECT * FROM plug_history WHERE ts >= datetime('now', ?) ORDER BY ts ASC`)
    .all(`-${minutes} minutes`) as PlugHistoryRow[];
}

/** Earliest plug_history row at-or-after the given SQLite-formatted timestamp. */
export function getFirstPlugHistorySince(sqliteTs: string): PlugHistoryRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM plug_history WHERE ts >= ? ORDER BY ts ASC LIMIT 1`)
    .get(sqliteTs) as PlugHistoryRow | undefined;
}

/** Most recent plug_history row, or undefined if none. */
export function getLatestPlugHistory(): PlugHistoryRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM plug_history ORDER BY ts DESC LIMIT 1`)
    .get() as PlugHistoryRow | undefined;
}

export function prunePlugHistory(retainHours: number = 30 * 24) {
  getDb()
    .prepare(`DELETE FROM plug_history WHERE ts < datetime('now', ?)`)
    .run(`-${retainHours} hours`);
}
