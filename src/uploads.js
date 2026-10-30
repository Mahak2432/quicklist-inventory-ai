import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || './data/uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));

export const ALLOWED_IMAGE_TYPES = Object.keys(EXT);

// Marketplaces fetch product images without logging in, so public image links
// carry an HMAC. Without a secret, a random one is used and links break on restart.
const MEDIA_SECRET = process.env.MEDIA_SECRET || randomBytes(32).toString('hex');

export function storeImage(buffer, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error(`Unsupported image type ${mime}`);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = `${randomUUID()}${ext}`;
  writeFileSync(join(UPLOAD_DIR, name), buffer);
  return name;
}

// Only bare file names are accepted, so a crafted value can't escape the upload folder.
export function readImage(name) {
  if (!name || name !== basename(name)) return null;
  const path = join(UPLOAD_DIR, name);
  if (!existsSync(path)) return null;
  return { buffer: readFileSync(path), mime: MIME_BY_EXT[extname(name)] ?? 'application/octet-stream' };
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
