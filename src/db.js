import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// One SQLite file holds every tenant. Each row carries tenant_id so one
// install can serve many sellers. Swap DB_PATH to a shared file for a team.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS phone_links (
  phone TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  pending_draft_id TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  master_sku TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  hsn_code TEXT,
  gst_percent REAL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  media_urls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, master_sku)
);

-- Single source of truth for stock. stock_qty may go negative only when an
-- external order oversells; the ledger row and oversold flag show it.
CREATE TABLE IF NOT EXISTS variants (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  sku TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  size TEXT,
  color TEXT,
  mrp REAL,
  selling_price REAL,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS channel_mappings (
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_listing_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  last_pushed_qty INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, sku, platform)
);

-- Append-only audit trail. The partial unique index is the idempotency guard:
-- the same platform + order + line can only ever change stock once.
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  delta INTEGER NOT NULL,
  qty_after INTEGER NOT NULL,
  source_platform TEXT NOT NULL,
  external_ref TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_external
  ON inventory_ledger (tenant_id, source_platform, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS listing_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEEDS_INFO',
  image_path TEXT,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (tenant, sku, platform). Re-queuing overwrites the pending
-- quantity, so a burst of sales pushes only the latest number.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per seller and platform. secret_blob is AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS connections (
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
  secret_blob TEXT NOT NULL,
  public_json TEXT NOT NULL DEFAULT '{}',
  detail TEXT,
  tested_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, platform)
);

-- Owner logins. One login per shop, matched by email.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS demo_pushes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export function openDb(file = process.env.DB_PATH || './data/quicklist-inventory-ai.db') {
  if (file !== ':memory:') {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    file = path;
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside BEGIN IMMEDIATE so concurrent writers queue instead of racing.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
