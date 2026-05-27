#!/usr/bin/env bash
# Per-app secret derivation. Umbrel sources this file before bringing the
# compose stack up. The resulting environment variables are baked into the
# container at runtime via ${...} substitution in docker-compose.yml.
#
# APP_SEED is a unique-per-app deterministic value provided by Umbrel.
# We hash it to get a 64-char hex string suitable for HOMERIG_ENCRYPTION_KEY
# (AES-256-GCM, 32-byte key).

export HOMERIG_ENCRYPTION_KEY=$(echo -n "homerig-encryption-${APP_SEED}" | sha256sum | cut -d' ' -f1)
