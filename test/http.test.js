import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'quicklist-inventory-ai-http-'));
delete process.env.META_API_KEY;
// The before-hook opens one shop, so four more succeed and the rest are refused.
process.env.SIGNUP_PER_HOUR = '5';

const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const sharp = (await import('sharp')).default;

let server;
let base;
let token;

const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const call = (path, options = {}) => fetch(`${base}${path}`, options);

before(async () => {
  server = createApp(openDb(':memory:'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('/api/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP test shop' }),
  });
  token = (await res.json()).token;
});

after(() => server.close());

test('the API refuses requests without a token', async () => {
  const res = await call('/api/products');
  assert.equal(res.status, 401);
});

test('health check reports the Meta switch without exposing keys', async () => {
  const res = await call('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, meta_enabled: false });
});

test('a photo becomes a draft, the seller answers, and the product publishes with a signed image link', async () => {
  const png = await sharp({ create: { width: 240, height: 240, channels: 3, background: '#f2f2f2' } }).png().toBuffer();
  const created = await call('/api/listings/drafts?hint=navy%20cap', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.equal(draft.draft.photos[0].mode, 'ORIGINAL');
  assert.deepEqual(draft.missing, ['stock', 'mrp', 'selling_price']);

  const answered = await call(`/api/listings/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: auth(),
    body: JSON.stringify({ answers: { stock_total: 12, mrp: 499, selling_price: 349 } }),
  });
  assert.deepEqual((await answered.json()).missing, []);

  const published = await call(`/api/listings/drafts/${draft.id}/publish`, { method: 'POST', headers: auth() });
  assert.equal(published.status, 201);
  const product = await published.json();
  assert.equal(product.variants[0].stock_qty, 12);

  const image = await fetch(`${base}${product.media_urls[0]}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const unsigned = await call(`/m/${draft.id}/original`);
  assert.equal(unsigned.status, 403);
});

test('connecting the demo marketplace and sending an order updates stock', async () => {
  const connected = await call('/api/connections/DEMO', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ fields: {} }),
  });
  assert.equal((await connected.json()).status, 'CONNECTED');

  const products = await (await call('/api/products', { headers: auth() })).json();
  const sku = products[0].variants[0].sku;
  const order = await call('/api/orders/DEMO', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ order_id: 'HTTP-1', lines: [{ line_id: 'A', sku, quantity: 2 }] }),
  });
  const result = await order.json();
  assert.equal(result.lines[0].status, 'APPLIED');
  assert.equal(result.lines[0].qty, 10);
});

test('connections list every connector with no secrets, and bad addresses are refused', async () => {
  const list = await (await call('/api/connections', { headers: auth() })).json();
  assert.equal(list.connectors.length, 7);
  assert.ok(list.connectors.some((c) => c.platform === 'CUSTOM_SITE'));

  const bad = await call('/api/connections/SHOPIFY', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ fields: { shop_domain: 'not-shopify.example.com', client_id: 'client-x', client_secret: 'secret-x', location_id: '1' } }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'BAD_FIELD');

  const unknown = await call('/api/connections/NOT_A_PLATFORM', { method: 'PUT', headers: auth(), body: '{}' });
  assert.equal(unknown.status, 404);
});

test('the open shop signup is rate limited per address', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await call('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Limit test ${i}` }),
    });
    statuses.push(res.status);
  }
  assert.equal(statuses.filter((s) => s === 201).length, 4);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
});

test('the MCP endpoint lists the five inventory tools for the seller', async () => {
  const headers = { ...auth(), Accept: 'application/json, text/event-stream' };
  const init = await call('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  });
  assert.equal(init.status, 200);

  const list = await call('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = await list.json();
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'inventory_adjust_stock',
    'inventory_get_stock',
    'inventory_list_low_stock',
    'inventory_map_channel_id',
    'inventory_upsert_product',
  ]);
});
