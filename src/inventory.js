import { randomUUID } from 'node:crypto';
import { tx } from './db.js';

export class InventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
  }
}

const MARKETPLACES = new Set(['AMAZON_IN', 'FLIPKART', 'MEESHO', 'SHOPIFY', 'WOOCOMMERCE', 'CUSTOM_SITE', 'DEMO']);
// Channels that match a SKU by seller SKU, so they link automatically on connect.
// Shopify and WooCommerce need their own IDs, so those are linked by hand.
export const SKU_LINKED = ['AMAZON_IN', 'FLIPKART', 'MEESHO', 'CUSTOM_SITE', 'DEMO'];
const MAX_PUSH_ATTEMPTS = 5;

export function createProduct(db, tenantId, input) {
  return tx(db, () => {
    const exists = db
      .prepare('SELECT id FROM products WHERE tenant_id = ? AND master_sku = ?')
      .get(tenantId, input.master_sku);
    if (exists) throw new InventoryError('DUPLICATE', `Product ${input.master_sku} already exists`);

    const id = randomUUID();
    db.prepare(`INSERT INTO products (id, tenant_id, master_sku, title, category, hsn_code, gst_percent, attributes_json, media_urls_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      tenantId,
      input.master_sku,
      input.title,
      input.category ?? null,
      input.hsn_code ?? null,
      input.gst_percent ?? null,
      JSON.stringify(input.attributes ?? {}),
      JSON.stringify(input.media_urls ?? []),
    );

    insertVariants(db, tenantId, id, input.variants);
    linkNewSkus(db, tenantId, (input.variants ?? []).map((v) => v.sku));
    return getProduct(db, tenantId, input.master_sku);
  });
}

// Creates the product, or updates it in place. Existing variants keep their
// stock, so the MCP upsert tool can't reset a count by accident.
export function upsertProduct(db, tenantId, input) {
  const existing = db
    .prepare('SELECT id, attributes_json FROM products WHERE tenant_id = ? AND master_sku = ?')
    .get(tenantId, input.master_sku);
  if (!existing) return createProduct(db, tenantId, input);

  return tx(db, () => {
    const attributes = { ...JSON.parse(existing.attributes_json), ...(input.attributes ?? {}) };
    db.prepare(`UPDATE products SET title = ?, category = COALESCE(?, category), hsn_code = COALESCE(?, hsn_code),
                gst_percent = COALESCE(?, gst_percent), attributes_json = ?,
                media_urls_json = COALESCE(?, media_urls_json), updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(
      input.title,
      input.category ?? null,
      input.hsn_code ?? null,
      input.gst_percent ?? null,
      JSON.stringify(attributes),
      input.media_urls ? JSON.stringify(input.media_urls) : null,
      existing.id,
    );
    const known = new Set(
      db.prepare('SELECT sku FROM variants WHERE tenant_id = ? AND product_id = ?').all(tenantId, existing.id).map((r) => r.sku),
    );
    const fresh = (input.variants ?? []).filter((v) => !known.has(v.sku));
    insertVariants(db, tenantId, existing.id, fresh);
    linkNewSkus(db, tenantId, fresh.map((v) => v.sku));
    return getProduct(db, tenantId, input.master_sku);
  });
}

function insertVariants(db, tenantId, productId, variants = []) {
  for (const v of variants) {
    db.prepare(`INSERT INTO variants (tenant_id, sku, product_id, size, color, mrp, selling_price, stock_qty)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tenantId,
      v.sku,
      productId,
      v.size ?? null,
      v.color ?? null,
      v.mrp ?? null,
      v.selling_price ?? null,
      v.stock_qty ?? 0,
    );
  }
}

export function getProduct(db, tenantId, masterSku) {
  const p = db
    .prepare('SELECT * FROM products WHERE tenant_id = ? AND master_sku = ?')
    .get(tenantId, masterSku);
  if (!p) return null;
  return formatProduct(db, tenantId, p);
}

export function listProducts(db, tenantId) {
  return db
    .prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY created_at DESC')
    .all(tenantId)
    .map((p) => formatProduct(db, tenantId, p));
}

function formatProduct(db, tenantId, p) {
  const variants = db
    .prepare('SELECT sku, size, color, mrp, selling_price, stock_qty FROM variants WHERE tenant_id = ? AND product_id = ? ORDER BY sku')
    .all(tenantId, p.id);
  return {
    id: p.id,
    master_sku: p.master_sku,
    title: p.title,
    category: p.category,
    hsn_code: p.hsn_code,
    gst_percent: p.gst_percent,
    attributes: JSON.parse(p.attributes_json),
    media_urls: JSON.parse(p.media_urls_json),
    variants,
  };
}

export function getStock(db, tenantId, sku) {
  const row = db
    .prepare(`SELECT v.sku, v.size, v.color, v.stock_qty, v.mrp, v.selling_price, p.master_sku, p.title
              FROM variants v JOIN products p ON p.id = v.product_id
              WHERE v.tenant_id = ? AND v.sku = ?`)
    .get(tenantId, sku);
  if (!row) throw new InventoryError('NOT_FOUND', `No SKU ${sku}`);
  return row;
}

// The one place stock changes. Every path (dashboard, MCP, WhatsApp, orders)
// goes through here so the ledger and the outbox stay consistent.
export function adjustStock(db, tenantId, sku, delta, opts = {}) {
  const { reason = 'MANUAL', source = 'API', externalRef = null, allowNegative = false } = opts;
  return tx(db, () => {
    if (externalRef) {
      const seen = db
        .prepare('SELECT 1 FROM inventory_ledger WHERE tenant_id = ? AND source_platform = ? AND external_ref = ?')
        .get(tenantId, source, externalRef);
      if (seen) {
        const now = getStock(db, tenantId, sku);
        return { duplicate: true, sku, qty: now.stock_qty, oversold: now.stock_qty < 0, pushedTo: [] };
      }
    }

    const current = db
      .prepare('SELECT stock_qty, version FROM variants WHERE tenant_id = ? AND sku = ?')
      .get(tenantId, sku);
    if (!current) throw new InventoryError('NOT_FOUND', `No SKU ${sku}`);

    const next = current.stock_qty + delta;
    if (next < 0 && !allowNegative) {
      throw new InventoryError('INSUFFICIENT_STOCK', `Only ${current.stock_qty} left for ${sku}`);
    }

    const res = db
      .prepare('UPDATE variants SET stock_qty = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND sku = ? AND version = ?')
      .run(next, tenantId, sku, current.version);
    if (res.changes !== 1) throw new InventoryError('CONFLICT', `Stock for ${sku} changed, retry`);

    db.prepare(`INSERT INTO inventory_ledger (id, tenant_id, sku, delta, qty_after, source_platform, external_ref, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), tenantId, sku, delta, next, source, externalRef, reason);

    // Push the new absolute quantity to every linked marketplace except the
    // one the sale came from, since that platform already decremented itself.
    const channels = db
      .prepare('SELECT platform FROM channel_mappings WHERE tenant_id = ? AND sku = ? AND platform <> ?')
      .all(tenantId, sku, source);
    for (const ch of channels) enqueuePush(db, tenantId, sku, ch.platform, next);

    return {
      duplicate: false,
      sku,
      previous: current.stock_qty,
      qty: next,
      oversold: next < 0,
      pushedTo: channels.map((c) => c.platform),
    };
  });
}

