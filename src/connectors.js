import { createHmac, randomUUID } from 'node:crypto';

// Each connector has three parts: the form a seller fills in, a test that
// proves the keys work, and a push that sets one SKU's stock. Nothing here
// imports the database except through the `ctx` argument on push.

const TIMEOUT_MS = 12_000;
const SHOPIFY_API = process.env.SHOPIFY_API_VERSION || '2025-01';
const AMAZON_LWA = 'https://api.amazon.com/auth/o2/token';
const AMAZON_INDIA_ENDPOINT = 'https://sellingpartnerapi-fe.amazon.com';
const AMAZON_INDIA_MARKETPLACE = 'A21TJRUUN4KGV';
const FLIPKART_API = 'https://api.flipkart.net';

export const CONNECTORS = {
  AMAZON_IN: {
    label: 'Amazon India',
    kind: 'marketplace',
    blurb: 'Sync stock to your Amazon.in listings through the Selling Partner API.',
    guide: 'Register an SP-API app in Seller Central, authorise it, then paste the values below. Stock updates match the SKU you listed on Amazon.',
    fields: [
      { name: 'seller_id', label: 'Seller ID', secret: false, help: 'Seller Central → Settings → Account Info.' },
      { name: 'lwa_client_id', label: 'LWA client ID', secret: false, help: 'From your SP-API app.' },
      { name: 'lwa_client_secret', label: 'LWA client secret', secret: true },
      { name: 'refresh_token', label: 'Refresh token', secret: true, help: 'Shown when you authorise the app.' },
      { name: 'product_type', label: 'Product type', secret: false, optional: true, help: 'The Amazon product type for your category, for example SHOES or SHIRT.' },
    ],
  },
  FLIPKART: {
    label: 'Flipkart',
    kind: 'marketplace',
    blurb: 'Push stock to your Flipkart listings through the Seller API.',
    guide: 'Create an app in the Flipkart seller developer area, then paste its App ID and secret.',
    fields: [
      { name: 'app_id', label: 'App ID', secret: false },
      { name: 'app_secret', label: 'App secret', secret: true },
    ],
  },
  MEESHO: {
    label: 'Meesho',
    kind: 'marketplace',
    blurb: 'Keep your Meesho supplier details on file.',
    guide: 'Meesho stock updates need partner API access. Until it is approved, sync through the bulk sheet on the Listings page.',
    fields: [
      { name: 'supplier_id', label: 'Supplier ID', secret: false },
      { name: 'api_key', label: 'API key', secret: true, optional: true },
    ],
  },
  SHOPIFY: {
    label: 'Shopify',
    kind: 'store',
    blurb: 'Sync stock to your Shopify store.',
    guide: 'In the Shopify Dev Dashboard, install your app on the store. Then paste its store domain, Client ID, Client secret and location ID here. The server requests a short-lived token itself. Link each SKU to its variant ID with POST /api/channels.',
    fields: [
      { name: 'shop_domain', label: 'Store domain', secret: false, help: 'For example yourstore.myshopify.com' },
      { name: 'client_id', label: 'Client ID', secret: false, help: 'Dev Dashboard → your app → Settings.' },
      { name: 'client_secret', label: 'Client secret', secret: true, help: 'Dev Dashboard → your app → Settings.' },
      { name: 'location_id', label: 'Location ID', secret: false, help: 'Shopify admin → Settings → Locations. Numbers only.' },
    ],
  },
  WOOCOMMERCE: {
    label: 'WooCommerce',
    kind: 'store',
    blurb: 'Sync stock to your WordPress WooCommerce store.',
    guide: 'In WordPress, go to WooCommerce → Settings → Advanced → REST API, create a key with Read/Write, then paste both values. Link each SKU to its product ID with POST /api/channels.',
    fields: [
      { name: 'site_url', label: 'Site address', secret: false, help: 'https://yourshop.com' },
      { name: 'consumer_key', label: 'Consumer key', secret: true, help: 'Starts with ck_' },
      { name: 'consumer_secret', label: 'Consumer secret', secret: true, help: 'Starts with cs_' },
    ],
  },
  CUSTOM_SITE: {
    label: 'My own website',
    kind: 'store',
    blurb: 'Any site or app you run. We send signed stock updates to it, and it sends orders back.',
    guide: 'Give an https:// address that accepts POST requests. Each stock change arrives as JSON with an X-QuickList-Signature header (HMAC-SHA256 of the body using your signing secret). Send orders to /api/orders/CUSTOM_SITE with your QuickListInventoryAI token.',
    fields: [
      { name: 'stock_webhook_url', label: 'Stock update address', secret: false, help: 'https://your-site.example/quicklist-inventory-ai/stock' },
      { name: 'signing_secret', label: 'Signing secret', secret: true, help: 'Any long random string. Your site checks signatures with it.' },
    ],
  },
  DEMO: {
    label: 'Demo marketplace',
    kind: 'test',
    blurb: 'No account needed. Test the whole flow, from an order to a stock push.',
    guide: 'Connect it, then place a test order from the Orders page. Every stock push it receives appears below.',
    fields: [],
  },
};

