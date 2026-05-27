# HomeRig

A minimal local web app to schedule on/off cycles for Antminer S21 XP miners running **Braiins OS+**, plus simultaneous control of an Eve smart plug (via Homebridge) that powers the cooling fans.

This is the "Braiins OS+ era" rebuild — the previous HomeRig that targeted stock Antminer firmware lives in `../homerig-stock.archive/`.

## What it does

- **Dashboard** — live status of every miner (hashrate, power, temps per board, uptime). Pause / Resume / Restart per miner.
- **Schedules** — define **blackout windows** when miners must be paused (e.g. peak-pricing hours in June–September weekdays 9am–9pm). Outside any active window, miners run.
- **Eve smart plug control** — the plug powering your fans automatically mirrors miner state via Homebridge (on when at least one miner is mining, off when all are paused).
- **Logs** — every automated and manual action with timestamp, source, and result.
- **Settings** — miner credentials (encrypted at rest), Homebridge config, polling intervals.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- `better-sqlite3` for persistence
- `croner` for cron scheduling
- `@grpc/grpc-js` + `@grpc/proto-loader` for Braiins OS+ control
- Homebridge HTTP API for the Eve plug

## How it talks to the miners

Braiins OS+ exposes a gRPC API on port `50051`. The proto files are vendored from [braiins/bos-plus-api](https://github.com/braiins/bos-plus-api) under `proto/bos/v1/`.

Auth flow:

1. `AuthenticationService.Login(username, password)` → returns `{ token, timeout_s }`.
2. Token is attached as `authorization` metadata on subsequent calls. Cached until ~5s before expiry, then auto-refreshed.
3. On `UNAUTHENTICATED`, the cache is invalidated and login is retried once.

The scheduler ticks every minute, polls each miner, evaluates active blackout windows, and reconciles state by issuing `PauseMining` / `ResumeMining`. The poll loop (default 30s) refreshes stats independently.

## Local setup

Prereqs: Node 20+, network reach to your miners.

```bash
# 1. Generate an encryption key
openssl rand -hex 32

# 2. Save it
cp .env.local.example .env.local
# then edit .env.local and paste the key into HOMERIG_ENCRYPTION_KEY

# 3. Install and run
npm install
npm run dev
```

Open <http://localhost:3000>. On first boot the DB is seeded with two miners at `192.168.5.15` and `192.168.5.16` (root/root). Update them in **Settings** if yours differ.

### Configure the Eve plug (via Home Assistant)

The newer Eve Energy (Matter-over-Thread) plug needs a full Matter controller stack — HomeRig defers that to Home Assistant.

**Prerequisites on your home server**:
1. **Python Matter Server** running (Docker, host networking, port 5580)
2. **Home Assistant** with the Matter integration pointed at the Matter Server (`ws://<host-ip>:5580/ws`)
3. The plug already commissioned to HA's Matter integration. (Eve plug uses Matter-over-Thread, so you also need a Thread Border Router on your network — HomePod mini, Apple TV 4K, Eero 6+, Nanoleaf, etc.)
4. A **long-lived access token** in HA (Profile → Security → Long-Lived Access Tokens)
5. The plug's **entity ID** in HA (Settings → Devices & Services → Matter → your plug → look for the switch entity, e.g. `switch.eve_energy_xxxxx`)

**In HomeRig Settings → Eve Smart Plug**:
- Home Assistant URL: `http://umbrel.local:8123` (or whatever HA is reachable at)
- Switch entity ID: paste from above
- Long-lived access token: paste from HA (stored encrypted at rest)
- Check **Enabled** and **Mirror miner state**, then **Test** and **Save**

HomeRig will call HA's `switch.turn_on` / `switch.turn_off` services on the entity. HA handles the Matter protocol, the Thread network, and the actual plug.

## Production deployment

### PM2 (any always-on Mac/Linux box)

```bash
npm install -g pm2
npm run build
pm2 start npm --name homerig -- start
pm2 save
pm2 startup   # follow the printed instructions to enable on boot
```

### Docker (Umbrel or any Docker host)

```bash
docker build -t homerig .
docker run -d --name homerig \
  --restart unless-stopped \
  -p 3000:3000 \
  -e HOMERIG_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v homerig-data:/app/data \
  homerig
```

**Important**: the encryption key must remain stable across restarts — otherwise saved miner passwords can't be decrypted. Store it in a `.env` file mounted into the container, or use Docker secrets.

### Umbrel community app (planned)

The included `Dockerfile` builds an image suitable for Umbrel. Future work: publish a `umbrel-app.yml` for one-click install.

## Project layout

```
src/
  app/                  Next.js App Router pages + route handlers
  lib/
    braiins-api.ts      gRPC client (Login, PauseMining, ResumeMining, GetMinerStats)
    db.ts               SQLite schema + helpers
    blackouts.ts        Window evaluator
    scheduler.ts        Poll + reconcile loop (croner)
    homebridge.ts       Homebridge HTTP API client
    init.ts             One-time startup (seed DB, start scheduler)
    crypto.ts           AES-GCM at-rest encryption for credentials
  instrumentation.ts    Next.js startup hook
  types/                Shared types
proto/bos/v1/           Vendored Braiins OS+ proto files
data/                   SQLite DB (gitignored)
```

## Discovering miner IPs and ports

```bash
# CGMiner-compat API (read sanity check)
echo '{"command":"version"}' | nc -w 5 192.168.5.15 4028

# gRPC port reachability
nc -zv 192.168.5.15 50051
```

## License

Personal use. Vendored proto files from braiins/bos-plus-api are GPL-3.0.
