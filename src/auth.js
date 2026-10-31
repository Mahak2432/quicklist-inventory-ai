import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { InventoryError } from './inventory.js';

const scrypt = promisify(scryptCb);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Checked when an email is unknown, so a wrong email takes as long as a wrong password.
const UNUSED_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

// Tokens are shown once at creation. Only a SHA-256 hash is stored, so a
// leaked database does not leak working credentials.
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createTenant(db, name) {
  const tenantId = randomUUID();
  db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(tenantId, name);
  const { token } = issueToken(db, tenantId, 'default');
  return { tenantId, name, token };
}

export function issueToken(db, tenantId, label = 'api') {
  const token = `qli_${randomBytes(24).toString('base64url')}`;
  db.prepare('INSERT INTO api_tokens (token_hash, tenant_id, label) VALUES (?, ?, ?)')
    .run(hashToken(token), tenantId, label);
  return { token, label };
}

export function tenantForToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT tenant_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token));
  return row?.tenant_id ?? null;
}

export function revokeToken(db, token) {
  if (!token) return;
  db.prepare('UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hashToken(token));
}

export function getTenant(db, tenantId) {
  return db.prepare('SELECT id, name, created_at FROM tenants WHERE id = ?').get(tenantId) ?? null;
}

export function bearerFrom(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return m ? m[1].trim() : null;
}

// Passwords are stored as scrypt hashes with a random salt, never as plain text.
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

// Opens a shop with its owner's login and a first token, in one step.
export async function createAccount(db, { shop_name, email, password } = {}) {
  const shopName = String(shop_name ?? '').trim().slice(0, 100);
  const address = String(email ?? '').trim().toLowerCase().slice(0, 200);
  const secret = String(password ?? '');
  if (!shopName) throw new InventoryError('BAD_INPUT', 'Enter your shop name');
  if (!EMAIL_PATTERN.test(address)) throw new InventoryError('BAD_INPUT', 'Enter a valid email address');
  if (secret.length < 8) throw new InventoryError('BAD_INPUT', 'Use at least 8 characters for the password');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(address)) {
    throw new InventoryError('EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
  }

  const { tenantId, token } = createTenant(db, shopName);
  db.prepare('INSERT INTO users (id, tenant_id, email, password_hash) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), tenantId, address, await hashPassword(secret));
  return { token, tenant: { id: tenantId, name: shopName }, email: address };
}

export async function login(db, { email, password } = {}) {
  const address = String(email ?? '').trim().toLowerCase();
  const user = db.prepare('SELECT tenant_id, password_hash FROM users WHERE email = ?').get(address);
  const ok = await verifyPassword(String(password ?? ''), user?.password_hash ?? UNUSED_HASH);
  if (!user || !ok) throw new InventoryError('BAD_LOGIN', 'Email or password is not right');

  const { token } = issueToken(db, user.tenant_id, 'sign-in');
  return { token, tenant: getTenant(db, user.tenant_id), email: address };
}
