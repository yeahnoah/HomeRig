/**
 * Thermal watchdog — the safety backstop for running with the firmware's
 * "Override Chip Temperature Safety Check" enabled (i.e. the miner's own
 * dangerous-temp cutoff disabled).
 *
 * The decision is keyed off the INDEPENDENT board/PCB sensor, not the chip
 * sensor, because the chip sensor is the one that can be faulty (the phantom
 * "T2 = 110°C" trips). A real hotspot always shows up on the PCB and the other
 * boards too, so:
 *
 *   pause if  ANY board PCB ≥ board_ceiling
 *         OR  ANY TRUSTED chip ≥ chip_ceiling   (boards flagged faulty are skipped)
 *
 * A single faulty chip sensor screaming 110 therefore does NOT pause the rig
 * (its board is flagged + its PCB stays normal), while genuine, corroborated
 * heat does. Validated against an 8-minute unprotected run where real temps
 * peaked at ~98°C chip / ~83°C PCB.
 *
 * Pure module: it does NOT pause anything. The scheduler owns the latch and the
 * pause/resume, using evaluate() + safeToResume().
 */

import { getSettingValue, setSettingValue } from './db';
import type { MinerStats } from '@/types';

export interface FaultySensor {
  miner_id: number;
  board_id: number;
}

export interface ThermalConfig {
  enabled: boolean;
  /** Trusted chip-sensor ceiling (°C). */
  chip_ceiling_c: number;
  /** Independent board/PCB sensor ceiling (°C) — the primary real-heat signal. */
  board_ceiling_c: number;
  /** Temps must drop this far below the ceilings before a latched pause clears. */
  reset_margin_c: number;
  /** Chip sensors that are known faulty and excluded from the chip check. */
  faulty: FaultySensor[];
}

const KEYS = {
  enabled: 'thermal_enabled',
  chip: 'thermal_chip_ceiling_c',
  board: 'thermal_board_ceiling_c',
  reset: 'thermal_reset_margin_c',
  faulty: 'thermal_faulty_json',
} as const;

export function getThermalConfig(): ThermalConfig {
  let faulty: FaultySensor[] = [];
  try {
    const raw = getSettingValue(KEYS.faulty);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        faulty = parsed
          .filter((x) => x && typeof x.miner_id === 'number' && typeof x.board_id === 'number')
          .map((x) => ({ miner_id: x.miner_id, board_id: x.board_id }));
      }
    }
  } catch {
    /* corrupt JSON — treat as none */
  }
  return {
    enabled: (getSettingValue(KEYS.enabled) ?? '0') === '1',
    chip_ceiling_c: parseFloat(getSettingValue(KEYS.chip) ?? '105'),
    board_ceiling_c: parseFloat(getSettingValue(KEYS.board) ?? '90'),
    reset_margin_c: parseFloat(getSettingValue(KEYS.reset) ?? '8'),
    faulty,
  };
}

export interface ThermalConfigPatch {
  enabled?: boolean;
  chip_ceiling_c?: number;
  board_ceiling_c?: number;
  reset_margin_c?: number;
  faulty?: FaultySensor[];
}

export function updateThermalConfig(patch: ThermalConfigPatch): ThermalConfig {
  if (patch.enabled !== undefined) setSettingValue(KEYS.enabled, patch.enabled ? '1' : '0');
  if (patch.chip_ceiling_c !== undefined)
    setSettingValue(KEYS.chip, String(Math.max(60, Math.min(130, patch.chip_ceiling_c))));
  if (patch.board_ceiling_c !== undefined)
    setSettingValue(KEYS.board, String(Math.max(50, Math.min(120, patch.board_ceiling_c))));
  if (patch.reset_margin_c !== undefined)
    setSettingValue(KEYS.reset, String(Math.max(1, Math.min(30, patch.reset_margin_c))));
  if (patch.faulty !== undefined) setSettingValue(KEYS.faulty, JSON.stringify(patch.faulty));
  return getThermalConfig();
}

export function isSensorFaulty(cfg: ThermalConfig, minerId: number, boardId: number): boolean {
  return cfg.faulty.some((f) => f.miner_id === minerId && f.board_id === boardId);
}

export interface ThermalEvaluation {
  /** True when a real (corroborated) overheat is detected. */
  danger: boolean;
  /** Highest board/PCB temp across boards (°C). */
  hottest_board_c: number;
  /** Highest TRUSTED chip temp across boards (°C), faulty sensors excluded. */
  hottest_chip_c: number;
  /** Which board(s) drove the decision. */
  reason: string;
}

/**
 * Evaluate a miner's latest stats against the thermal ceilings. Read-only.
 */
export function evaluateThermal(
  minerId: number,
  stats: MinerStats,
  cfg: ThermalConfig
): ThermalEvaluation {
  const boards = stats.hashboards ?? [];
  if (boards.length === 0) {
    return { danger: false, hottest_board_c: 0, hottest_chip_c: 0, reason: 'no board data' };
  }
  let hottestBoard = 0;
  let hottestTrustedChip = 0;
  let boardCulprit = -1;
  let chipCulprit = -1;
  for (const b of boards) {
    const boardT = b.temp_board || b.temp_outlet || 0;
    if (boardT > hottestBoard) {
      hottestBoard = boardT;
      boardCulprit = b.id;
    }
    if (!isSensorFaulty(cfg, minerId, b.id) && b.temp_chip > hottestTrustedChip) {
      hottestTrustedChip = b.temp_chip;
      chipCulprit = b.id;
    }
  }
  const boardDanger = hottestBoard >= cfg.board_ceiling_c;
  const chipDanger = hottestTrustedChip >= cfg.chip_ceiling_c;
  let reason = 'ok';
  if (boardDanger)
    reason = `board ${boardCulprit} PCB ${hottestBoard.toFixed(0)}°C ≥ ${cfg.board_ceiling_c}°C`;
  else if (chipDanger)
    reason = `board ${chipCulprit} chip ${hottestTrustedChip.toFixed(0)}°C ≥ ${cfg.chip_ceiling_c}°C`;
  return {
    danger: boardDanger || chipDanger,
    hottest_board_c: hottestBoard,
    hottest_chip_c: hottestTrustedChip,
    reason,
  };
}

/**
 * True when temps have dropped far enough below the ceilings to clear a latched
 * thermal pause (hysteresis so we don't flap right at the ceiling).
 */
export function safeToResume(
  minerId: number,
  stats: MinerStats,
  cfg: ThermalConfig
): boolean {
  const ev = evaluateThermal(minerId, stats, cfg);
  return (
    ev.hottest_board_c <= cfg.board_ceiling_c - cfg.reset_margin_c &&
    ev.hottest_chip_c <= cfg.chip_ceiling_c - cfg.reset_margin_c
  );
}
