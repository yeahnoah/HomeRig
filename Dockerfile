# syntax=docker/dockerfile:1.6

# Build & run HomeRig on Linux. Works on ARM64 (Raspberry Pi) and x86_64.
# Multi-stage so the final image doesn't carry the build toolchain.

# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app

# Install deps (cached layer — only re-runs when lockfile changes)
COPY package.json package-lock.json* ./
RUN npm ci

# Build the app
COPY . .
RUN npm run build

# Strip dev dependencies after build so they don't bloat the runtime image
RUN npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/homerig.db

# Copy the minimum needed to run `next start`:
#   .next            → compiled app
#   public           → static assets
#   proto            → Braiins OS+ gRPC schemas (loaded at runtime)
#   next.config.ts   → serverExternalPackages config (read by next start)
#   package.json     → start script + module resolution
#   node_modules     → pruned to production deps only
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/proto ./proto
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

# SQLite + encryption key live here. Mount a host volume to persist them.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "run", "start"]