const coded = (code, message) => Object.assign(new Error(message), { code });

// Blocks addresses that point inside a private network. Sellers type these
// addresses, so without this check the server could be aimed at its own
// internal services. Dev-only override: ALLOW_PRIVATE_URLS=1.
function safeUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw coded('BAD_FIELD', `${label} is not a valid address`);
  }
  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === '1';
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw coded('BAD_FIELD', `${label} must start with https://`);
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw coded('BAD_FIELD', `${label} points at a private network address`);
  }
  return url;
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

// Checks and normalises the fields that are addresses or identifiers.
export function validateFields(platform, f) {
  const out = { ...f };
  if (platform === 'SHOPIFY') {
    out.shop_domain = String(f.shop_domain).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(out.shop_domain)) {
      throw coded('BAD_FIELD', 'Store domain must look like yourstore.myshopify.com');
    }
    if (f.location_id && !/^\d+$/.test(f.location_id)) throw coded('BAD_FIELD', 'Location ID must be numbers only');
  }
  if (platform === 'WOOCOMMERCE') {
    out.site_url = safeUrl(f.site_url, 'Site address').href.replace(/\/$/, '');
  }
  if (platform === 'CUSTOM_SITE') {
    out.stock_webhook_url = safeUrl(f.stock_webhook_url, 'Stock update address').href;
  }
  return out;
}

async function http(url, init = {}) {
  return fetch(url, { redirect: 'error', ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// Error text names the status only, never the response body or any key.
const rejected = (label, res) => `${label} answered ${res.status}. Check the values and try again.`;
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function amazonToken(f) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: f.refresh_token,
    client_id: f.lwa_client_id,
    client_secret: f.lwa_client_secret,
  });
  const res = await http(AMAZON_LWA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(rejected('Amazon', res));
  return (await res.json()).access_token;
}

async function flipkartToken(f) {
  const res = await http(`${FLIPKART_API}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`, {
    headers: { Authorization: basic(f.app_id, f.app_secret) },
  });
  if (!res.ok) throw new Error(rejected('Flipkart', res));
  return (await res.json()).access_token;
}

// A Dev Dashboard app trades its Client ID and secret for a token that lasts about a day.
// Tokens stay in memory only, one per store and app.
const shopifyTokens = new Map();

async function shopifyToken(f, { fresh = false } = {}) {
  const key = `${f.shop_domain}|${f.client_id}`;
  const cached = shopifyTokens.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await http(`https://${f.shop_domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: f.client_id, client_secret: f.client_secret }),
  });
  if (!res.ok) throw new Error(rejected('Shopify', res));
  const body = await res.json();
  shopifyTokens.set(key, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 });
  return body.access_token;
}

// Calls the Shopify Admin API. A token the store rejects is replaced once, then the call is retried.
async function shopifyAdmin(f, path, init = {}) {
  const call = async (fresh) => {
    const token = await shopifyToken(f, { fresh });
    return http(`https://${f.shop_domain}/admin/api/${SHOPIFY_API}${path}`, {
      ...init,
      headers: { ...init.headers, 'X-Shopify-Access-Token': token },
    });
  };
  const res = await call(false);
  return res.status === 401 ? call(true) : res;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The product body Shopify's Admin API expects. Each SKU becomes a variant, and sizes become the Size option.
