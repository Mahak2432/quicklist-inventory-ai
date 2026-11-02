import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListings, parseShopifyProducts } from '../src/connectors.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a Shopify product list maps each variant SKU to its variant ID', () => {
  const map = parseShopifyProducts({
    products: [
      { id: 1, variants: [{ id: 11, sku: 'SHOE-1-UK9' }, { id: 12, sku: '' }] },
      { id: 2, variants: [{ id: 21, sku: 'KURTA-1-M' }] },
    ],
  });
  assert.equal(map.get('SHOE-1-UK9'), '11');
  assert.equal(map.get('KURTA-1-M'), '21');
  assert.equal(map.has(''), false);
  assert.equal(map.size, 2);
});

test('matching asks the store for its products and keeps only our SKUs', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/admin/oauth/access_token')) return json({ access_token: 'shpat_test', expires_in: 86399 });
    seen.push({ url: href, token: init.headers['X-Shopify-Access-Token'] });
    return json({ products: [{ id: 1, variants: [{ id: 11, sku: 'SHOE-1-UK9' }, { id: 12, sku: 'OTHER-SKU' }] }] });
  };
  try {
    const f = { shop_domain: 'demo-store.myshopify.com', client_id: 'client-match', client_secret: 'secret-match' };
    const matches = await matchListings('SHOPIFY', f, ['SHOE-1-UK9', 'NOT-IN-STORE']);
    assert.deepEqual([...matches], [['SHOE-1-UK9', '11']]);
    assert.match(seen[0].url, /^https:\/\/demo-store\.myshopify\.com\/admin\/api\/.+\/products\.json/);
    assert.equal(seen[0].token, 'shpat_test');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed store lookup returns no matches instead of an error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('denied', { status: 401 });
  try {
    const f = { shop_domain: 'demo-store.myshopify.com', client_id: 'client-denied', client_secret: 'wrong' };
    const matches = await matchListings('SHOPIFY', f, ['SHOE-1-UK9']);
    assert.equal(matches.size, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a Shopify token is requested once, reused, and renewed when the store rejects it', async () => {
  const realFetch = globalThis.fetch;
  const tokenBodies = [];
  const tokensUsed = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/admin/oauth/access_token')) {
      tokenBodies.push(String(init.body));
      return json({ access_token: `shpat_${tokenBodies.length}`, expires_in: 86399 });
    }
    tokensUsed.push(init.headers['X-Shopify-Access-Token']);
    if (tokensUsed.length === 1) return new Response('expired', { status: 401 });
    return json({ products: [] });
  };
  try {
    const f = { shop_domain: 'renew-store.myshopify.com', client_id: 'client-renew', client_secret: 'secret-renew' };
    await matchListings('SHOPIFY', f, ['SHOE-1-UK9']);
    await matchListings('SHOPIFY', f, ['SHOE-1-UK9']);
    assert.equal(tokenBodies.length, 2);
    assert.match(tokenBodies[0], /grant_type=client_credentials/);
    assert.match(tokenBodies[0], /client_id=client-renew/);
    assert.deepEqual(tokensUsed, ['shpat_1', 'shpat_2', 'shpat_2']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
