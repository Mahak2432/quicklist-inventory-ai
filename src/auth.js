import { createHash, randomBytes, randomUUID } from 'node:crypto';

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

export function getTenant(db, tenantId) {
  return db.prepare('SELECT id, name, created_at FROM tenants WHERE id = ?').get(tenantId) ?? null;
}

export function bearerFrom(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return m ? m[1].trim() : null;
}
