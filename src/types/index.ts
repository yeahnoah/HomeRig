export interface Miner {
  id: number;
  name: string;
  ip: string;
  grpc_port: number;
  username: string;
  password_encrypted: string;
  enabled: 1 | 0;
  created_at: string;
}

export interface MinerInput {
  name: string;
  ip: string;
  grpc_port?: number;
  username: string;
  password: string; // plaintext; encrypted before persistence
  enabled?: boolean;
}

/** A day-of-week bitmask. Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64. */
export type DowMask = number;

/** One contiguous time-of-day slot. start/end are "HH:MM" (24h, local). */
export interface TimeRange {
  start: string;
  end: string;
}

export interface BlackoutWindow {
  id: number;
  label: string;
  enabled: 1 | 0;
  /** YYYY-MM-DD or null for "always". When repeat_annually=1 only the MM-DD part is honored. */
  date_start: string | null;
  date_end: string | null;
  /** One or more time-of-day slots. If any slot matches, the window is active. */
  time_ranges: TimeRange[];
  /** day-of-week bitmask, 127 = every day */
  dow_mask: DowMask;
  /** When true, the date range wraps yearly (ignoring the YYYY part). */
  repeat_annually: 1 | 0;
  /** "all" or specific miner id as string */
  target: string;
  created_at: string;
}

export interface BlackoutInput {
  label: string;
  enabled?: boolean;
  date_start?: string | null;
  date_end?: string | null;
  time_ranges: TimeRange[];
  dow_mask: DowMask;
  repeat_annually?: boolean;
  target: string;
}

export interface PlugConfig {
  id: number;
  enabled: 1 | 0;
  /** if true, plug mirrors miner state (off during blackouts) */
  mirror_miners: 1 | 0;
  /** Home Assistant base URL, e.g. http://umbrel.local:8123 */
  ha_url: string;
  /** Encrypted long-lived access token */
  ha_token_encrypted: string;
  /** HA entity id of the switch, e.g. switch.eve_energy_20ebu4101 */
  ha_entity_id: string;
  /** Safety interlock: when 1, miners refuse to mine unless the plug is confirmed ON */
  safety_require_plug_on: 1 | 0;
  /** Discord/Slack/etc. webhook URL for alerts */
  alert_webhook_url: string;
  alert_webhook_enabled: 1 | 0;
  /** Stagger miner Resume by N seconds after the plug transitions OFF → ON */
  startup_stagger_enabled: 1 | 0;
  startup_stagger_seconds: number;
  notify_on_miner_pause: 1 | 0;
  notify_on_miner_resume: 1 | 0;
}

/**
 * Profitability guard config (singleton row, id=1).
 *
 * When enabled, the scheduler pauses miners + plug when the live BTC price drops
 * below the break-even price (marginal energy cost ÷ BTC mined/day), with
 * hysteresis to prevent flapping. Mirrors the plug_config table pattern.
 */
export interface ProfitConfig {
  id: number;
  /** Master switch for the profitability guard. */
  enabled: 1 | 0;
  /** Braiins Pool API token, encrypted at rest. */
  pool_token_encrypted: string;
  /** BTC price source: 'coinbase' | 'kraken'. */
  price_source: string;
  /** Price must stay below break-even this many minutes before we pause (hysteresis). */
  pause_below_minutes: number;
  /** Price must recover this % ABOVE break-even before we resume (hysteresis). */
  resume_margin_pct: number;
  /** When 1, use a fixed manual price floor instead of the dynamic break-even. */
  manual_floor_enabled: 1 | 0;
  /** Manual price floor in USD/BTC (used when manual_floor_enabled=1). */
  manual_floor_usd: number;
  /** Override for the rig's running power in watts (0 = auto-detect from history). */
  running_watts_override: number;
  /** Notify when the guard pauses the rig (price dropped below break-even). */
  notify_on_trip: 1 | 0;
  /** Notify when the guard resumes the rig (price recovered). */
  notify_on_recover: 1 | 0;
}

export interface MinerStats {
  minerId: number;
  status: 'mining' | 'paused' | 'starting' | 'stopping' | 'error' | 'offline';
  hashrate_th: number;
  power_w: number | null;
  uptime_s: number | null;
  hashboards: HashboardStats[];
  pool_url: string | null;
  pool_user: string | null;
  shares_accepted: number | null;
  shares_rejected: number | null;
  fetched_at: string;
  error?: string;
}

export interface HashboardStats {
  id: number;
  hashrate_th: number;
  temp_chip: number;
  temp_inlet: number;
  temp_outlet: number;
  chips_count: number;
  enabled: boolean;
}

export interface EventLogEntry {
  id: number;
  ts: string;
  miner_id: number | null;
  action: 'pause' | 'resume' | 'restart' | 'reboot' | 'plug_on' | 'plug_off' | 'login' | 'poll' | 'system';
  source: string; // "manual:UI" | "scheduler:<window_label>" | "startup" | "shutdown"
  result: 'success' | 'error';
  detail: string | null;
}

export interface AppSettings {
  poll_interval_s: number;
  connection_timeout_ms: number;
}
