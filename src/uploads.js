import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export const ALLOWED_IMAGE_TYPES = Object.keys(EXT);

// Marketplaces fetch product images without logging in, so public image links
// carry an HMAC. Without a secret, a random one is used and links break on restart.
const MEDIA_SECRET = process.env.MEDIA_SECRET || randomBytes(32).toString('hex');

// Photos are stored in the database, not on the server's disk. Hosts such as Render
// wipe the disk on every deploy, which left product links pointing at nothing.
export async function storeImage(db, buffer, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error(`Unsupported image type ${mime}`);
  const name = `${randomUUID()}${ext}`;
  await db.prepare('INSERT INTO image_files (name, mime, data) VALUES (?, ?, ?)').run(name, mime, buffer);
  return name;
}

// Only bare file names are looked up, so a crafted value can't match another photo.
export async function readImage(db, name) {
  if (!name || name !== basename(name)) return null;
  const row = await db.prepare('SELECT mime, data FROM image_files WHERE name = ?').get(name);
  if (!row) return null;
  return { buffer: Buffer.from(row.data), mime: row.mime };
}

export function signMedia(draftId, variant) {
  return createHmac('sha256', MEDIA_SECRET).update(`${draftId}:${variant}`).digest('hex');
}

export function verifyMedia(draftId, variant, sig) {
  if (!sig) return false;
  const expected = Buffer.from(signMedia(draftId, variant));
  const received = Buffer.from(String(sig));
  return expected.length === received.length && timingSafeEqual(expected, received);
}
