'use client';
import { useCallback, useEffect, useState } from 'react';

// ─── shapes ──────────────────────────────────────────────────────────────────
export interface ThermalBoard {
  id: number;
  temp_chip: number;
  temp_board: number;
  chip_sensor_id: number | null;
  hashrate_th: number;
  enabled: boolean;
}
export interface ThermalMiner {
  id: number;
  name: string;
  stats: { status: string; hashboards: ThermalBoard[] } | null;
}
interface ThermalCfg {
  enabled: boolean;
  chip_ceiling_c: number;
  board_ceiling_c: number;
  reset_margin_c: number;
  faulty: { miner_id: number; board_id: number }[];
}
interface MinerGuard {
  latched: boolean;
  hard_latched: boolean;
  trips: number;
  eval: { danger: boolean; hottest_board_c: number; hottest_chip_c: number; reason: string } | null;
}
interface ThermalResp {
  config: ThermalCfg;
  state: { enabled: boolean; miners: Record<number, MinerGuard> };
}

// 55°C green → ~108°C red. Used for chip pills and readouts.
function heat(t: number): string {
  if (!t) return 'var(--surface-3)';
  const c = Math.max(55, Math.min(108, t));
  const hue = 150 - ((c - 55) / (108 - 55)) * 150;
  return `hsl(${hue}, 75%, 48%)`;
}

export function ThermalSection({ miners }: { miners: ThermalMiner[] }) {
  const [thermal, setThermal] = useState<ThermalResp | null>(null);
  const load = useCallback(() => {
    fetch('/api/thermal').then((r) => r.json()).then(setThermal).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  const toggleFaulty = async (miner_id: number, board_id: number) => {
    await fetch('/api/thermal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toggle_faulty: { miner_id, board_id } }),
    });
    load();
  };

  const withBoards = miners.filter((m) => (m.stats?.hashboards?.length ?? 0) > 0);
  if (withBoards.length === 0) return null;

  const cfg = thermal?.config;
  const isFaulty = (mid: number, bid: number) =>
    cfg?.faulty.some((f) => f.miner_id === mid && f.board_id === bid) ?? false;

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4 fade-up">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-medium">Hashboard thermals</h3>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
            per-board chip + PCB sensors · click a board to flag its chip sensor faulty
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`led ${thermal?.config.enabled ? 'led--green' : 'led--gray'}`} />
          <span className="text-muted">
            watchdog {thermal?.config.enabled ? `on · pause ≥ ${cfg?.board_ceiling_c}°C PCB` : 'off'}
          </span>
        </div>
      </header>

      <div className="space-y-4">
        {withBoards.map((m) => (
          <MinerThermal
            key={m.id}
            miner={m}
            guard={thermal?.state.miners[m.id]}
            isFaulty={(bid) => isFaulty(m.id, bid)}
            onToggleFaulty={(bid) => toggleFaulty(m.id, bid)}
          />
        ))}
      </div>
    </section>
  );
}

function MinerThermal({
  miner, guard, isFaulty, onToggleFaulty,
}: {
  miner: ThermalMiner;
  guard?: MinerGuard;
  isFaulty: (boardId: number) => boolean;
  onToggleFaulty: (boardId: number) => void;
}) {
  const boards = miner.stats?.hashboards ?? [];
  const status = (() => {
    if (guard?.hard_latched) return { label: 'HELD — overheating', cls: 'text-red', led: 'led--red' };
    if (guard?.latched) return { label: 'paused — cooling', cls: 'text-accent', led: 'led--amber' };
    if (guard?.eval?.danger) return { label: 'overheat', cls: 'text-red', led: 'led--red' };
    return { label: miner.stats?.status ?? '—', cls: 'text-muted', led: 'led--green' };
  })();

  return (
    <div className="rounded border border-border bg-surface-2 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{miner.name}</span>
        <span className="flex items-center gap-1.5 text-[10px]">
          <span className={`led ${status.led}`} />
          <span className={`uppercase tracking-wider ${status.cls}`}>{status.label}</span>
          {guard?.eval && (
            <span className="text-muted data ml-1">
              hot {guard.eval.hottest_board_c.toFixed(0)}°C PCB / {guard.eval.hottest_chip_c.toFixed(0)}°C chip
            </span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {boards.map((b) => (
          <BoardCard
            key={b.id}
            board={b}
            faulty={isFaulty(b.id)}
            onToggle={() => onToggleFaulty(b.id)}
          />
        ))}
      </div>
    </div>
  );
}

const COLS = 12;
const ROWS = 6;

function BoardCard({
  board: b, faulty, onToggle,
}: {
  board: ThermalBoard;
  faulty: boolean;
  onToggle: () => void;
}) {
  // The gRPC API exposes only the hottest chip sensor + the board/PCB sensor per
  // board (no per-chip grid). We render a heat field that runs from the PCB temp
  // (cooler, air-inlet side) to the hottest chip temp (air-outlet side) — a
  // physically-grounded representation using the two real readings, not invented
  // per-chip data.
  const lo = b.temp_board || b.temp_chip;
  const hi = b.temp_chip || b.temp_board;
  const cells = Array.from({ length: COLS * ROWS }, (_, i) => {
    const col = i % COLS;
    const frac = COLS > 1 ? col / (COLS - 1) : 0;
    return lo + (hi - lo) * frac;
  });

  return (
    <button
      onClick={onToggle}
      title={faulty ? 'Chip sensor flagged faulty — click to trust again' : 'Click to flag this chip sensor as faulty (ignored by the watchdog)'}
      className={`text-left rounded border p-2 transition ${
        faulty ? 'border-dashed border-muted/50 bg-surface/40' : 'border-border bg-surface hover:border-accent-dim'
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted">Board {b.id}</span>
        <span className="text-sm data" style={{ color: faulty ? 'var(--muted)' : heat(b.temp_chip) }}>
          {b.temp_chip ? `${b.temp_chip.toFixed(0)}°` : '—'}
          {faulty && <span className="text-[9px] text-muted ml-1">ignored</span>}
        </span>
      </div>
      {/* heat field (inlet → outlet) */}
      <div
        className="grid gap-[2px] rounded-sm overflow-hidden mb-1.5"
        style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}
      >
        {cells.map((t, i) => (
          <span
            key={i}
            className="h-1.5 rounded-[1px]"
            style={{ background: faulty ? 'var(--surface-3)' : heat(t), opacity: faulty ? 0.4 : 1 }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px] data text-muted">
        <span title="Hottest chip sensor">
          chip {b.temp_chip ? `${b.temp_chip.toFixed(0)}°` : '—'}
          {b.chip_sensor_id != null && <span className="text-muted/60"> ·T{b.chip_sensor_id}</span>}
        </span>
        <span title="Board / PCB sensor (independent)">PCB {b.temp_board ? `${b.temp_board.toFixed(0)}°` : '—'}</span>
      </div>
    </button>
  );
}
