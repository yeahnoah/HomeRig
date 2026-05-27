import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.HOMERIG_ENCRYPTION_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
  }
  // Dev fallback: derive a key from a host-stable string + warn. Production
  // setups MUST provide HOMERIG_ENCRYPTION_KEY.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'HOMERIG_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32'
    );
  }
  console.warn(
    '[crypto] HOMERIG_ENCRYPTION_KEY not set — using insecure development key. Do NOT use in production.'
  );
  cachedKey = scryptSync('homerig-dev-key', 'homerig-dev-salt', 32);
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  if (!plaintext) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string): string {
  if (!payload) return '';
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const [iv, tag, enc] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
