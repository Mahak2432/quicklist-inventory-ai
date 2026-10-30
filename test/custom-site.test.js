import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer as createReceiver } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MASTER_KEY = randomBytes(32).toString('base64');
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'quicklist-site-'));
// Lets this test point the connector at a local receiver. Production keeps this off.
process.env.ALLOW_PRIVATE_URLS = '1';
delete process.env.META_API_KEY;

const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

const SECRET = 'site-signing-secret-for-tests';
const received = [];

// A stand-in for a seller's website: records each push and whether its signature checks out.
const receiver = createReceiver((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const payload = JSON.parse(body);
    received.push({ type: payload.type, sku: payload.sku, quantity: payload.quantity, signed: req.headers['x-quicklist-signature'] === expected });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let site;
let base;
let token;
const call = (path, options = {}) => fetch(`${base}${path}`, options);
const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test.before(async () => {
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  site = createApp(openDb(':memory:'));
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  const shop = await (await call('/api/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Website test shop' }),
  })).json();
  token = shop.token;
});

test.after(() => {
  site.close();
  receiver.close();
});

test('a seller website gets a signed ping, then signed stock updates after a sale', async () => {
  const sku = 'HOOD-GRY-0001-M';
  const product = await call('/api/products', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      master_sku: 'HOOD-GRY-0001',
      title: 'Grey hoodie',
      category: 'APPAREL',
      variants: [{ sku, size: 'M', mrp: 999, selling_price: 549, stock_qty: 5 }],
    }),
  });
  assert.equal(product.status, 201);

  const url = `http://127.0.0.1:${receiver.address().port}/stock`;
  const connected = await call('/api/connections/CUSTOM_SITE', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ fields: { stock_webhook_url: url, signing_secret: SECRET } }),
  });
  const connection = await connected.json();
  assert.equal(connection.status, 'CONNECTED', connection.detail);
  assert.equal(received[0].type, 'ping');
  assert.equal(received[0].signed, true);

  const adjusted = await call(`/api/stock/${sku}/adjust`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ delta: -2, reason: 'DASHBOARD' }),
  });
  assert.equal((await adjusted.json()).qty, 3);

  const drained = await call('/api/outbox/drain', { method: 'POST', headers: auth() });
  const results = await drained.json();
  assert.equal(results.find((r) => r.platform === 'CUSTOM_SITE').status, 'DONE');

  const update = received.find((r) => r.type === 'stock.updated');
  assert.ok(update, 'the site received a stock update');
  assert.equal(update.sku, sku);
  assert.equal(update.quantity, 3);
  assert.equal(update.signed, true);
});
