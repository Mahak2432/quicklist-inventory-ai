import {
  addShopifyPhotos,
  CONNECTORS,
  createShopifyProduct,
  matchListings,
  pushStock as pushOne,
  setShopifyStock,
  shopifyPhotoCount,
  shopifyProductBody,
  shopifyProductIdForVariant,
  testConnection,
  validateFields,
} from './connectors.js';
import { InventoryError, linkSkusToChannel, listProducts, SKU_LINKED } from './inventory.js';
import { decrypt, encrypt, vaultReady } from './vault.js';

// Stores each seller's connection keys. Secret fields are encrypted as one
// blob. Non-secret values are kept in the clear so the form can show them.
// Secret values are never returned by any function in this file.

export async function loadFields(db, tenantId, platform) {
  const row = await db.prepare('SELECT secret_blob FROM connections WHERE tenant_id = ? AND platform = ?').get(tenantId, platform);
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.secret_blob));
  } catch {
    return null;
  }
}

// Links each SKU to the store's own product or variant ID, when the store has one.
async function matchStoreIds(db, tenantId, platform, fields) {
  const skus = (await db.prepare('SELECT sku FROM variants WHERE tenant_id = ?').all(tenantId)).map((r) => r.sku);
  if (!skus.length) return 0;
  const matches = await matchListings(platform, fields, skus);
  for (const [sku, listingId] of matches) {
    await db.prepare(`INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id) VALUES (?, ?, ?, ?)
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
  const previous = (await loadFields(db, tenantId, platform)) ?? {};
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
  await db.prepare(`INSERT INTO connections (tenant_id, platform, status, secret_blob, public_json, detail, tested_at, updated_at)
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

  if (result.ok && SKU_LINKED.includes(platform)) await linkSkusToChannel(db, tenantId, platform);
  return listOne(db, tenantId, platform);
}

export async function retestConnection(db, tenantId, platform) {
  const fields = await loadFields(db, tenantId, platform);
  if (!fields) throw new InventoryError('NOT_FOUND', `Connect ${CONNECTORS[platform].label} first`);
  const result = await testConnection(platform, fields);
  const matched = result.ok ? await matchStoreIds(db, tenantId, platform, fields) : 0;
  const detail = withMatches(result.detail, matched);
  await db.prepare(`UPDATE connections SET status = ?, detail = ?, tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = ? AND platform = ?`)
    .run(result.ok ? 'CONNECTED' : 'ERROR', detail, tenantId, platform);
  return listOne(db, tenantId, platform);
}

export async function removeConnection(db, tenantId, platform) {
  await db.prepare('DELETE FROM connections WHERE tenant_id = ? AND platform = ?').run(tenantId, platform);
}

// Lists a newly published product on the seller's Shopify store, when Shopify is connected.
// The product is already saved, so a failure is reported back and does not undo the publish.
export async function listOnShopify(db, tenantId, product) {
  const row = await db.prepare("SELECT status FROM connections WHERE tenant_id = ? AND platform = 'SHOPIFY'").get(tenantId);
  if (row?.status !== 'CONNECTED') return null;
  const fields = await loadFields(db, tenantId, 'SHOPIFY');
  if (!fields) return null;

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const images = base ? product.media_urls.map((url) => `${base}${url}`) : [];
  let created;
  try {
    created = await createShopifyProduct(fields, shopifyProductBody(product, images));
  } catch (err) {
    return { ok: false, detail: err.message };
  }

  const stock = new Map(product.variants.map((v) => [v.sku, v.stock_qty ?? 0]));
  let failed = 0;
  for (const v of created) {
    const qty = stock.get(v.sku) ?? 0;
    let synced;
    try {
      synced = (await setShopifyStock(fields, v.inventoryItemId, qty)).ok;
    } catch {
      synced = false;
    }
    if (!synced) failed += 1;
    await db.prepare(`INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id, sync_status, last_pushed_qty)
                VALUES (?, ?, 'SHOPIFY', ?, ?, ?)
                ON CONFLICT(tenant_id, sku, platform) DO UPDATE SET platform_listing_id = excluded.platform_listing_id,
                  sync_status = excluded.sync_status, last_pushed_qty = excluded.last_pushed_qty, updated_at = CURRENT_TIMESTAMP`)
      .run(tenantId, v.sku, v.variantId, synced ? 'SYNCED' : 'ERROR', synced ? qty : null);
  }

  const count = `${created.length} variant${created.length === 1 ? '' : 's'}`;
  if (failed) return { ok: false, detail: `Listed ${count} on Shopify, but ${failed} stock level${failed === 1 ? ' was' : 's were'} not set.` };
  return { ok: true, detail: `Listed ${count} on Shopify.` };
}

// Sends the photos of each listed product to its Shopify product, when that product has none yet.
// Shopify fetches the photos itself, so PUBLIC_BASE_URL must point at this server.
export async function syncShopifyPhotos(db, tenantId) {
  const row = await db.prepare("SELECT status FROM connections WHERE tenant_id = ? AND platform = 'SHOPIFY'").get(tenantId);
  if (row?.status !== 'CONNECTED') throw new InventoryError('NOT_CONNECTED', 'Connect Shopify first');
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new InventoryError('NO_PUBLIC_URL', 'Set PUBLIC_BASE_URL on the server so Shopify can fetch the photos');
  const fields = await loadFields(db, tenantId, 'SHOPIFY');
  if (!fields) throw new InventoryError('NOT_CONNECTED', 'Connect Shopify first');

  const results = [];
  for (const product of await listProducts(db, tenantId)) {
    const urls = product.media_urls.map((url) => `${base}${url}`);
    if (!urls.length) {
      results.push({ master_sku: product.master_sku, status: 'NO_PHOTOS', detail: 'No photos on this product' });
      continue;
    }
    const link = await db.prepare(`SELECT m.platform_listing_id FROM channel_mappings m
                JOIN variants v ON v.tenant_id = m.tenant_id AND v.sku = m.sku
                WHERE m.tenant_id = ? AND m.platform = 'SHOPIFY' AND v.product_id = ? LIMIT 1`).get(tenantId, product.id);
    if (!link) {
      results.push({ master_sku: product.master_sku, status: 'NOT_LISTED', detail: 'Not listed on Shopify yet' });
      continue;
    }
    try {
      const shopifyProductId = await shopifyProductIdForVariant(fields, link.platform_listing_id);
      const existing = await shopifyPhotoCount(fields, shopifyProductId);
      if (existing) {
        results.push({ master_sku: product.master_sku, status: 'HAS_PHOTOS', detail: `Shopify already has ${existing} photo${existing === 1 ? '' : 's'}` });
        continue;
      }
      await addShopifyPhotos(fields, shopifyProductId, urls);
      results.push({ master_sku: product.master_sku, status: 'ADDED', detail: `Added ${urls.length} photo${urls.length === 1 ? '' : 's'}` });
    } catch (err) {
      results.push({ master_sku: product.master_sku, status: 'ERROR', detail: err.message });
    }
  }
  return results;
}

export async function listConnections(db, tenantId) {
  const out = [];
  for (const platform of Object.keys(CONNECTORS)) out.push(await listOne(db, tenantId, platform));
  return out;
}

export function listDemoPushes(db, tenantId) {
  return db.prepare('SELECT sku, qty, created_at FROM demo_pushes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20').all(tenantId);
}

// Used by the outbox. Reads keys only at push time and never returns them.
export async function pushForTenant(db, tenantId, platform, args) {
  const fields = await loadFields(db, tenantId, platform);
  if (!fields) return { ok: false, skipped: true, error: `Connect ${CONNECTORS[platform].label} to send stock` };
  return pushOne(platform, fields, args, { db, tenantId });
}

// Postgres returns timestamps like 2026-11-03 10:20:30.123456+00. The browser needs ISO text.
function isoTime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function publicValues(def, fields) {
  const out = {};
  for (const f of def.fields) {
    const v = fields[f.name];
    out[f.name] = f.secret ? { saved: Boolean(v), hint: v ? v.slice(-4) : '' } : v ?? '';
  }
  return out;
}

async function listOne(db, tenantId, platform) {
  const def = CONNECTORS[platform];
  const row = await db.prepare('SELECT status, detail, tested_at, public_json FROM connections WHERE tenant_id = ? AND platform = ?').get(tenantId, platform);
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
    tested_at: isoTime(row?.tested_at),
    values: row ? JSON.parse(row.public_json) : {},
  };
}