function enqueuePush(db, tenantId, sku, platform, qty) {
  db.prepare(`INSERT INTO outbox (id, tenant_id, sku, platform, qty, status, attempts)
              VALUES (?, ?, ?, ?, ?, 'PENDING', 0)
              ON CONFLICT(id) DO UPDATE SET qty = excluded.qty, status = 'PENDING', attempts = 0, updated_at = CURRENT_TIMESTAMP`)
    .run(`${tenantId}|${sku}|${platform}`, tenantId, sku, platform, qty);
}

function linkRow(db, tenantId, sku, platform, listingId) {
  db.prepare(`INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id) VALUES (?, ?, ?, ?)
              ON CONFLICT(tenant_id, sku, platform) DO NOTHING`).run(tenantId, sku, platform, listingId);
}

// Called when a seller connects a SKU-matched channel: links every existing SKU.
export function linkSkusToChannel(db, tenantId, platform) {
  for (const { sku } of db.prepare('SELECT sku FROM variants WHERE tenant_id = ?').all(tenantId)) {
    linkRow(db, tenantId, sku, platform, sku);
  }
}

// Called when products are created: links new SKUs to channels already connected.
export function linkNewSkus(db, tenantId, skus) {
  const connected = db
    .prepare("SELECT platform FROM connections WHERE tenant_id = ? AND status = 'CONNECTED'")
    .all(tenantId)
    .map((r) => r.platform)
    .filter((p) => SKU_LINKED.includes(p));
  for (const platform of connected) {
    for (const sku of skus) linkRow(db, tenantId, sku, platform, sku);
  }
}

