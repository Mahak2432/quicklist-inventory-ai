import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListings, parseShopifyProducts } from '../src/connectors.js';

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
    seen.push({ url: String(url), token: init.headers['X-Shopify-Access-Token'] });
    const body = { products: [{ id: 1, variants: [{ id: 11, sku: 'SHOE-1-UK9' }, { id: 12, sku: 'OTHER-SKU' }] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const matches = await matchListings('SHOPIFY', { shop_domain: 'demo-store.myshopify.com', access_token: 'shpat_test' }, ['SHOE-1-UK9', 'NOT-IN-STORE']);
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
    const matches = await matchListings('SHOPIFY', { shop_domain: 'demo-store.myshopify.com', access_token: 'bad' }, ['SHOE-1-UK9']);
    assert.equal(matches.size, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
