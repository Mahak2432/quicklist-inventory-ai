import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'quicklist-inventory-ai-test-'));
delete process.env.META_API_KEY;

const { openDb } = await import('../src/db.js');
const { createTenant } = await import('../src/auth.js');
const { createProduct } = await import('../src/inventory.js');
const { listOnShopify, syncShopifyPhotos } = await import('../src/connections.js');
const { shopifyProductBody } = await import('../src/connectors.js');
const { encrypt } = await import('../src/vault.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// One in-memory database per test file. Each shop has its own tenant_id, so tests stay separate.
const sharedDb = openDb('pglite:memory');
const freshShop = async () => {
  const db = await sharedDb;
  const { tenantId } = await createTenant(db, 'Listing shop');
  return { db, tenantId };
};

async function connectShopify(db, tenantId, shop) {
  const fields = { shop_domain: shop, client_id: 'client-list', client_secret: 'secret-list', location_id: '42' };
  await db.prepare(`INSERT INTO connections (tenant_id, platform, status, secret_blob, public_json, detail, tested_at, updated_at)
              VALUES (?, 'SHOPIFY', 'CONNECTED', ?, '{}', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(tenantId, encrypt(JSON.stringify(fields)));
}

const makeProduct = (db, tenantId) => createProduct(db, tenantId, {
  master_sku: 'SHOE-NAV-LIST1',
  title: 'Navy running shoe',
  category: 'FOOTWEAR',
  attributes: { brand: 'Stride', description: 'Light & soft', bullets: ['Mesh upper'], search_terms: ['running'] },
  media_urls: ['/m/abc/original?sig=x'],
  variants: [
    { sku: 'SHOE-NAV-LIST1-UK7', size: 'UK7', mrp: 1999, selling_price: 1499, stock_qty: 3 },
    { sku: 'SHOE-NAV-LIST1-UK8', size: 'UK8', mrp: 1999, selling_price: 1499, stock_qty: 0 },
  ],
});

test('a product becomes one Shopify product with a Size option and one variant per SKU', () => {
  const body = shopifyProductBody({
    title: 'Navy running shoe',
    attributes: { brand: 'Stride', description: 'Light & soft', bullets: ['Mesh upper'], search_terms: ['running'] },
    variants: [
      { sku: 'SHOE-1-UK7', size: 'UK7', mrp: 1999, selling_price: 1499, stock_qty: 3 },
      { sku: 'SHOE-1-UK8', size: 'UK8', mrp: 1499, selling_price: 1499, stock_qty: 0 },
    ],
  }, ['https://shop.example.test/m/abc/0-original?sig=x', 'https://shop.example.test/m/abc/1-enhanced?sig=y']);

  assert.deepEqual(body.product.options, [{ name: 'Size' }]);
  assert.equal(body.product.variants.length, 2);
  assert.equal(body.product.variants[0].option1, 'UK7');
  assert.equal(body.product.variants[0].price, '1499');
  assert.equal(body.product.variants[0].compare_at_price, '1999');
  assert.equal(body.product.variants[1].compare_at_price, null);
  assert.deepEqual(body.product.images, [
    { src: 'https://shop.example.test/m/abc/0-original?sig=x' },
    { src: 'https://shop.example.test/m/abc/1-enhanced?sig=y' },
  ]);
  assert.match(body.product.body_html, /Light &amp; soft/);
});

test('publishing lists the product on a connected Shopify store and records each variant', async () => {
  process.env.PUBLIC_BASE_URL = 'https://shop.example.test';
  const { db, tenantId } = await freshShop();
  await connectShopify(db, tenantId, 'listing-store.myshopify.com');
  const made = await makeProduct(db, tenantId);
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/admin/oauth/access_token')) return json({ access_token: 'shpat_list', expires_in: 86399 });
    calls.push({ href, method: init.method ?? 'GET', body: init.body ? String(init.body) : '' });
    if (href.endsWith('/products.json')) {
      return json({
        product: {
          id: 9,
          variants: [
            { id: 901, sku: 'SHOE-NAV-LIST1-UK7', inventory_item_id: 7001 },
            { id: 902, sku: 'SHOE-NAV-LIST1-UK8', inventory_item_id: 7002 },
          ],
        },
      }, 201);
    }
    return json({ inventory_level: {} });
  };
  try {
    const result = await listOnShopify(db, tenantId, made);
    assert.equal(result.ok, true);
    assert.equal(result.detail, 'Listed 2 variants on Shopify.');

    const create = calls.find((c) => c.href.endsWith('/products.json'));
    assert.equal(create.method, 'POST');
    assert.ok(create.body.includes('https://shop.example.test/m/abc/original?sig=x'));

    const levels = calls.filter((c) => c.href.endsWith('/inventory_levels/set.json')).map((c) => JSON.parse(c.body));
    assert.deepEqual(levels.map((l) => [l.inventory_item_id, l.available, l.location_id]), [[7001, 3, 42], [7002, 0, 42]]);

    const maps = await db.prepare("SELECT sku, platform_listing_id, sync_status FROM channel_mappings WHERE tenant_id = ? AND platform = 'SHOPIFY' ORDER BY sku").all(tenantId);
    assert.deepEqual(maps.map((m) => [m.sku, m.platform_listing_id, m.sync_status]), [
      ['SHOE-NAV-LIST1-UK7', '901', 'SYNCED'],
      ['SHOE-NAV-LIST1-UK8', '902', 'SYNCED'],
    ]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('a store without the write_products scope keeps the product and says why', async () => {
  const { db, tenantId } = await freshShop();
  await connectShopify(db, tenantId, 'no-scope-store.myshopify.com');
  const made = await makeProduct(db, tenantId);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('/admin/oauth/access_token')
    ? json({ access_token: 'shpat_noscope', expires_in: 86399 })
    : new Response('forbidden', { status: 403 }));
  try {
    const result = await listOnShopify(db, tenantId, made);
    assert.equal(result.ok, false);
    assert.match(result.detail, /write_products/);
    const linked = await db.prepare("SELECT COUNT(*)::int AS n FROM channel_mappings WHERE tenant_id = ? AND platform = 'SHOPIFY'").get(tenantId);
    assert.equal(linked.n, 0);
    assert.ok(await db.prepare('SELECT 1 FROM products WHERE tenant_id = ? AND master_sku = ?').get(tenantId, made.master_sku));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A product that is already listed on Shopify, linked through one of its variants.
async function listedProduct(db, tenantId) {
  await connectShopify(db, tenantId, 'photos-store.myshopify.com');
  await makeProduct(db, tenantId);
  await db.prepare("INSERT INTO channel_mappings (tenant_id, sku, platform, platform_listing_id) VALUES (?, 'SHOE-NAV-LIST1-UK7', 'SHOPIFY', '901')")
    .run(tenantId);
}

// Routes the Shopify calls the photo sync makes. `images` is what the Shopify product already has.
function photoStub(images, posted) {
  return async (url, init) => {
    const href = String(url);
    if (href.endsWith('/admin/oauth/access_token')) return json({ access_token: 'shpat_photos', expires_in: 86399 });
    if (href.includes('/variants/901.json')) return json({ variant: { id: 901, product_id: 9001 } });
    if (href.includes('/products/9001.json')) return json({ product: { id: 9001, images } });
    if (href.endsWith('/products/9001/images.json')) {
      posted.push(JSON.parse(init.body).image.src);
      return json({ image: {} }, 201);
    }
    return new Response('unexpected', { status: 500 });
  };
}

test('a listed product with no photos on Shopify gets its photos from the app', async () => {
  process.env.PUBLIC_BASE_URL = 'https://shop.example.test';
  const { db, tenantId } = await freshShop();
  await listedProduct(db, tenantId);
  const realFetch = globalThis.fetch;
  const posted = [];
  globalThis.fetch = photoStub([], posted);
  try {
    const results = await syncShopifyPhotos(db, tenantId);
    assert.deepEqual(results.map((r) => r.status), ['ADDED']);
    assert.deepEqual(posted, ['https://shop.example.test/m/abc/original?sig=x']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('a Shopify product that already has photos is left alone', async () => {
  process.env.PUBLIC_BASE_URL = 'https://shop.example.test';
  const { db, tenantId } = await freshShop();
  await listedProduct(db, tenantId);
  const realFetch = globalThis.fetch;
  const posted = [];
  globalThis.fetch = photoStub([{ id: 1 }], posted);
  try {
    const results = await syncShopifyPhotos(db, tenantId);
    assert.deepEqual(results.map((r) => r.status), ['HAS_PHOTOS']);
    assert.deepEqual(posted, []);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PUBLIC_BASE_URL;
  }
});

test('photos are not sent until PUBLIC_BASE_URL is set on the server', async () => {
  delete process.env.PUBLIC_BASE_URL;
  const { db, tenantId } = await freshShop();
  await listedProduct(db, tenantId);
  await assert.rejects(syncShopifyPhotos(db, tenantId), /PUBLIC_BASE_URL/);
});

test('nothing is sent to Shopify when the store is not connected', async () => {
  const { db, tenantId } = await freshShop();
  const made = await makeProduct(db, tenantId);
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return json({});
  };
  try {
    assert.equal(await listOnShopify(db, tenantId, made), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
