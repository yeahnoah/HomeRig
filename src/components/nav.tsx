'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/logs', label: 'Logs' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="border-b border-border bg-surface/60 backdrop-blur">
      <div className="mx-auto w-full max-w-6xl px-4 h-14 flex items-center gap-6">
        <Link href="/" className="font-semibold tracking-wide">
          <span className="text-accent">HOME</span>
          <span className="text-foreground">RIG</span>
        </Link>
        <ul className="flex items-center gap-1">
          {links.map((l) => {
            const active = l.href === '/' ? path === '/' : path?.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={
                    'px-3 py-1.5 rounded-md text-sm transition-colors ' +
                    (active
                      ? 'bg-surface-2 text-foreground'
                      : 'text-muted hover:text-foreground hover:bg-surface-2/60')
                  }
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
