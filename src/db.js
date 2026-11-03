import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

// One Postgres database holds every tenant. Each row carries tenant_id so one
// install can serve many sellers.
//   DATABASE_URL=postgres://...   Neon (or any Postgres) in production
//   DATABASE_URL=pglite:memory    in-process Postgres, wiped on exit (tests)
//   DATABASE_URL unset            in-process Postgres saved under ./data/pglite
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

// The code writes `?` placeholders. Postgres wants $1, $2, ... Text inside quotes is left alone.
export function toPositional(sql) {
  let n = 0;
  let out = '';
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// Every query goes through `current`. Inside db.tx() it is the transaction's own
// connection, so existing code can keep calling db.prepare() unchanged.
const transactions = new AsyncLocalStorage();

// Accepts `rows` plus a change count from either driver.
function normalise(result) {
  return { rows: result.rows, changes: result.rowCount ?? result.affectedRows ?? 0 };
}

class Db {
  constructor({ query, exec, begin }) {
    this.defaultQuery = query;
    this.execute = exec;
    this.begin = begin;
  }

  current(sql, params) {
    const run = transactions.getStore() ?? this.defaultQuery;
    return run(toPositional(sql), params).then(normalise);
  }

  // The statement API the rest of the app uses: prepare(sql).get(...), .all(...), .run(...).
  prepare(sql) {
    return {
      get: async (...params) => (await this.current(sql, params)).rows[0],
      all: async (...params) => (await this.current(sql, params)).rows,
      run: async (...params) => {
        const { changes } = await this.current(sql, params);
        return { changes };
      },
    };
  }

  // Runs one or more statements with no parameters, such as the schema.
  exec(sql) {
    return this.execute(sql);
  }

  // Runs fn inside one transaction. Inside it, every db call uses the same connection.
  // Concurrent requests keep their own connections, so their work is not mixed in.
  async tx(fn) {
    if (transactions.getStore()) return fn();
    return this.begin(async (query) => transactions.run(query, fn));
  }
}

async function postgresDb(url) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const begin = async (inside) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await inside((sql, params) => client.query(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
  return new Db({
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    begin,
  });
}

async function pgliteDb(dataDir) {
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  return new Db({
    query: (sql, params) => pglite.query(sql, params),
    exec: (sql) => pglite.exec(sql),
    begin: (inside) => pglite.transaction((tx) => inside((sql, params) => tx.query(sql, params))),
  });
}

export async function openDb(url = process.env.DATABASE_URL || 'pglite:./data/pglite') {
  const db = /^postgres(ql)?:\/\//.test(url)
    ? await postgresDb(url)
    : await pgliteDb(url === 'pglite:memory' || url === 'memory' ? undefined : url.replace(/^pglite:/, ''));
  await db.exec(SCHEMA);
  return db;
}

// Kept so existing call sites read the same. Prefer db.tx(fn).
export function tx(db, fn) {
  return db.tx(fn);
}
