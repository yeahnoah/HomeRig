'use client';
import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  accent?: 'amber' | 'green' | 'red' | 'blue' | 'plain';
  sublabel?: React.ReactNode;
}

const accentMap: Record<NonNullable<Props['accent']>, string> = {
  amber: 'text-accent',
  green: 'text-green',
  red: 'text-red',
  blue: 'text-blue',
  plain: 'text-foreground',
};

/**
 * A "mega" stat. Title above, large numeric value, optional unit and sublabel.
 * Includes a small count-up animation when the value changes so the dashboard
 * feels live without being noisy.
 */
export function HeroStat({ label, value, unit, accent = 'plain', sublabel }: Props) {
  const [display, setDisplay] = useState<string | number>(value);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    // Numeric values: animate count.
    const from = typeof prev.current === 'number' ? prev.current : parseFloat(String(prev.current));
    const to = typeof value === 'number' ? value : parseFloat(String(value));
    if (!isNaN(from) && !isNaN(to) && from !== to) {
      const dur = 500;
      const start = performance.now();
      const decimals = guessDecimals(value);
      let raf = 0;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        const cur = from + (to - from) * eased;
        setDisplay(cur.toFixed(decimals));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      prev.current = value;
      return () => cancelAnimationFrame(raf);
    }
    setDisplay(value);
    prev.current = value;
  }, [value]);

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-3xl md:text-4xl font-medium data ${accentMap[accent]}`}>
          {display}
        </span>
        {unit && (
          <span className="text-xs uppercase tracking-wider text-muted data">{unit}</span>
        )}
      </div>
      {sublabel && <div className="text-xs text-muted data">{sublabel}</div>}
    </div>
  );
}

function guessDecimals(v: string | number): number {
  const s = String(v);
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return Math.min(2, s.length - dot - 1);
}
