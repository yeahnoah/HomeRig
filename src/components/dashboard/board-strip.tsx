'use client';

interface BoardCell {
  id: number;
  chip: number;
  outlet: number;
  inlet: number;
  hashrate_th: number;
  enabled: boolean;
}

/**
 * Three-column inline visualization of hashboard temps + hashrate.
 * Each board gets a small temperature gradient bar — hotter chip = more amber.
 */
export function BoardStrip({ boards }: { boards: BoardCell[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {boards.map((b) => (
        <BoardCellView key={b.id} board={b} />
      ))}
    </div>
  );
}

function BoardCellView({ board: b }: { board: BoardCell }) {
  // Map chip temperature into an intensity 0..1. 50°C = cool, 95°C = hot.
  const t = Math.min(1, Math.max(0, (b.chip - 50) / 45));
  const heatColor = `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, var(--surface-3))`;
  const baseColor = 'var(--surface-3)';

  return (
    <div className="rounded border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted">BD {b.id}</span>
        <span className="text-xs data text-foreground">{b.hashrate_th.toFixed(0)}</span>
      </div>
      {/* Heat strip: 6 segments from inlet to chip representing the temp gradient */}
      <div className="flex gap-[2px] h-1.5 rounded-sm overflow-hidden">
        {[b.inlet, b.outlet, b.chip].map((temp, i) => {
          const ti = Math.min(1, Math.max(0, (temp - 50) / 45));
          const col = `color-mix(in srgb, var(--accent) ${Math.round(ti * 100)}%, ${baseColor})`;
          return <div key={i} className="flex-1" style={{ background: col }} />;
        })}
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] mt-1 data text-muted">
        <span title="Inlet">{b.inlet ? `${b.inlet.toFixed(0)}°` : '—'}</span>
        <span title="Outlet" className="text-center">{b.outlet ? `${b.outlet.toFixed(0)}°` : '—'}</span>
        <span title="Chip" className="text-right" style={{ color: heatColor }}>
          {b.chip ? `${b.chip.toFixed(0)}°` : '—'}
        </span>
      </div>
    </div>
  );
}
