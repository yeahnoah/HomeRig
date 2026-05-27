import type { MinerStats } from '@/types';

const map: Record<MinerStats['status'], { color: string; label: string }> = {
  mining: { color: 'led--green', label: 'Mining' },
  paused: { color: 'led--amber', label: 'Paused' },
  starting: { color: 'led--amber', label: 'Starting' },
  stopping: { color: 'led--amber', label: 'Stopping' },
  error: { color: 'led--red', label: 'Error' },
  offline: { color: 'led--gray', label: 'Offline' },
};

export function StatusLed({ status }: { status: MinerStats['status'] }) {
  const m = map[status] ?? { color: 'led--gray', label: status };
  return (
    <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wider">
      <span className={`led ${m.color}`} />
      <span className="text-muted">{m.label}</span>
    </span>
  );
}
