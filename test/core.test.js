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
const { adjustStock, createProduct, drainOutbox, getStock } = await import('../src/inventory.js');
const { processOrder } = await import('../src/orders.js');
const { createDraft, updateDraft, publishDraft, parseAnswerRegex } = await import('../src/listing.js');
const { buildCsv } = await import('../src/marketplaces.js');
const { matchQtySku } = await import('../src/whatsapp.js');
const { encrypt, decrypt } = await import('../src/vault.js');
const { saveConnection, listConnections } = await import('../src/connections.js');
const { makeAdapters } = await import('../src/channels.js');
const { validateFields } = await import('../src/connectors.js');

const freshShop = (name = 'Test shop') => {
  const db = openDb(':memory:');
  const { tenantId } = createTenant(db, name);
  return { db, tenantId };
};

test('vault round-trips, uses a fresh IV, and rejects tampering', () => {
  const blob = encrypt('secret-value');
  assert.equal(decrypt(blob), 'secret-value');
  assert.notEqual(encrypt('same'), encrypt('same'));
  const parts = blob.split('.');
  parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
});

test('manual stock changes cannot go below zero', () => {
  const { db, tenantId } = freshShop();
  createProduct(db, tenantId, {
    master_sku: 'SHOE-1',
    title: 'Shoe',
    category: 'FOOTWEAR',
    variants: [{ sku: 'SHOE-1-7', size: '7', stock_qty: 2 }],
  });
  assert.throws(() => adjustStock(db, tenantId, 'SHOE-1-7', -5), /Only 2 left/);
  assert.equal(adjustStock(db, tenantId, 'SHOE-1-7', -1).qty, 1);
  assert.equal(getStock(db, tenantId, 'SHOE-1-7').stock_qty, 1);
});

test('the same marketplace order line changes stock only once', () => {
  const { db, tenantId } = freshShop();
  createProduct(db, tenantId, {
    master_sku: 'SHOE-1',
    title: 'Shoe',
    category: 'FOOTWEAR',
    variants: [{ sku: 'SHOE-1-7', size: '7', stock_qty: 2 }],
  });
  const order = { order_id: 'O-1', lines: [{ line_id: 'L-1', sku: 'SHOE-1-7', quantity: 1 }] };
  assert.equal(processOrder(db, tenantId, 'FLIPKART', order).lines[0].status, 'APPLIED');
  assert.equal(processOrder(db, tenantId, 'FLIPKART', order).lines[0].status, 'DUPLICATE');
  assert.equal(getStock(db, tenantId, 'SHOE-1-7').stock_qty, 1);
});

test('an order larger than stock is counted and flagged as oversold', () => {
  const { db, tenantId } = freshShop();
  createProduct(db, tenantId, {
    master_sku: 'SHOE-1',
    title: 'Shoe',
    category: 'FOOTWEAR',
    variants: [{ sku: 'SHOE-1-7', size: '7', stock_qty: 1 }],
  });
  const result = processOrder(db, tenantId, 'AMAZON_IN', {
    AmazonOrderId: '402-1',
    OrderItems: [{ OrderItemId: 'I-1', SellerSKU: 'SHOE-1-7', QuantityOrdered: 3 }],
  });
  assert.equal(result.lines[0].status, 'APPLIED');
  assert.equal(result.lines[0].oversold, true);
  assert.equal(getStock(db, tenantId, 'SHOE-1-7').stock_qty, -2);
});

test('one shop cannot read another shop stock', () => {
  const a = freshShop('Shop A');
  createProduct(a.db, a.tenantId, {
    master_sku: 'SHOE-1',
    title: 'Shoe',
    category: 'FOOTWEAR',
    variants: [{ sku: 'SHOE-1-7', size: '7', stock_qty: 4 }],
  });
  const b = createTenant(a.db, 'Shop B');
  assert.throws(() => getStock(a.db, b.tenantId, 'SHOE-1-7'), /No SKU/);
});

test('a photo draft fills in from one seller reply and publishes a SKU per size', async () => {
  const { db, tenantId } = freshShop();
  const view = createDraft(db, tenantId, {
    title: 'Navy mesh running shoes',
    category: 'FOOTWEAR',
    color: 'Navy Blue',
    hsn_code_suggestion: '6404',
    bullets: ['Breathable mesh upper'],
    description: 'Light running shoes.',
    search_terms: ['running shoes'],
  });
  assert.deepEqual(view.missing, ['sizes', 'stock', 'mrp', 'selling_price']);

  const after = await updateDraft(db, tenantId, view.id, {
    text: 'Sab size 7 se 10 hai, har size ke 15 piece daal do, MRP 1499 aur bechna 799 mein hai.',
  });
  assert.deepEqual(after.missing, []);
  assert.deepEqual(after.draft.answers.sizes, ['7', '8', '9', '10']);
  assert.equal(after.draft.answers.stock_per_size['8'], 15);
  assert.equal(after.draft.answers.selling_price, 799);

  const product = publishDraft(db, tenantId, view.id);
  assert.equal(product.variants.length, 4);
  assert.equal(product.variants[0].stock_qty, 15);
  assert.equal(product.variants[0].mrp, 1499);
});