export function mapChannel(db, tenantId, sku, platform, platformListingId) {
  if (!MARKETPLACES.has(platform)) {
    throw new InventoryError('BAD_PLATFORM', `Unknown platform ${platform}`);
  }
  getStock(db, tenantId, sku);
  db.prepare(`INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(tenant_id, sku, platform) DO UPDATE SET platform_listing_id = excluded.platform_listing_id, updated_at = CURRENT_TIMESTAMP`)
    .run(tenantId, sku, platform, platformListingId);
  return { sku, platform, platform_listing_id: platformListingId };
}

export function listLowStock(db, tenantId, threshold = 5) {
  return db
    .prepare(`SELECT sku, size, color, stock_qty FROM variants
              WHERE tenant_id = ? AND stock_qty <= ? ORDER BY stock_qty ASC, sku ASC`)
    .all(tenantId, threshold);
}

// Runs queued channel pushes. `adapters[platform].pushStock` returns
// { ok, skipped, error }. Platforms with no adapter or no credentials are
// marked NOT_CONFIGURED so the dashboard shows exactly what did not sync.
export async function drainOutbox(db, tenantId, adapters, limit = 50) {
  const rows = db
    .prepare(`SELECT id, sku, platform, qty, attempts FROM outbox
              WHERE tenant_id = ? AND status = 'PENDING' ORDER BY updated_at LIMIT ?`)
    .all(tenantId, limit);

  const results = [];
  for (const row of rows) {
    const adapter = adapters[row.platform];
    let outcome;
    try {
      outcome = adapter ? await adapter.pushStock({ tenantId, sku: row.sku, qty: row.qty }) : { ok: false, skipped: true };
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    // Rows that are not configured yet stay PENDING, so they go out once the
    // credentials exist. Real errors retry until MAX_PUSH_ATTEMPTS, then FAILED.
    const attempts = row.attempts + 1;
    let status;
    let sync;
    if (outcome.ok) {
      status = 'DONE';
      sync = 'SYNCED';
    } else if (outcome.skipped) {
      status = 'PENDING';
      sync = 'NOT_CONFIGURED';
    } else if (attempts >= MAX_PUSH_ATTEMPTS) {
      status = 'FAILED';
      sync = 'ERROR';
    } else {
      status = 'PENDING';
      sync = 'PENDING';
    }

    db.prepare('UPDATE outbox SET status = ?, attempts = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status, attempts, outcome.error ?? null, row.id);
    db.prepare(`UPDATE channel_mappings SET sync_status = ?, last_pushed_qty = ?, updated_at = CURRENT_TIMESTAMP
                WHERE tenant_id = ? AND sku = ? AND platform = ?`)
      .run(sync, row.qty, tenantId, row.sku, row.platform);

    results.push({ sku: row.sku, platform: row.platform, qty: row.qty, status, sync, error: outcome.error ?? null });
  }
  return results;
}