export function shopifyProductBody(product, imageUrls = []) {
  const attrs = product.attributes ?? {};
  const sized = product.variants.some((v) => v.size);
  const bullets = (attrs.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  return {
    product: {
      title: product.title,
      body_html: [attrs.description ? `<p>${escapeHtml(attrs.description)}</p>` : '', bullets ? `<ul>${bullets}</ul>` : ''].join(''),
      vendor: attrs.brand ?? '',
      tags: (attrs.search_terms ?? []).join(', '),
      status: 'active',
      ...(sized ? { options: [{ name: 'Size' }] } : {}),
      variants: product.variants.map((v) => ({
        sku: v.sku,
        price: String(v.selling_price ?? v.mrp ?? 0),
        compare_at_price: v.mrp && v.mrp > (v.selling_price ?? 0) ? String(v.mrp) : null,
        ...(sized ? { option1: v.size } : {}),
        inventory_management: 'shopify',
      })),
      ...(imageUrls.length ? { images: imageUrls.map((src) => ({ src })) } : {}),
    },
  };
}

// Creates the product in the store. Returns each SKU with its new variant ID and inventory item ID.
export async function createShopifyProduct(f, body) {
  const res = await shopifyAdmin(f, '/products.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 403) {
    throw new Error('Shopify refused to create the product. Add the write_products scope to the app in the Dev Dashboard, then reinstall it on the store.');
  }
  if (!res.ok) throw new Error(rejected('Shopify', res));
  const { product } = await res.json();
  return product.variants.map((v) => ({ sku: v.sku, variantId: String(v.id), inventoryItemId: v.inventory_item_id }));
}

// Sets the available quantity of one inventory item at the seller's location.
export function setShopifyStock(f, inventoryItemId, qty) {
  return shopifyAdmin(f, '/inventory_levels/set.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: Number(f.location_id), inventory_item_id: inventoryItemId, available: qty }),
  });
}

function signedPost(url, secret, payload) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return http(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-QuickList-Signature': `sha256=${signature}` },
    body,
  });
}

// Proves the keys work without changing any stock.
export async function testConnection(platform, f) {
  try {
    switch (platform) {
      case 'DEMO':
        return { ok: true, detail: 'Demo marketplace is ready. Every stock push is recorded below.' };
      case 'MEESHO':
        return { ok: true, detail: 'Saved. Meesho stock updates use the bulk sheet until API access is approved.' };
      case 'AMAZON_IN':
        await amazonToken(f);
        return { ok: true, detail: 'Amazon accepted your credentials. Stock updates are ready.' };
      case 'FLIPKART':
        await flipkartToken(f);
        return { ok: true, detail: 'Flipkart accepted your app credentials.' };
      case 'SHOPIFY': {
        const res = await shopifyAdmin(f, '/shop.json');
        return res.ok ? { ok: true, detail: 'Connected to your Shopify store.' } : { ok: false, detail: rejected('Shopify', res) };
      }
      case 'WOOCOMMERCE': {
        const res = await http(`${f.site_url}/wp-json/wc/v3/products?per_page=1`, {
          headers: { Authorization: basic(f.consumer_key, f.consumer_secret) },
        });
        return res.ok ? { ok: true, detail: 'Connected to your WooCommerce store.' } : { ok: false, detail: rejected('WooCommerce', res) };
      }
      case 'CUSTOM_SITE': {
        const res = await signedPost(f.stock_webhook_url, f.signing_secret, { type: 'ping', at: new Date().toISOString() });
        return res.ok ? { ok: true, detail: 'Your site answered the test ping.' } : { ok: false, detail: rejected('Your site', res) };
      }
      default:
        return { ok: false, detail: 'Unknown connector' };
    }
  } catch (err) {
    return { ok: false, detail: err.message.slice(0, 200) };
  }
}

// Reads a Shopify product list and maps each variant SKU to its variant ID.
// Only the first 250 products are read. Larger stores link the rest by hand.
export function parseShopifyProducts(body) {
  const map = new Map();
  for (const product of body.products ?? []) {
    for (const variant of product.variants ?? []) {
      if (variant.sku) map.set(String(variant.sku), String(variant.id));
    }
  }
  return map;
}