test('the rules reader understands the common Hinglish phrasings', () => {
  assert.deepEqual(parseAnswerRegex('MRP 999, stock 40, bechna 499').stock_total, 40);
  assert.equal(parseAnswerRegex('MRP 999, stock 40, bechna 499').selling_price, 499);
  assert.deepEqual(parseAnswerRegex('S, M and L').sizes, ['S', 'M', 'L']);
});

test('marketplace sheets quote commas and double quotes', () => {
  const csv = buildCsv(
    'AMAZON_IN',
    [{
      master_sku: 'X',
      title: 'Shirt, "cotton"',
      category: 'APPAREL',
      hsn_code: '6205',
      attributes: {},
      media_urls: [],
      variants: [{ sku: 'X-1', size: 'M', color: 'Blue', mrp: 999, selling_price: 499, stock_qty: 3 }],
    }],
    'https://example.com',
  );
  const [header, row] = csv.trim().split('\n');
  assert.match(header, /^sku,product_type,item_name/);
  assert.match(row, /"Shirt, ""cotton"""/);
});

test('WhatsApp stock commands accept both word orders', () => {
  assert.deepEqual(matchQtySku('sold 3 shoe-nav-7', /^(sold|sell)\s+/i), { qty: 3, sku: 'SHOE-NAV-7' });
  assert.deepEqual(matchQtySku('sold shoe-nav-7 2', /^(sold|sell)\s+/i), { qty: 2, sku: 'SHOE-NAV-7' });
  assert.deepEqual(matchQtySku('restock SKU-1 +20', /^(restock|add)\s+/i), { qty: 20, sku: 'SKU-1' });
  assert.equal(matchQtySku('hello there', /^(sold|sell)\s+/i), null);
});

test('seller-entered addresses cannot point inside the network', () => {
  assert.throws(() => validateFields('CUSTOM_SITE', { stock_webhook_url: 'https://localhost/hook', signing_secret: 'x' }), /private network/);
  assert.throws(() => validateFields('CUSTOM_SITE', { stock_webhook_url: 'https://10.0.0.5/hook', signing_secret: 'x' }), /private network/);
  assert.throws(() => validateFields('CUSTOM_SITE', { stock_webhook_url: 'http://example.com/hook', signing_secret: 'x' }), /https/);
  assert.throws(() => validateFields('SHOPIFY', { shop_domain: 'evil.example.com', client_id: 'x', client_secret: 'x' }), /myshopify/);
  const shopify = validateFields('SHOPIFY', { shop_domain: 'Demo-Store.myshopify.com', client_id: 'x', client_secret: 'x', location_id: '123' });
  assert.equal(shopify.shop_domain, 'demo-store.myshopify.com');
  assert.equal(
    validateFields('WOOCOMMERCE', { site_url: 'https://shop.example.com/', consumer_key: 'a', consumer_secret: 'b' }).site_url,
    'https://shop.example.com',
  );
});

test('connecting the demo marketplace pushes stock after a manual change', async () => {
  const { db, tenantId } = freshShop();
  createProduct(db, tenantId, {
    master_sku: 'SHOE-1',
    title: 'Shoe',
    category: 'FOOTWEAR',
    variants: [{ sku: 'SHOE-1-7', size: '7', stock_qty: 5 }],
  });
  const connected = await saveConnection(db, tenantId, 'DEMO', {});
  assert.equal(connected.status, 'CONNECTED');

  adjustStock(db, tenantId, 'SHOE-1-7', -2, { source: 'DASHBOARD' });
  const results = await drainOutbox(db, tenantId, makeAdapters(db));
  assert.equal(results[0].status, 'DONE');
  assert.equal(db.prepare('SELECT qty FROM demo_pushes WHERE tenant_id = ?').get(tenantId).qty, 3);
});

test('saved connections never return secret values', async () => {
  const { db, tenantId } = freshShop();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const saved = await saveConnection(db, tenantId, 'WOOCOMMERCE', {
      site_url: 'https://shop.example.com',
      consumer_key: 'ck_live_visible_key_1234',
      consumer_secret: 'cs_super_secret_value_9876',
    });
    assert.equal(saved.status, 'CONNECTED');
    const listed = listConnections(db, tenantId);
    const text = JSON.stringify(listed);
    assert.equal(text.includes('cs_super_secret_value_9876'), false);
    assert.equal(text.includes('ck_live_visible_key_1234'), false);
    const woo = listed.find((c) => c.platform === 'WOOCOMMERCE');
    assert.equal(woo.values.consumer_secret.saved, true);
    assert.equal(woo.values.consumer_secret.hint, '9876');
  } finally {
    globalThis.fetch = realFetch;
  }
});
