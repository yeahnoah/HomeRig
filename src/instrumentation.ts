/**
 * Next.js instrumentation hook — runs once at server startup.
 * Docs: node_modules/next/dist/docs/01-app/02-guides/instrumentation.md
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initialize } = await import('./lib/init');
    initialize();
  }
}