// Finds the store's own ID for each of our SKUs, so sellers don't type IDs by hand.
// Matching is a convenience: any failure returns no matches and the seller can still link by hand.
export async function matchListings(platform, f, skus) {
  const matches = new Map();
  try {
    if (platform === 'SHOPIFY') {
      const res = await shopifyAdmin(f, '/products.json?fields=id,variants&limit=250');
      if (!res.ok) return matches;
      const found = parseShopifyProducts(await res.json());
      for (const sku of skus) if (found.has(sku)) matches.set(sku, found.get(sku));
    }
    if (platform === 'WOOCOMMERCE') {
      for (const sku of skus) {
        const res = await http(`${f.site_url}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=1`, {
          headers: { Authorization: basic(f.consumer_key, f.consumer_secret) },
        });
        if (!res.ok) continue;
        const [product] = await res.json();
        if (product?.id) matches.set(sku, String(product.id));
      }
    }
  } catch {
    return new Map();
  }
  return matches;
}

// Sets the absolute stock for one SKU on one channel. Returns { ok } or
// { ok: false, error } or { ok: false, skipped: true } when a push is not possible yet.
export async function pushStock(platform, f, { sku, qty, listingId }, ctx = {}) {
  if (platform === 'DEMO') {
    ctx.db.prepare('INSERT INTO demo_pushes (id, tenant_id, sku, qty) VALUES (?, ?, ?, ?)').run(randomUUID(), ctx.tenantId, sku, qty);
    return { ok: true };
  }
  if (platform === 'MEESHO') {
    return { ok: false, skipped: true, error: 'Meesho stock is updated through the bulk sheet for now' };
  }
  try {
    switch (platform) {
      case 'AMAZON_IN': {
        const token = await amazonToken(f);
        const url = `${AMAZON_INDIA_ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(f.seller_id)}/${encodeURIComponent(sku)}?marketplaceIds=${AMAZON_INDIA_MARKETPLACE}`;
        const res = await http(url, {
          method: 'PATCH',
          headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productType: f.product_type || 'PRODUCT',
            patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: qty }] }],
          }),
        });
        return res.ok ? { ok: true } : { ok: false, error: rejected('Amazon', res) };
      }
      case 'FLIPKART': {
        const token = await flipkartToken(f);
        const res = await http(`${FLIPKART_API}/sellers/listings/v3/update/inventory`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ skuUpdateRequests: [{ sku, quantity: qty }] }),
        });
        return res.ok ? { ok: true } : { ok: false, error: rejected('Flipkart', res) };
      }
      case 'SHOPIFY': {
        if (!/^\d+$/.test(String(listingId))) return { ok: false, error: 'Link this SKU to its Shopify variant ID first' };
        const variant = await shopifyAdmin(f, `/variants/${listingId}.json`);
        if (!variant.ok) return { ok: false, error: rejected('Shopify', variant) };
        const inventoryItemId = (await variant.json()).variant.inventory_item_id;
        const res = await setShopifyStock(f, inventoryItemId, qty);
        return res.ok ? { ok: true } : { ok: false, error: rejected('Shopify', res) };
      }
      case 'WOOCOMMERCE': {
        if (!/^\d+(:\d+)?$/.test(String(listingId))) return { ok: false, error: 'Link this SKU to its WooCommerce product ID first' };
        const [parent, variation] = String(listingId).split(':');
        const path = variation ? `products/${parent}/variations/${variation}` : `products/${parent}`;
        const res = await http(`${f.site_url}/wp-json/wc/v3/${path}`, {
          method: 'PUT',
          headers: { Authorization: basic(f.consumer_key, f.consumer_secret), 'Content-Type': 'application/json' },
          body: JSON.stringify({ manage_stock: true, stock_quantity: qty }),
        });
        return res.ok ? { ok: true } : { ok: false, error: rejected('WooCommerce', res) };
      }
      case 'CUSTOM_SITE': {
        const res = await signedPost(f.stock_webhook_url, f.signing_secret, {
          type: 'stock.updated',
          sku,
          quantity: qty,
          listing_id: listingId,
          at: new Date().toISOString(),
        });
        return res.ok ? { ok: true } : { ok: false, error: rejected('Your site', res) };
      }
      default:
        return { ok: false, error: `No push for ${platform}` };
    }
  } catch (err) {
    return { ok: false, error: err.message.slice(0, 200) };
  }
}
