import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Seller credentials are encrypted with AES-256-GCM before they touch the
// database. The key lives only in the MASTER_KEY environment variable (32
// random bytes, base64). Without it, nothing can be saved, so credentials
// never sit in the database as plain text.
function masterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw) throw new Error('MASTER_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 random bytes, base64 encoded');
  return key;
}

export function vaultReady() {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

// Throws if the stored blob was changed, because the GCM tag will not match.
export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
