# HomeRig — Braiins OS Scheduler

A minimal local web app to schedule on/off cycles for Antminer miners running **Braiins OS+** firmware, plus simultaneous control of an Eve smart plug (via Homebridge) that powers the cooling fans.

This replaces the previous HomeRig project that targeted stock Antminer firmware. The old codebase is archived at `../homerig-stock.archive/`.

## Key constraints (do not deviate without checking)

- **Next.js 16 / React 19 / App Router.** Read `node_modules/next/dist/docs/` before writing route handlers, layouts, or instrumentation — Next 16 has breaking changes from older training data.
- **gRPC, not REST.** Braiins OS+ exposes a canonical gRPC API on port `50051`. The proto files live in `proto/bos/v1/`. We use `@grpc/grpc-js` + `@grpc/proto-loader` to talk to it directly.
- **Auth flow:** `AuthenticationService.Login(username, password)` → token. Token goes in the `authorization` gRPC metadata header on every subsequent call. Tokens timeout and must be refreshed.
- **Blackout windows model.** Miners run by default. A "blackout window" defines when they must be OFF (date range + day-of-week mask + start/end time). The scheduler tick (every minute) reconciles: in any active window → `PauseMining`; otherwise → `ResumeMining`. The Eve plug mirrors this state.
- **All config in SQLite at `data/homerig.db`.** Miner IPs, credentials (encrypted), Homebridge config, windows, settings. Nothing hardcoded.
- **LAN only.** No public exposure. Designed to be deployed as a Docker container on the user's Umbrel server.

## Architecture

```
src/
  app/                — Next.js App Router pages + route handlers
  lib/
    braiins-api.ts    — gRPC client (Login, PauseMining, ResumeMining, GetMinerStats)
    db.ts             — SQLite schema + query helpers
    blackouts.ts      — "is now inside any active window" evaluator
    scheduler.ts      — cron tick that calls braiins-api + homebridge to reconcile state
    homebridge.ts     — HTTP client for Homebridge plug API
    init.ts           — one-time initialization (seed DB, start scheduler)
  instrumentation.ts  — Next.js startup hook → calls init()
  types/              — shared types
proto/bos/v1/         — Braiins OS+ proto files (vendored from braiins/bos-plus-api)
data/                 — SQLite DB lives here
```

## Tools & conventions

- IBM Plex Mono for data, IBM Plex Sans for UI (same as previous HomeRig).
- Dark theme, industrial control-panel aesthetic. Amber accents, no gradients.
- `shadcn/ui` for buttons/inputs/dialogs (install on demand).
- Always include exact terminal commands when giving instructions to the user.

@AGENTS.md
