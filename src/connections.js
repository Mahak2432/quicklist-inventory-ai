import { CONNECTORS, matchListings, pushStock as pushOne, testConnection, validateFields } from './connectors.js';
import { InventoryError, linkSkusToChannel, SKU_LINKED } from './inventory.js';
import { decrypt, encrypt, vaultReady } from './vault.js';

// Stores each seller's connection keys. Secret fields are encrypted as one
// blob. Non-secret values are kept in the clear so the form can show them.
// Secret values are never returned by any function in this file.

export function loadFields(db, tenantId, platform) {
  const row = db.prepare('SELECT secret_blob FROM connections WHERE tenant_id = ? AND platform = ?').get(tenantId, platform);
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.secret_blob));
  } catch {
    return null;
  }
}

// Links each SKU to the store's own product or variant ID, when the store has one.
async function matchStoreIds(db, tenantId, platform, fields) {
  const skus = db.prepare('SELECT sku FROM variants WHERE tenant_id = ?').all(tenantId).map((r) => r.sku);
  if (!skus.length) return 0;
  const matches = await matchListings(platform, fields, skus);
  for (const [sku, listingId] of matches) {
    db.prepare(`INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id) VALUES (?, ?, ?, ?)
                ON CONFLICT(tenant_id, sku, platform) DO UPDATE SET platform_listing_id = excluded.platform_listing_id, updated_at = CURRENT_TIMESTAMP`)
      .run(tenantId, sku, platform, listingId);
  }
  return matches.size;
}

function withMatches(detail, matched) {
  if (!matched) return detail;
  return `${detail} Matched ${matched} SKU${matched === 1 ? '' : 's'} to store IDs.`;
}

export async function saveConnection(db, tenantId, platform, input) {
  const def = CONNECTORS[platform];
  if (!vaultReady()) {
    throw new InventoryError('VAULT_OFF', 'The server needs a MASTER_KEY before it can save credentials.');
  }
  const previous = loadFields(db, tenantId, platform) ?? {};
  const merged = {};
  for (const f of def.fields) {
    const typed = typeof input[f.name] === 'string' ? input[f.name].trim() : '';
    // A blank secret keeps the saved value, so editing one field does not force re-entering the others.
    const value = typed || (f.secret ? previous[f.name] || '' : '');
    if (!value && !f.optional) throw new InventoryError('MISSING_FIELD', `${f.label} is required`);
    if (value) merged[f.name] = value.slice(0, 500);
  }

  let fields;
  try {
    fields = validateFields(platform, merged);
  } catch (err) {
    throw new InventoryError(err.code || 'BAD_FIELD', err.message);
  }

  const result = await testConnection(platform, fields);
  const matched = result.ok ? await matchStoreIds(db, tenantId, platform, fields) : 0;
  const detail = withMatches(result.detail, matched);
  db.prepare(`INSERT INTO connections (tenant_id, platform, status, secret_blob, public_json, detail, tested_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT(tenant_id, platform) DO UPDATE SET
                status = excluded.status, secret_blob = excluded.secret_blob, public_json = excluded.public_json,
                detail = excluded.detail, tested_at = excluded.tested_at, updated_at = excluded.updated_at`)
    .run(
      tenantId,
      platform,
      result.ok ? 'CONNECTED' : 'ERROR',
      encrypt(JSON.stringify(fields)),
      JSON.stringify(publicValues(def, fields)),
      detail,
    );

  if (result.ok && SKU_LINKED.includes(platform)) linkSkusToChannel(db, tenantId, platform);
  return listOne(db, tenantId, platform);
}

export async function retestConnection(db, tenantId, platform) {
  const fields = loadFields(db, tenantId, platform);
  if (!fields) throw new InventoryError('NOT_FOUND', `Connect ${CONNECTORS[platform].label} first`);
  const result = await testConnection(platform, fields);
  const matched = result.ok ? await matchStoreIds(db, tenantId, platform, fields) : 0;
  const detail = withMatches(result.detail, matched);
  db.prepare(`UPDATE connections SET status = ?, detail = ?, tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = ? AND platform = ?`)
    .run(result.ok ? 'CONNECTED' : 'ERROR', detail, tenantId, platform);
  return listOne(db, tenantId, platform);
}

export function removeConnection(db, tenantId, platform) {
  db.prepare('DELETE FROM connections WHERE tenant_id = ? AND platform = ?').run(tenantId, platform);
}

export function listConnections(db, tenantId) {
  return Object.keys(CONNECTORS).map((platform) => listOne(db, tenantId, platform));
}

export function listDemoPushes(db, tenantId) {
  return db.prepare('SELECT sku, qty, created_at FROM demo_pushes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20').all(tenantId);
}

// Used by the outbox. Reads keys only at push time and never returns them.
export function pushForTenant(db, tenantId, platform, args) {
  const fields = loadFields(db, tenantId, platform);
  if (!fields) return Promise.resolve({ ok: false, skipped: true, error: `Connect ${CONNECTORS[platform].label} to send stock` });
  return pushOne(platform, fields, args, { db, tenantId });
}

function publicValues(def, fields) {
  const out = {};
  for (const f of def.fields) {
    const v = fields[f.name];
    out[f.name] = f.secret ? { saved: Boolean(v), hint: v ? v.slice(-4) : '' } : v ?? '';
  }
  return out;
}

function listOne(db, tenantId, platform) {
  const def = CONNECTORS[platform];
  const row = db.prepare('SELECT status, detail, tested_at, public_json FROM connections WHERE tenant_id = ? AND platform = ?').get(tenantId, platform);
  return {
    platform,
    label: def.label,
    kind: def.kind,
    blurb: def.blurb,
    guide: def.guide ?? '',
    fields: def.fields.map((f) => ({
      name: f.name,
      label: f.label,
      secret: Boolean(f.secret),
      optional: Boolean(f.optional),
      help: f.help ?? '',
      default: f.default ?? '',
    })),
    status: row?.status ?? 'NOT_CONNECTED',
    detail: row?.detail ?? '',
    tested_at: row?.tested_at ?? null,
    values: row ? JSON.parse(row.public_json) : {},
  };
}
