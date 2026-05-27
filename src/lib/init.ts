/**
 * One-time initialization. Called from instrumentation.ts on server startup.
 * Idempotent — safe to call from multiple entry points.
 */

import { seedIfEmpty } from './db';
import { startScheduler } from './scheduler';

// HMR-safe init flag: without globalThis, Turbopack would reset this on every
// rebuild and the instrumentation hook would seed/start over and over.
const g = globalThis as unknown as { __homerigInit?: boolean };

export function initialize() {
  if (g.__homerigInit) return;
  g.__homerigInit = true;
  seedIfEmpty();
  startScheduler();
}

/** Used by route handlers as a defensive bootstrap in case instrumentation didn't fire. */
export function ensureInitialized() {
  if (!g.__homerigInit) initialize();
}
