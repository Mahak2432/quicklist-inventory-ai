// QuickListInventoryAI web app. Plain ES module, no build step.
// Views: snap (photo to listing), stock, listings, orders, chat (WhatsApp simulator), settings.

const LOW_STOCK = 5;
const MAX_PHOTO = 12 * 1024 * 1024;
const TOKEN_KEY = 'qli_token';
const PHONE_KEY = 'qli_phone';
const PLATFORMS = [
  { id: 'AMAZON_IN', label: 'Amazon India', note: 'Orders API shape' },
  { id: 'FLIPKART', label: 'Flipkart', note: 'Generic relay shape' },
  { id: 'MEESHO', label: 'Meesho', note: 'Generic relay shape' },
  { id: 'SHOPIFY', label: 'Shopify', note: 'Webhook shape' },
];
const LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label]));
const CATEGORY_LABEL = { APPAREL: 'Apparel', FOOTWEAR: 'Footwear', GENERIC: 'General' };
const SIZE_PRESETS = {
  APPAREL: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  FOOTWEAR: ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11'],
};
const MISSING_LABEL = { sizes: 'sizes', stock: 'stock', mrp: 'MRP', selling_price: 'selling price' };

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '–' : `₹${Number(n).toLocaleString('en-IN')}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window: keep going */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const state = {
  token: store.get(TOKEN_KEY),
  shop: null,
  newToken: null,
  snap: { phase: 'empty' },
  stock: { rows: [], products: 0, filter: 'all', query: '' },
  orders: { feed: [], last: null, platform: 'AMAZON_IN', sku: '', qty: 1, skus: [] },
  chat: { phone: store.get(PHONE_KEY) || '', messages: [], skus: [] },
  photos: new Map(),
};

// ---------- API ----------

async function api(path, { method = 'GET', body, file, auth = true } = {}) {
  const headers = {};
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  let payload;
  if (file) {
    headers['Content-Type'] = file.type || 'application/octet-stream';
    payload = file;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.message || `Something went wrong (${res.status}).`);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadShop() {
  state.shop = await api('/api/me');
  $('#shop-name').textContent = `Shop: ${state.shop.tenant.name}`;
  return state.shop;
}

function setToken(token) {
  state.token = token;
  if (token) store.set(TOKEN_KEY, token);
  else store.del(TOKEN_KEY);
}

async function blobUrl(path) {
  if (state.photos.has(path)) return state.photos.get(path);
  const res = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error('Photo not available');
  const url = URL.createObjectURL(await res.blob());
  state.photos.set(path, url);
  return url;
}

function hydratePhotos(root) {
  root.querySelectorAll('img[data-photo]').forEach(async (img) => {
    try {
      img.src = await blobUrl(img.dataset.photo);
    } catch {
      img.alt = 'Photo not available yet';
    }
  });
}

// ---------- Shell and routing ----------

const views = {
  snap: renderSnap,
  stock: renderStock,
  listings: renderListings,
  orders: renderOrders,
  chat: renderChat,
  settings: renderSettingsPage,
};

let renderId = 0;

async function render() {
  if (!state.token) return renderOnboard();
  const requested = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const route = views[requested] ? requested : 'snap';
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const id = ++renderId;
  let html;
  try {
    html = await views[route]();
  } catch (err) {
    if (err.status === 401) {
      setToken(null);
      return renderOnboard();
    }
    html = `<div class="notice notice-bad" role="alert"><strong>Something went wrong</strong><p>${esc(err.message)}</p></div>`;
  }
  if (id !== renderId) return;
  const root = $('#view');
  root.innerHTML = html;
  hydratePhotos(root);
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast is-${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Copy failed. Select the text and copy it yourself.', 'bad');
  }
}

// ---------- Onboarding ----------

function renderOnboard(step = 'start', token = '') {
  $('#app').classList.add('hidden');
  let root = $('#onboard');
  if (!root) {
    root = document.createElement('main');
    root.id = 'onboard';
    root.className = 'onboard';
    document.body.append(root);
  }
  let card;
  if (step === 'token') card = tokenCard(token);
  else if (step === 'paste') card = pasteCard();
  else card = startCard();
  root.innerHTML = `${brandPanelHTML()}<section class="onboard-card" aria-labelledby="onboard-h">${card}</section>`;
  root.querySelector('input')?.focus();
}

// The left panel on the sign-up and log-in page. It says what the app does before asking for anything.
function brandPanelHTML() {
  return `
    <aside class="onboard-brand" aria-label="About QuickListInventoryAI">
      <div class="brand-lockup">
        <svg viewBox="0 0 30 30" aria-hidden="true"><path d="M2 14V3h11l14 14-11 11z" fill="#FF4B32"/><circle cx="8" cy="9" r="2.4" fill="#17191C"/></svg>
        QuickListInventoryAI
      </div>
      <div class="stack" style="gap:18px">
        <h2>Snap a photo. Get a listing. Sell everywhere.</h2>
        <ul class="onboard-points">
          <li>Writes the title, bullets and description from your photo.</li>
          <li>Crops and brightens rough shots, makes white-background photos, and can put a product on a mannequin from a short note.</li>
          <li>Keeps one stock count across Shopify, Amazon, Flipkart and Meesho.</li>
        </ul>
      </div>
      <p class="brand-foot">Built for small Indian sellers.</p>
    </aside>`;
}

function startCard() {
  const login = state.authTab === 'login';
  return `
    <div class="stack" style="gap:8px">
      <p class="eyebrow">${login ? 'Welcome back' : 'Get started'}</p>
      <h1 id="onboard-h">${login ? 'Log in to your shop' : 'Open your shop'}</h1>
      <p class="muted">${login ? 'Use the email and password you signed up with.' : 'Takes under a minute. You can add products and connect stores afterwards.'}</p>
    </div>
    <div class="auth-tabs" role="tablist" aria-label="Account">
      <button type="button" class="chip" role="tab" data-action="auth-tab" data-tab="signup" aria-selected="${!login}" aria-pressed="${!login}">Create account</button>
      <button type="button" class="chip" role="tab" data-action="auth-tab" data-tab="login" aria-selected="${login}" aria-pressed="${login}">Log in</button>
    </div>
    ${login ? loginFields() : signupFields()}
    <div class="demo-box">
      <p><strong>Just looking?</strong> The demo shop loads sample products, a Demo marketplace, a sample order and a WhatsApp chat, so you can watch stock move in about a minute.</p>
      <button type="button" class="btn btn-indigo" data-action="onboard-demo" id="demo-btn">Try the demo shop</button>
      <p class="muted" id="seed-status" role="status" aria-live="polite"></p>
    </div>
    <p class="fine-print"><button type="button" class="link-btn" data-action="onboard-paste">I have a token from another device</button></p>`;
}

// Password field with a show and hide button. The input keeps the id the sign-in actions read.
function passwordField(autocomplete, placeholder) {
  return `
    <label class="field"><span>Password</span>
      <span class="pw">
        <input class="input" id="auth-password" type="password" minlength="8" autocomplete="${autocomplete}" placeholder="${placeholder}">
        <button type="button" class="pw-toggle" data-action="toggle-password" aria-label="Show password">Show</button>
      </span>
    </label>`;
}

function signupFields() {
  return `
    <div class="auth-fields">
      <label class="field"><span>Shop name</span>
        <input class="input" id="auth-shop" maxlength="100" placeholder="for example Meera Kurtis" autocomplete="organization">
      </label>
      <label class="field"><span>Email</span>
        <input class="input" id="auth-email" type="email" autocomplete="email" placeholder="you@example.com">
      </label>
      ${passwordField('new-password', 'At least 8 characters')}
    </div>
    <button type="button" class="btn btn-primary btn-block" data-action="auth-signup">Create my account</button>`;
}

function loginFields() {
  return `
    <div class="auth-fields">
      <label class="field"><span>Email</span>
        <input class="input" id="auth-email" type="email" autocomplete="email" placeholder="you@example.com">
      </label>
      ${passwordField('current-password', '')}
    </div>
    <button type="button" class="btn btn-primary btn-block" data-action="auth-login">Log in</button>`;
}

function tokenCard(token) {
  return `
    <div class="stack" style="gap:10px">
      <h1 id="onboard-h">Your shop is open</h1>
      <p>Save this token somewhere safe. It is the only way to sign back in on another device, and it is shown once.</p>
    </div>
    <div class="token-box">${esc(token)}</div>
    <div class="row">
      <button type="button" class="btn btn-quiet" data-action="copy-token" data-copy="${esc(token)}">Copy token</button>
      <button type="button" class="btn btn-primary" data-action="onboard-continue">I have saved it. Open the app</button>
    </div>`;
}

function pasteCard() {
  return `
    <div class="stack" style="gap:10px">
      <h1 id="onboard-h">Paste your token</h1>
      <p>Use the token from the device where you opened the shop.</p>
    </div>
    <label class="field"><span>Token</span>
      <input class="input" id="onboard-token" autocomplete="off" spellcheck="false" placeholder="qli_…">
    </label>
    <div class="row">
      <button type="button" class="btn btn-primary" data-action="onboard-use-token">Continue</button>
      <button type="button" class="btn btn-quiet" data-action="onboard-back">Back</button>
    </div>`;
}

async function enterApp(route = '#/snap') {
  await loadShop();
  $('#onboard')?.remove();
  $('#app').classList.remove('hidden');
  location.hash = route;
  await render();
}

// ---------- Demo shop ----------

const DEMO_PHONE = '919000000001';
const DEMO_PRODUCTS = [
  {
    file: '/samples/navy-running-shoe.png',
    hint: 'navy running shoe',
    fields: {
      title: 'Navy Mesh Running Shoes for Men, Lightweight with Cushioned Sole',
      brand: 'Stride',
      category: 'FOOTWEAR',
      color: 'Navy Blue',
      material: 'Mesh and synthetic',
      description: 'Breathable mesh upper and a cushioned sole for daily runs and walks. Lightweight, with a secure lace-up fit.',
      bullets: [
        'Breathable mesh upper keeps feet cool',
        'Cushioned sole for all-day comfort',
        'Lace-up fit with a padded collar',
        'Lightweight build for running and walking',
        'Quick-dry lining, easy to clean',
      ],
      search_terms: ['running shoes', 'mens sneakers', 'navy shoes', 'mesh shoes'],
      hsn_code: '6404',
    },
    answers: {
      sizes: ['UK 7', 'UK 8', 'UK 9', 'UK 10'],
      stock_per_size: { 'UK 7': 10, 'UK 8': 12, 'UK 9': 12, 'UK 10': 8 },
      mrp: 1499,
      selling_price: 799,
    },
  },
  {
    file: '/samples/block-print-kurta.png',
    hint: 'block print kurta',
    fields: {
      title: 'Indigo Block Print Cotton Kurta for Women',
      brand: 'Meera Kurtis',
      category: 'APPAREL',
      color: 'Indigo',
      material: 'Cotton',
      description: 'A relaxed cotton kurta with a hand block print in indigo and mustard. Suits office wear and festive days.',
      bullets: [
        'Hand block print in indigo and mustard',
        'Soft cotton that breathes in summer',
        'Relaxed fit for everyday comfort',
        'Machine wash cold, line dry',
        'Pairs with churidar, jeans or palazzos',
      ],
      search_terms: ['kurta', 'block print kurta', 'cotton kurta women'],
    },
    answers: {
      sizes: ['S', 'M', 'L', 'XL'],
      stock_per_size: { S: 6, M: 8, L: 8, XL: 4 },
      mrp: 1299,
      selling_price: 649,
    },
  },
  {
    file: '/samples/grey-hoodie.png',
    hint: 'grey hoodie',
    fields: {
      title: 'Grey Fleece Hoodie with Kangaroo Pocket',
      brand: 'Northwind',
      category: 'APPAREL',
      color: 'Grey',
      material: 'Cotton fleece',
      description: 'A warm fleece hoodie with a kangaroo pocket and drawstring hood. A layer for cool evenings.',
      bullets: [
        'Soft fleece lining for warmth',
        'Kangaroo pocket for hands and small items',
        'Drawstring hood with a relaxed fit',
        'Ribbed cuffs and hem hold their shape',
        'Machine wash cold',
      ],
      search_terms: ['hoodie', 'grey hoodie', 'fleece hoodie'],
    },
    answers: {
      sizes: ['M', 'L', 'XL'],
      stock_per_size: { M: 5, L: 0, XL: 3 },
      mrp: 999,
      selling_price: 549,
    },
  },
];

function setSeedStatus(text) {
  const el = $('#seed-status');
  if (el) el.textContent = text;
}

// Builds a shop through the same APIs a real seller uses: photo upload, draft
// answers, publish, connect, order. Nothing is faked on the server.
async function seedDemoShop() {
  const btn = $('#demo-btn');
  btn.disabled = true;
  try {
    setSeedStatus('Creating your demo shop…');
    const shop = await api('/api/tenants', { method: 'POST', body: { name: 'Meera Kurtis & Shoes (demo)' }, auth: false });
    setToken(shop.token);

    setSeedStatus('Connecting the Demo marketplace…');
    await api('/api/connections/DEMO', { method: 'PUT', body: { fields: {} } });

    for (const [i, p] of DEMO_PRODUCTS.entries()) {
      setSeedStatus(`Adding sample product ${i + 1} of ${DEMO_PRODUCTS.length}…`);
      const photo = await (await fetch(p.file)).blob();
      const view = await api(`/api/listings/drafts?hint=${encodeURIComponent(p.hint)}`, { method: 'POST', file: photo });
      await api(`/api/listings/drafts/${view.id}`, { method: 'PATCH', body: { fields: p.fields, answers: p.answers } });
      await api(`/api/listings/drafts/${view.id}/publish`, { method: 'POST' });
    }

    setSeedStatus('Placing a sample Amazon order…');
    const sku = (await api('/api/products'))
      .find((p) => p.category === 'FOOTWEAR')
      .variants.find((v) => v.size === 'UK 9').sku;
    const orderId = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    await api('/api/orders/AMAZON_IN', {
      method: 'POST',
      body: { AmazonOrderId: orderId, OrderItems: [{ OrderItemId: `${orderId}-1`, SellerSKU: sku, QuantityOrdered: 2 }] },
    });
    await api('/api/outbox/drain', { method: 'POST' });

    setSeedStatus('Linking the sample WhatsApp chat…');
    await api('/api/whatsapp/link', { method: 'POST', body: { phone: DEMO_PHONE } });
    state.chat.phone = DEMO_PHONE;
    state.chat.messages = [];
    store.set(PHONE_KEY, DEMO_PHONE);

    setSeedStatus('Done. Opening your stock.');
    await enterApp('#/stock');
    toast('Demo shop ready. Your token is in Settings if you want to use it on another device.');
  } catch (err) {
    setSeedStatus(`Could not finish the demo: ${err.message}`);
    btn.disabled = false;
    toast(err.message, 'bad');
  }
}

// ---------- Snap: photo to listing ----------

function renderSnap() {
  const s = state.snap;
  if (s.phase === 'analyzing') return analyzingHTML(s);
  if (s.phase === 'review') return reviewHTML(s);
  if (s.phase === 'published') return publishedHTML(s);
  return emptyHTML();
}

function emptyHTML() {
  return `
    <header class="hero">
      <h1>Snap it. Sell it everywhere.</h1>
      <p>Take one photo. QuickListInventoryAI writes the title, bullets, description and HSN suggestion, then asks only for what a photo cannot show: sizes, stock and prices.</p>
    </header>
    ${stepsHTML(1)}
    <section class="dropzone" id="dropzone" aria-labelledby="drop-h">
      <svg class="dropzone-art" viewBox="0 0 84 84" aria-hidden="true">
        <path d="M10 42V10h30l34 34-30 30z" fill="#FF4B32"/>
        <circle cx="24" cy="24" r="6" fill="#17191C"/>
      </svg>
      <h2 id="drop-h">Drop a product photo here</h2>
      <p class="muted">Up to 8 photos, JPEG, PNG or WebP, 12 MB each. Rough shots are fine: you can crop, rotate and brighten them before publishing.</p>
      <label class="field hint-field"><span>What is it, or what should we make? (optional)</span>
        <input class="input" id="hint" maxlength="120" placeholder="for example: navy running shoes, or put it on a mannequin">
      </label>
      <div class="dropzone-actions">
        <button type="button" class="btn btn-primary" data-action="pick-camera">Take a photo</button>
        <button type="button" class="btn btn-quiet" data-action="pick-file">Choose from gallery</button>
      </div>
    </section>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="file" accept="image/jpeg,image/png,image/webp" multiple hidden>`;
}

function analyzingHTML(s) {
  return `
    ${stepsHTML(2)}
    <div class="review">
      <div class="photo-frame scan" aria-busy="true">
        <img src="${esc(s.preview)}" alt="Your product photo, being read">
      </div>
      <div class="stack">
        <h2>Reading your photo</h2>
        <p class="muted">Writing the title, bullets, description and HSN suggestion. This can take a few seconds.</p>
      </div>
    </div>`;
}

function reviewHTML(s) {
  const v = s.view;
  const e = s.edits;
  const l = e.listing;
  const needsSizes = Boolean(SIZE_PRESETS[l.category]);
  const missing = missingFromEdits(e, l.category);
  const busy = s.busy;
  const photos = photoStripHTML(v, busy);

  return `
    ${stepsHTML(missing.length ? 3 : 4)}
    <div class="review" id="review">
      <section class="stack photo-column" aria-label="Product photos">
        ${photos}
      </section>
      <div class="stack">
        ${listingCardHTML(l)}
        ${detailsCardHTML(l, e.details, needsSizes)}
      </div>
    </div>
    <div class="publish-bar">
      <div class="row between">
        <p class="muted" role="status">${missing.length ? `Still needed: ${missingNames(missing)}.` : 'All set. Publishing puts the stock live.'}</p>
        <button type="button" class="btn btn-primary" data-action="publish" ${busy ? 'disabled' : ''}>
          ${busy === 'publish' ? '<span class="spinner" aria-hidden="true"></span> Publishing' : 'Publish to my stock'}
        </button>
      </div>
    </div>`;
}

function publishedHTML(s) {
  const p = s.product;
  return `
    ${stepsHTML(5)}
    <section class="card done-card" aria-labelledby="done-h">
      <span class="pill pill-ok">Live in your stock</span>
      <h2 id="done-h">${esc(p.title)}</h2>
      <p class="muted">Listed as ${esc(p.master_sku)} with ${plural(p.variants.length, 'SKU')}.</p>
      <ul class="sku-list">
        ${p.variants.map((v) => `<li><span>${esc(v.sku)}</span><span>${v.stock_qty} in stock · ${inr(v.selling_price)}</span></li>`).join('')}
      </ul>
      <div class="row">
        <a class="btn btn-indigo" href="#/listings">See listings and sheets</a>
        <button type="button" class="btn btn-quiet" data-action="snap-again">Snap another product</button>
      </div>
    </section>`;
}

function stepsHTML(current) {
  const labels = ['Photo', 'Listing', 'Details', 'Publish'];
  return `<ol class="steps" aria-label="Progress">${labels.map((label, i) => {
    const n = i + 1;
    const st = n < current ? 'done' : n === current ? 'current' : 'todo';
    return `<li data-state="${st}"${st === 'current' ? ' aria-current="step"' : ''}><span class="dot">${st === 'done' ? '✓' : n}</span>${label}</li>`;
  }).join('')}</ol>`;
}

// One card per photo. Each card chooses how its photo goes on the listing and can be edited or removed.
function photoStripHTML(v, busy) {
  const photos = v.draft.photos;
  const disabled = busy ? 'disabled' : '';
  const cards = photos.map((p, i) => {
    const kind = p.mode === 'STUDIO' && p.enhanced ? 'enhanced' : 'original';
    const label = i === 0 ? 'Main photo' : `Photo ${i + 1}`;
    const from = p.source === 'generated' ? 'Made from your note' : p.source === 'edited' ? 'Edited' : '';
    return `
      <figure class="shot">
        <div class="shot-frame"><img data-photo="/api/media/${esc(v.id)}?variant=${i}-${kind}" alt="${esc(label)}"></div>
        <figcaption><strong>${label}</strong>${from ? `<span>${esc(from)}</span>` : ''}</figcaption>
        <div class="shot-mode" role="group" aria-label="${label}: how it goes on the listing">
          <button type="button" data-action="photo-mode" data-index="${i}" data-mode="ORIGINAL" aria-pressed="${p.mode !== 'STUDIO'}" ${disabled}>As is</button>
          <button type="button" data-action="photo-mode" data-index="${i}" data-mode="STUDIO" aria-pressed="${p.mode === 'STUDIO'}" ${disabled}>White background</button>
        </div>
        <div class="shot-tools">
          <button type="button" class="btn btn-quiet btn-small" data-action="photo-edit" data-index="${i}" ${disabled}>Edit</button>
          <button type="button" class="btn btn-quiet btn-small" data-action="photo-remove" data-index="${i}" ${disabled}>Remove</button>
        </div>
      </figure>`;
  }).join('');
  const addButton = photos.length < MAX_PHOTOS_UI
    ? `<button type="button" class="shot shot-add" data-action="photo-add" ${disabled}><span aria-hidden="true">+</span>Add photo</button>`
    : '';
  const note = busy === 'studio'
    ? '<p class="mode-note" role="status"><span class="spinner" aria-hidden="true"></span> Making the white-background photo. This takes a few seconds.</p>'
    : `<p class="mode-note" role="status">${esc(photoNote(photos))}</p>`;
  return `
    <section class="photo-strip" aria-label="Photos on the listing">${cards}${addButton}</section>
    ${note}
    <input type="file" id="file" accept="image/jpeg,image/png,image/webp" multiple hidden>`;
}

function photoNote(photos) {
  if (!photos.length) return 'Add a photo to list it on your marketplaces.';
  const methods = photos.filter((p) => p.mode === 'STUDIO' && p.enhanced).map((p) => p.method);
  if (methods.includes('mask')) return 'Background cleared because it was plain. Check the edges before you publish.';
  if (methods.includes('canvas')) return 'Centred on white. The background stayed because it was busy. A Meta key replaces it fully.';
  return 'Each photo goes on the listing the way you set it. Use Edit to crop, rotate or brighten a rough shot.';
}

function listingCardHTML(l) {
  const categories = Object.entries(CATEGORY_LABEL)
    .map(([key, label]) => `<option value="${key}" ${l.category === key ? 'selected' : ''}>${label}</option>`)
    .join('');
  const bullets = l.bullets
    .map((b, i) => `
      <div class="bullet-row">
        <span class="mark" aria-hidden="true">•</span>
        <input class="input" data-bullet value="${esc(b)}" maxlength="200" aria-label="Bullet ${i + 1}">
        <button type="button" class="btn btn-quiet btn-icon" data-action="remove-bullet" data-index="${i}" aria-label="Remove bullet ${i + 1}">×</button>
      </div>`)
    .join('');
  const terms = l.search_terms
    .map((t, i) => `<button type="button" class="chip" data-action="remove-term" data-index="${i}" aria-label="Remove ${esc(t)}">${esc(t)} <span class="x" aria-hidden="true">×</span></button>`)
    .join('');

  return `
    <section class="card stack" aria-labelledby="listing-h">
      <div class="row between">
        <h2 id="listing-h">Your listing</h2>
        <span class="auto-note">Written by AI. Edit anything.</span>
      </div>
      <label class="field"><span>Title</span>
        <input class="input" data-listing="title" maxlength="150" value="${esc(l.title)}">
      </label>
      <div class="price-grid">
        <label class="field"><span>Category</span>
          <select class="select" data-listing="category">${categories}</select>
        </label>
        <label class="field"><span>Brand</span>
          <input class="input" data-listing="brand" maxlength="60" value="${esc(l.brand)}" placeholder="Needed by Amazon and Flipkart">
        </label>
        <label class="field"><span>Colour</span>
          <input class="input" data-listing="color" maxlength="60" value="${esc(l.color)}">
        </label>
      </div>
      <div class="field"><span>Bullet points</span>
        <div class="bullets">${bullets}</div>
        ${l.bullets.length < 5 ? '<div><button type="button" class="btn btn-quiet btn-small" data-action="add-bullet">Add a bullet</button></div>' : ''}
      </div>
      <label class="field"><span>Description</span>
        <textarea class="textarea" data-listing="description" maxlength="2000">${esc(l.description)}</textarea>
      </label>
      <div class="field"><span>Search terms</span>
        <div class="row" style="gap:8px">${terms || '<span class="muted">None yet</span>'}</div>
        <div class="row">
          <input class="input" id="new-term" placeholder="Add a keyword" aria-label="Add a search term" style="max-width:260px">
          <button type="button" class="btn btn-quiet btn-small" data-action="add-term">Add keyword</button>
        </div>
      </div>
      <div class="price-grid">
        <label class="field"><span>HSN code</span>
          <input class="input" data-listing="hsn_code" maxlength="20" value="${esc(l.hsn_code)}">
        </label>
        <label class="field"><span>Material</span>
          <input class="input" data-listing="material" maxlength="60" value="${esc(l.material)}">
        </label>
      </div>
      <p class="muted">HSN and GST are suggestions. Confirm them with your CA, because the GST rate can depend on price.</p>
      <div class="row"><button type="button" class="btn btn-quiet" data-action="save-listing">Save listing text</button></div>
    </section>`;
}

function detailsCardHTML(l, det, needsSizes) {
  const presets = SIZE_PRESETS[l.category] ?? [];
  const sizes = [...new Set([...presets, ...det.sizes])];
  const sizeBlock = needsSizes ? `
    <div class="field"><span>Sizes you sell</span>
      <div class="size-grid" role="group" aria-label="Sizes you sell">
        ${sizes.map((s) => `<button type="button" class="chip" data-action="toggle-size" data-size="${esc(s)}" aria-pressed="${det.sizes.includes(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="row">
        <input class="input" id="custom-size" maxlength="12" placeholder="Another size, e.g. 28" aria-label="Another size" style="max-width:240px">
        <button type="button" class="btn btn-quiet btn-small" data-action="add-size">Add size</button>
      </div>
    </div>` : '';

  let stockBlock;
  if (!needsSizes) stockBlock = stockRow('', det.generic_stock, true);
  else if (det.sizes.length) stockBlock = `<div class="stock-grid" aria-label="Stock per size">${det.sizes.map((s) => stockRow(s, det.stock[s])).join('')}</div>`;
  else stockBlock = '<p class="muted">Pick the sizes you have. Stock is then set for each one.</p>';

  const info = discountInfo(det.mrp, det.price);
  return `
    <section class="card stack" aria-labelledby="details-h">
      <div class="stack" style="gap:6px">
        <h2 id="details-h">The details only you know</h2>
        <p class="muted">A photo cannot show sizes, stock or prices.</p>
      </div>
      ${sizeBlock}
      ${stockBlock}
      <div class="price-grid">
        <label class="field"><span>MRP (₹)</span>
          <input class="input" type="number" min="0" step="any" inputmode="decimal" data-price="mrp" value="${esc(det.mrp)}">
        </label>
        <label class="field"><span>Your selling price (₹)</span>
          <input class="input" type="number" min="0" step="any" inputmode="decimal" data-price="price" value="${esc(det.price)}">
        </label>
      </div>
      <p class="discount ${info.bad ? 'is-bad' : ''}" id="discount" aria-live="polite">${esc(info.text)}</p>
      <div class="field"><span>Or type it in one line</span>
        <div class="row">
          <input class="input" id="quick-text" placeholder="sizes 7 to 10, 15 each, MRP 1499, sell 799" aria-label="Type the details in one line" style="flex:1;min-width:220px">
          <button type="button" class="btn btn-indigo" data-action="read-text">Read it</button>
        </div>
        <small class="muted">Hindi and Hinglish work too.</small>
      </div>
      <div class="row"><button type="button" class="btn btn-quiet" data-action="save-details">Save details</button></div>
    </section>`;
}

function stockRow(label, value, total = false) {
  const attr = total ? 'data-stock-total' : `data-stock="${esc(label)}"`;
  const name = total ? 'Units in stock' : esc(label);
  return `
    <div class="stock-row">
      <span class="num" style="font-weight:600">${total ? 'Units in stock' : name}</span>
      <div class="stepper">
        <button type="button" data-action="step" data-delta="-1" aria-label="Remove one from ${total ? 'stock' : name}">−</button>
        <input type="number" min="0" inputmode="numeric" ${attr} value="${esc(value ?? '')}" aria-label="${total ? 'Units in stock' : `Stock for ${name}`}">
        <button type="button" data-action="step" data-delta="1" aria-label="Add one to ${total ? 'stock' : name}">+</button>
      </div>
    </div>`;
}

function discountInfo(mrp, price) {
  const m = Number(mrp);
  const p = Number(price);
  if (!m || !p) return { text: '', bad: false };
  if (p > m) return { text: 'Selling price is above MRP. Marketplaces usually reject that.', bad: true };
  return { text: `You sell ${Math.round((1 - p / m) * 100)}% below MRP.`, bad: false };
}

function updateDiscount() {
  const el = $('#discount');
  if (!el) return;
  const info = discountInfo($('[data-price="mrp"]')?.value, $('[data-price="price"]')?.value);
  el.textContent = info.text;
  el.classList.toggle('is-bad', info.bad);
}

function editsFrom(draft) {
  const a = draft.answers || {};
  return {
    listing: {
      title: draft.title,
      category: draft.category,
      brand: draft.brand || '',
      color: draft.color || '',
      material: draft.material || '',
      description: draft.description || '',
      hsn_code: draft.hsn_code ?? '',
      bullets: [...(draft.bullets || [])],
      search_terms: [...(draft.search_terms || [])],
    },
    details: detailsFrom(a),
  };
}

function detailsFrom(a) {
  return {
    sizes: [...(a.sizes || [])],
    stock: { ...(a.stock_per_size || {}) },
    generic_stock: a.stock_total ?? '',
    mrp: a.mrp ?? '',
    price: a.selling_price ?? '',
  };
}

// Reads what is on screen into state, so re-rendering never loses typed text.
function captureEdits() {
  const root = $('#review');
  const e = state.snap.edits;
  if (!root || !e) return;
  for (const el of root.querySelectorAll('[data-listing]')) e.listing[el.dataset.listing] = el.value;
  e.listing.bullets = [...root.querySelectorAll('[data-bullet]')].map((el) => el.value);
  for (const el of root.querySelectorAll('[data-stock]')) e.details.stock[el.dataset.stock] = el.value;
  const total = root.querySelector('[data-stock-total]');
  if (total) e.details.generic_stock = total.value;
  const mrp = root.querySelector('[data-price="mrp"]');
  const price = root.querySelector('[data-price="price"]');
  if (mrp) e.details.mrp = mrp.value;
  if (price) e.details.price = price.value;
}

function listingPayload(l) {
  return {
    title: l.title.trim(),
    category: l.category,
    brand: l.brand.trim(),
    color: l.color.trim(),
    material: l.material.trim(),
    description: l.description.trim(),
    hsn_code: l.hsn_code.trim() || null,
    bullets: l.bullets.map((b) => b.trim()).filter(Boolean).slice(0, 5),
    search_terms: l.search_terms.slice(0, 8),
  };
}

function detailsPayload(d, category) {
  const toInt = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.max(0, Math.trunc(Number(v))));
  const toNum = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  const common = { mrp: toNum(d.mrp), selling_price: toNum(d.price) };
  if (!SIZE_PRESETS[category]) return { ...common, stock_total: toInt(d.generic_stock) };
  const stock_per_size = {};
  for (const s of d.sizes) {
    const n = toInt(d.stock[s]);
    if (n !== null) stock_per_size[s] = n;
  }
  return { ...common, sizes: d.sizes, stock_per_size };
}

function missingFromEdits(e, category) {
  const out = [];
  const needsSizes = Boolean(SIZE_PRESETS[category]);
  const filled = (v) => v !== '' && v !== null && v !== undefined;
  if (needsSizes && !e.details.sizes.length) out.push('sizes');
  const stockOk = needsSizes
    ? e.details.sizes.length > 0 && e.details.sizes.every((s) => filled(e.details.stock[s]))
    : filled(e.details.generic_stock);
  if (!stockOk) out.push('stock');
  if (!filled(e.details.mrp)) out.push('mrp');
  if (!filled(e.details.price)) out.push('selling_price');
  return out;
}

function missingNames(missing) {
  return missing.map((m) => MISSING_LABEL[m] ?? m).join(', ');
}

async function patchDraft(body) {
  return api(`/api/listings/drafts/${state.snap.view.id}`, { method: 'PATCH', body });
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTOS_UI = 8;

// Checks the photos the seller picked. Returns null, after a message, when one is not allowed.
function pickedPhotos(files) {
  const list = [...(files ?? [])];
  if (!list.length) return null;
  if (list.some((f) => !PHOTO_TYPES.includes(f.type))) {
    toast('Use JPEG, PNG or WebP photos.', 'bad');
    return null;
  }
  if (list.some((f) => f.size > MAX_PHOTO)) {
    toast('One photo is over 12 MB. Try a smaller one.', 'bad');
    return null;
  }
  return list;
}

// The first photo starts the draft and reads the listing. Any others are added to it.
async function startAnalysis(files) {
  const picked = pickedPhotos(files)?.slice(0, MAX_PHOTOS_UI);
  if (!picked) return;
  const hint = $('#hint')?.value.trim() ?? '';
  state.snap = { phase: 'analyzing', preview: URL.createObjectURL(picked[0]), hint, count: picked.length };
  await render();
  try {
    const first = await api(`/api/listings/drafts?hint=${encodeURIComponent(hint)}`, { method: 'POST', file: picked[0] });
    let view = first;
    for (const file of picked.slice(1)) view = await api(`/api/listings/drafts/${first.id}/photos`, { method: 'POST', file });
    state.snap = { phase: 'review', view, edits: editsFrom(view.draft), busy: null };
    state.photos.clear();
    if (first.analysis_error) toast('The photo could not be read. Fill in the listing yourself.', 'bad');
    else if (first.note_photo_error) toast(`Could not make the new photo. ${first.note_photo_error}`, 'bad');
    else toast(picked.length > 1 ? `Listing drafted from ${plural(picked.length, 'photo')}. Check it, then add the details.` : 'Listing drafted. Check it, then add the details.');
  } catch (err) {
    state.snap = { phase: 'empty' };
    toast(err.message, 'bad');
  }
  await render();
}

// Adds photos to the draft on screen.
async function addPhotos(files) {
  const list = pickedPhotos(files);
  if (!list) return;
  if (state.snap.view.draft.photos.length + list.length > MAX_PHOTOS_UI) {
    toast(`A listing holds up to ${MAX_PHOTOS_UI} photos.`, 'bad');
    return;
  }
  captureEdits();
  state.snap.busy = 'photo';
  await render();
  try {
    let view = state.snap.view;
    for (const file of list) view = await api(`/api/listings/drafts/${view.id}/photos`, { method: 'POST', file });
    state.snap.view = view;
    state.photos.clear();
    toast(`Added ${plural(list.length, 'photo')}.`);
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    state.snap.busy = null;
    await render();
  }
}

// Sets whether one photo goes on the listing as it is, or with a white background.
async function setPhotoMode(index, mode) {
  captureEdits();
  state.snap.busy = mode === 'STUDIO' ? 'studio' : 'mode';
  await render();
  try {
    const view = await patchDraft({ photo_mode: { index, mode } });
    state.snap.view = view;
    state.photos.clear();
    if (mode === 'STUDIO') {
      const method = view.draft.photos[index]?.method;
      toast(method === 'muse-image' ? 'White background made with Muse Image.' : 'White background made on this device.');
    }
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    state.snap.busy = null;
    await render();
  }
}

async function removePhotoAt(index) {
  captureEdits();
  state.snap.busy = 'photo';
  await render();
  try {
    state.snap.view = await api(`/api/listings/drafts/${state.snap.view.id}/photos/${index}`, { method: 'DELETE' });
    state.photos.clear();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    state.snap.busy = null;
    await render();
  }
}

// ---------- Photo editor ----------
// Edits happen in the browser. Saving sends the result back as the photo's new original.

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open that photo.'));
    img.src = src;
  });
}

async function openEditor(index) {
  captureEdits();
  try {
    const res = await fetch(`/api/media/${state.snap.view.id}?variant=${index}-original`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error('Could not open that photo.');
    const img = await loadImage(URL.createObjectURL(await res.blob()));
    state.editor = { index, img, rotate: 0, crop: 'free', brightness: 0, contrast: 0 };
    showEditor();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function showEditor() {
  let root = $('#editor');
  if (!root) {
    root = document.createElement('div');
    root.id = 'editor';
    root.className = 'editor';
    document.body.append(root);
  }
  const e = state.editor;
  const crops = [['free', 'Original'], ['square', 'Square'], ['portrait', '4:5']];
  root.innerHTML = `
    <div class="editor-card" role="dialog" aria-modal="true" aria-labelledby="editor-h">
      <header class="row between">
        <h2 id="editor-h">Edit photo ${e.index + 1}</h2>
        <button type="button" class="btn btn-quiet btn-small" data-action="editor-close">Close</button>
      </header>
      <div class="editor-stage"><canvas id="editor-canvas" role="img" aria-label="Preview of the edited photo"></canvas></div>
      <div class="editor-tools">
        <div class="row" role="group" aria-label="Rotate">
          <button type="button" class="btn btn-quiet btn-small" data-action="editor-rotate" data-by="-90">Rotate left</button>
          <button type="button" class="btn btn-quiet btn-small" data-action="editor-rotate" data-by="90">Rotate right</button>
        </div>
        <div class="row" role="group" aria-label="Crop shape">
          ${crops.map(([id, label]) => `<button type="button" class="chip" data-action="editor-crop" data-crop="${id}" aria-pressed="${e.crop === id}">${label}</button>`).join('')}
        </div>
        <label class="slider"><span>Brightness</span><input type="range" min="-40" max="40" value="${e.brightness}" data-editor="brightness"></label>
        <label class="slider"><span>Contrast</span><input type="range" min="-40" max="40" value="${e.contrast}" data-editor="contrast"></label>
      </div>
      <footer class="row between">
        <p class="muted">Saving replaces this photo. If it had a white background, that is made again.</p>
        <button type="button" class="btn btn-primary" data-action="editor-save" id="editor-save">Save photo</button>
      </footer>
    </div>`;
  drawEditor();
}

// Draws the photo with the chosen rotation, crop, brightness and contrast.
function renderEdited(e, maxSide) {
  const { img } = e;
  const turned = e.rotate % 180 !== 0;
  const w = turned ? img.naturalHeight : img.naturalWidth;
  const h = turned ? img.naturalWidth : img.naturalHeight;
  const ratio = { free: 0, square: 1, portrait: 0.8 }[e.crop];
  let cw = w;
  let ch = h;
  if (ratio) {
    if (w / h > ratio) cw = h * ratio;
    else ch = w / ratio;
  }
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale);
  out.height = Math.round(ch * scale);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.filter = `brightness(${100 + e.brightness * 2.5}%) contrast(${100 + e.contrast * 2.5}%)`;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((e.rotate * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return out;
}

function drawEditor() {
  const canvas = $('#editor-canvas');
  if (!canvas || !state.editor) return;
  const preview = renderEdited(state.editor, 900);
  canvas.width = preview.width;
  canvas.height = preview.height;
  canvas.getContext('2d').drawImage(preview, 0, 0);
}

function updateEditorFromInput(input) {
  if (!state.editor) return;
  state.editor[input.dataset.editor] = Number(input.value);
  drawEditor();
}

async function saveEditor() {
  const e = state.editor;
  if (!e) return;
  const button = $('#editor-save');
  if (button) button.disabled = true;
  try {
    const blob = await new Promise((resolve) => renderEdited(e, 2000).toBlob(resolve, 'image/jpeg', 0.92));
    state.snap.view = await api(`/api/listings/drafts/${state.snap.view.id}/photos/${e.index}`, { method: 'PUT', file: blob });
    state.photos.clear();
    closeEditor();
    toast('Photo saved.');
  } catch (err) {
    if (button) button.disabled = false;
    toast(err.message, 'bad');
  } finally {
    await render();
  }
}

function closeEditor() {
  state.editor = null;
  $('#editor')?.remove();
}

async function readTextDetails(text) {
  captureEdits();
  state.snap.busy = 'text';
  await render();
  try {
    const view = await patchDraft({ text });
    state.snap.view = view;
    state.snap.edits.details = detailsFrom(view.draft.answers);
    const source = view.parser === 'muse-spark' ? 'Muse Spark' : 'the rules reader';
    if (view.parser_error) toast(`Muse Spark could not read that, so ${source} did. Check the values.`, 'bad');
    else toast(`Read by ${source}. ${view.missing.length ? `Still needed: ${missingNames(view.missing)}.` : 'All details are in.'}`);
  } finally {
    state.snap.busy = null;
    await render();
  }
}

// ---------- Stock ----------

async function renderStock() {
  const products = await api('/api/products');
  state.stock.products = products.length;
  state.stock.rows = products.flatMap((p) => p.variants.map((v) => ({ ...v, title: p.title, master: p.master_sku, image: p.media_urls[0] ?? '' })));

  if (!products.length) {
    return `
      <header class="page-head"><h1>Stock</h1></header>
      <div class="empty card">
        <h2>No products yet</h2>
        <p>Snap a photo and the product lands here with its SKUs and stock counts.</p>
        <a class="btn btn-primary" href="#/snap">Snap a product</a>
      </div>`;
  }

  const rows = state.stock.rows;
  const filters = [['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock']]
    .map(([id, label]) => `<button type="button" class="chip" data-action="filter" data-filter="${id}" aria-pressed="${state.stock.filter === id}">${label}</button>`)
    .join('');

  return `
    <header class="page-head">
      <h1>Stock</h1>
      <p>One count per SKU. A sale on any channel lowers it, and the other channels are queued to match.</p>
    </header>
    <div class="stats">
      <div class="stat"><strong>${rows.reduce((s, r) => s + Math.max(0, r.stock_qty), 0)}</strong><span>Units in stock</span><small>across all SKUs</small></div>
      <div class="stat"><strong>${rows.filter((r) => r.stock_qty > 0 && r.stock_qty <= LOW_STOCK).length}</strong><span>Low stock</span><small>${LOW_STOCK} or fewer</small></div>
      <div class="stat"><strong>${rows.filter((r) => r.stock_qty <= 0).length}</strong><span>Out of stock</span><small>restock to sell</small></div>
      <div class="stat"><strong>${rows.length}</strong><span>SKUs</span><small>${plural(products.length, 'listing')}</small></div>
    </div>
    <div class="toolbar">
      <div class="row" role="group" aria-label="Filter stock">${filters}</div>
      <input class="input" id="stock-search" type="search" placeholder="Search SKU or product" aria-label="Search stock" value="${esc(state.stock.query)}">
    </div>
    <div class="grid-tags" id="stock-grid">${stockGridHTML()}</div>`;
}

function stockGridHTML() {
  const q = state.stock.query.trim().toLowerCase();
  const rows = state.stock.rows.filter((r) => {
    if (state.stock.filter === 'low' && !(r.stock_qty > 0 && r.stock_qty <= LOW_STOCK)) return false;
    if (state.stock.filter === 'out' && r.stock_qty > 0) return false;
    if (q && !`${r.sku} ${r.title}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!rows.length) return '<p class="muted">Nothing matches. Clear the search or pick All.</p>';

  return rows.map((r) => {
    let tone = 'ok';
    let note = '';
    if (r.stock_qty < 0) { tone = 'out'; note = `Oversold by ${-r.stock_qty}. Restock now.`; }
    else if (r.stock_qty === 0) { tone = 'out'; note = 'Out of stock. Restock to sell again.'; }
    else if (r.stock_qty <= LOW_STOCK) { tone = 'low'; note = 'Running low. Restock soon.'; }
    const sku = esc(r.sku);
    return `
      <article class="tag sku-tag" data-state="${tone}">
        ${r.image
          ? `<img class="thumb" src="${esc(r.image)}" alt="${esc(r.title)}" loading="lazy">`
          : `<div class="thumb thumb-empty" aria-hidden="true">${esc((r.title || '?').charAt(0))}</div>`}
        <div class="sku">${sku}</div>
        <div class="title">${esc(r.title)}</div>
        <div class="muted">${r.size ? `Size ${esc(r.size)}` : 'One size'} · ${inr(r.selling_price)}</div>
        <div class="level">
          <strong class="num" aria-label="${r.stock_qty} in stock">${r.stock_qty}</strong>
          <div class="row" style="gap:6px">
            <button type="button" class="btn btn-quiet btn-small" data-action="adjust" data-sku="${sku}" data-delta="-1" aria-label="Sell one of ${sku}">−1</button>
            <button type="button" class="btn btn-quiet btn-small" data-action="adjust" data-sku="${sku}" data-delta="1" aria-label="Add one to ${sku}">+1</button>
            <button type="button" class="btn btn-quiet btn-small" data-action="adjust" data-sku="${sku}" data-delta="10" aria-label="Add ten to ${sku}">+10</button>
          </div>
        </div>
        ${note ? `<p class="note">${esc(note)}</p>` : ''}
      </article>`;
  }).join('');
}

// ---------- Listings and sheets ----------

async function renderListings() {
  const products = await api('/api/products');
  const readiness = {};
  await Promise.all(PLATFORMS.map(async (p) => {
    const rows = await api(`/api/readiness/${p.id}`);
    readiness[p.id] = new Map(rows.map((r) => [r.master_sku, r.warnings]));
  }));

  if (!products.length) {
    return `
      <header class="page-head"><h1>Listings</h1></header>
      <div class="empty card">
        <h2>No listings yet</h2>
        <p>Each product you publish shows up here, checked against each marketplace.</p>
        <a class="btn btn-primary" href="#/snap">Snap a product</a>
      </div>`;
  }

  return `
    <header class="page-head">
      <h1>Listings</h1>
      <p>Each product checked against each marketplace's basics. Download a sheet once a channel shows ready.</p>
    </header>
    <section class="card stack" aria-labelledby="sheets-h">
      <h2 id="sheets-h">Download sheets</h2>
      <p class="muted">The column headers are placeholders. Match them to the bulk template in each seller panel before you upload.</p>
      <div class="row">
        ${PLATFORMS.map((p) => `<button type="button" class="btn btn-quiet" data-action="export" data-platform="${p.id}">${p.label} sheet</button>`).join('')}
      </div>
    </section>
    <div class="stack" style="margin-top:20px">
      ${products.map((p) => listingCardHTML2(p, readiness)).join('')}
    </div>`;
}

function listingCardHTML2(p, readiness) {
  const stock = p.variants.reduce((s, v) => s + Math.max(0, v.stock_qty), 0);
  const img = p.media_urls[0];
  const checks = PLATFORMS.map((pl) => {
    const warnings = readiness[pl.id].get(p.master_sku) ?? [];
    if (!warnings.length) return `<span class="pill pill-ok">${esc(pl.label)}: ready</span>`;
    return `<details><summary><span class="pill pill-warn">${esc(pl.label)}: ${plural(warnings.length, 'thing')} to fix</span></summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
  }).join('');

  return `
    <article class="card listing">
      ${img ? `<img src="${esc(img)}" alt="${esc(p.title)}" loading="lazy">` : '<div class="photo-frame" style="width:104px;height:104px"></div>'}
      <div class="stack" style="gap:6px">
        <h2 style="font-size:1.125rem">${esc(p.title)}</h2>
        <p class="muted">${esc(CATEGORY_LABEL[p.category] ?? 'General')} · ${plural(p.variants.length, 'SKU')} · ${stock} in stock</p>
        <div class="readiness">${checks}</div>
      </div>
    </article>`;
}

async function downloadCsv(platform) {
  const res = await fetch(`/api/exports/${platform}.csv`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error(`Could not export (${res.status}).`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('Nothing to export yet. Publish a product first.');
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `${platform.toLowerCase()}-listings.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${LABEL[platform]} sheet downloaded. Check its headers against the seller template.`);
}

// ---------- Orders ----------

const PLATFORM_NOTE = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.note]));

async function renderOrders() {
  const products = await api('/api/products');
  const skus = products.flatMap((p) => p.variants.map((v) => ({
    sku: v.sku,
    label: `${v.sku} · ${p.title}${v.size ? ` · ${v.size}` : ''}`,
    stock: v.stock_qty,
  })));
  state.orders.skus = skus;

  if (!skus.length) {
    return `
      <header class="page-head"><h1>Orders</h1></header>
      <div class="empty card">
        <h2>Add a product first</h2>
        <p>Orders take stock from a product, so publish one before you test an order.</p>
        <a class="btn btn-primary" href="#/snap">Snap a product</a>
      </div>`;
  }
  if (!state.orders.sku || !skus.some((s) => s.sku === state.orders.sku)) state.orders.sku = skus[0].sku;

  return `
    <header class="page-head">
      <h1>Orders</h1>
      <p>An order takes stock once, then every other channel is queued to match. Send the same order again to see it counted once.</p>
    </header>
    <div class="orders-grid">
      <section class="card stack" aria-labelledby="order-h">
        <h2 id="order-h">Simulate an order</h2>
        <fieldset style="border:0;padding:0;margin:0;display:grid;gap:8px">
          <legend style="font-weight:600;font-size:0.9375rem;margin-bottom:8px">Where did it sell?</legend>
          <div class="platform-pick">
            ${PLATFORMS.map((p) => `
              <input type="radio" name="platform" id="pl-${p.id}" value="${p.id}" ${state.orders.platform === p.id ? 'checked' : ''}>
              <label for="pl-${p.id}">${esc(p.label)}<small class="muted">${esc(p.note)}</small></label>`).join('')}
          </div>
        </fieldset>
        <label class="field"><span>Which product</span>
          <select class="select" id="order-sku">
            ${skus.map((s) => `<option value="${esc(s.sku)}" ${s.sku === state.orders.sku ? 'selected' : ''}>${esc(s.label)} (${s.stock} left)</option>`).join('')}
          </select>
        </label>
        <div class="field"><span>Quantity</span>
          <div class="stepper" style="justify-self:start">
            <button type="button" data-action="qty" data-delta="-1" aria-label="Fewer">−</button>
            <input type="number" min="1" id="order-qty" value="${state.orders.qty}" aria-label="Quantity">
            <button type="button" data-action="qty" data-delta="1" aria-label="More">+</button>
          </div>
        </div>
        <div class="row">
          <button type="button" class="btn btn-primary" data-action="order-send">Send order</button>
          ${state.orders.last ? '<button type="button" class="btn btn-quiet" data-action="order-again">Send the same order again</button>' : ''}
        </div>
      </section>
      <section class="stack" aria-labelledby="feed-h">
        <h2 id="feed-h">What happened</h2>
        <div class="feed">${feedHTML()}</div>
      </section>
    </div>`;
}

function feedHTML() {
  if (!state.orders.feed.length) return '<p class="muted">Nothing yet. Send an order to see stock move.</p>';
  return state.orders.feed.map((item) => `
    <article class="feed-item">
      <div class="row between"><strong>${esc(item.label)}</strong><small class="muted">${esc(item.time)}</small></div>
      ${item.lines.map((l) => {
        const pill = l.status === 'APPLIED' ? ['pill-ok', 'Counted']
          : l.status === 'DUPLICATE' ? ['pill-warn', 'Counted once']
          : ['pill-bad', 'Not counted'];
        return `<p><span class="pill ${pill[0]}">${pill[1]}</span> ${esc(lineText(l))}</p>`;
      }).join('')}
    </article>`).join('');
}

function lineText(l) {
  if (l.status === 'APPLIED') {
    const queued = l.pushedTo?.length ? ` Queued for ${l.pushedTo.map((p) => LABEL[p] ?? p).join(', ')}.` : '';
    return `${l.sku}: stock now ${l.qty}.${l.oversold ? ' Oversold, restock now.' : ''}${queued}`;
  }
  if (l.status === 'DUPLICATE') return `${l.sku}: this order line was already counted. Stock stays at ${l.qty}.`;
  return `${l.sku || 'Line'}: ${l.error || 'not counted'}`;
}

function buildOrder(platform, id, sku, qty) {
  if (platform === 'AMAZON_IN') return { AmazonOrderId: id, OrderItems: [{ OrderItemId: `${id}-1`, SellerSKU: sku, QuantityOrdered: qty }] };
  if (platform === 'SHOPIFY') return { id, line_items: [{ id: `${id}-1`, sku, quantity: qty }] };
  return { order_id: id, lines: [{ line_id: `${id}-1`, sku, quantity: qty }] };
}

async function sendOrder(again) {
  const o = state.orders;
  let last;
  if (again && o.last) {
    last = o.last;
  } else {
    const id = `DEMO-${Date.now().toString(36).toUpperCase()}`;
    last = { platform: o.platform, sku: o.sku, qty: o.qty, id, payload: buildOrder(o.platform, id, o.sku, o.qty) };
    o.last = last;
  }
  const res = await api(`/api/orders/${last.platform}`, { method: 'POST', body: last.payload });
  o.feed.unshift({
    label: `${LABEL[last.platform]} order ${res.orderId}${again ? ' (sent again)' : ''}`,
    time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    lines: res.lines,
  });
  const counted = res.lines.filter((l) => l.status === 'APPLIED').length;
  const once = res.lines.filter((l) => l.status === 'DUPLICATE').length;
  toast(once ? 'Already counted, so stock did not change again.' : `Order received. ${plural(counted, 'line')} counted.`);
  return render();
}

// ---------- WhatsApp simulator ----------

async function renderChat() {
  if (!state.chat.phone) {
    return `
      <header class="page-head">
        <h1>WhatsApp</h1>
        <p>Run the shop from WhatsApp. Link the number you sell from, then try the same commands the real number accepts.</p>
      </header>
      <section class="card stack" style="max-width:560px">
        <label class="field"><span>Your WhatsApp number</span>
          <input class="input" id="chat-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="for example 919812345678">
        </label>
        <div class="row"><button type="button" class="btn btn-primary" data-action="chat-link">Link this number</button></div>
        <p class="muted">Use the country code with no plus sign. Replies go to this number once the real WhatsApp credentials are set.</p>
      </section>`;
  }

  const products = await api('/api/products');
  state.chat.skus = products.flatMap((p) => p.variants.map((v) => v.sku));
  if (!state.chat.messages.length) {
    state.chat.messages.push({ from: 'bot', text: 'Hi, this is QuickListInventoryAI. Send a product photo to start a listing, or type help.' });
  }
  const first = state.chat.skus[0];
  const quick = ['help', 'low stock', ...(first ? [`stock ${first}`, `sold 1 ${first}`] : [])];

  return `
    <header class="page-head">
      <h1>WhatsApp</h1>
      <p>Test the WhatsApp flow here. Commands and photos work the way they do on the real number.</p>
    </header>
    <div class="orders-grid">
      <section class="chat" aria-label="WhatsApp conversation">
        <div class="chat-head">
          <div><strong>QuickListInventoryAI</strong><br><small>${esc(state.chat.phone)}</small></div>
          <button type="button" class="btn btn-quiet btn-small" style="color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.6)" data-action="chat-unlink">Change number</button>
        </div>
        <div class="chat-log" id="chat-log" role="log" aria-live="polite">${state.chat.messages.map(bubbleHTML).join('')}</div>
        <div class="chat-compose">
          <div class="quick">${quick.map((t) => `<button type="button" class="chip" data-action="chat-quick" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
          <form id="chat-form" class="row" style="flex-wrap:nowrap">
            <button type="button" class="btn btn-quiet btn-icon" data-action="chat-photo" aria-label="Send a photo">+</button>
            <input class="input" id="chat-text" placeholder="Type a message" aria-label="Message" autocomplete="off">
            <button type="submit" class="btn btn-indigo">Send</button>
          </form>
          <input type="file" id="chat-file" accept="image/*" hidden>
        </div>
      </section>
      <aside class="stack">
        <section class="card stack">
          <h2>Try these</h2>
          <ul class="muted" style="margin:0;padding-left:18px;display:grid;gap:6px">
            <li><code>sold 2 SKU</code> takes stock down and queues the other channels.</li>
            <li><code>restock SKU +20</code> adds stock.</li>
            <li><code>low stock</code> lists what needs restocking.</li>
            <li>Send a photo to start a listing, then reply <code>studio</code>, your details, and <code>yes</code>.</li>
          </ul>
        </section>
      </aside>
    </div>`;
}

function bubbleHTML(m) {
  return `<div class="bubble ${m.from === 'me' ? 'me' : 'bot'}">${m.image ? `<img src="${esc(m.image)}" alt="Photo you sent">` : ''}${esc(m.text)}</div>`;
}

function appendBubble(m) {
  state.chat.messages.push(m);
  const log = $('#chat-log');
  if (!log) return;
  log.insertAdjacentHTML('beforeend', bubbleHTML(m));
  log.scrollTop = log.scrollHeight;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function sendChat(text, file) {
  const t = (text || '').trim();
  if (!t && !file) return;
  appendBubble({ from: 'me', text: file ? (t || 'Sent a photo') : t, image: file ? URL.createObjectURL(file) : null });
  const body = { phone: state.chat.phone, text: t };
  if (file) {
    body.image_base64 = await readBase64(file);
    body.mime = file.type;
  }
  try {
    const res = await api('/api/whatsapp/simulate', { method: 'POST', body });
    appendBubble({ from: 'bot', text: res.reply });
  } catch (err) {
    appendBubble({ from: 'bot', text: `Could not send: ${err.message}` });
  }
}

// ---------- Settings ----------

async function renderSettings() {
  const me = await loadShop();
  const i = me.integrations || {};
  const rows = [
    ['Muse Spark photo reading', i.meta, 'Add META_API_KEY to the server environment', 'On'],
    ['Muse Image studio photos', i.meta, 'Uses the same key. Set META_IMAGE_EDIT=off to skip it', 'On'],
    ['WhatsApp messages', i.whatsapp, 'Add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID', 'On'],
    ['Public image links', i.public_base_url, 'Set PUBLIC_BASE_URL to your live address', 'On'],
  ];
  const shown = state.newToken ?? `qli_…${(state.token || '').slice(-4)}`;

  return `
    <header class="page-head">
      <h1>Settings</h1>
      <p>Your shop, your connections and your access token.</p>
    </header>
    <div class="orders-grid">
      <section class="stack">
        <div class="card stack"><h2>Your shop</h2><p class="muted">${esc(me.tenant.name)}</p></div>
        <div class="card stack">
          <h2>Access</h2>
          <p class="muted">${state.newToken ? 'Copy this new token now. It is shown only once.' : 'Your token is hidden. Create a new one to sign in on another device.'}</p>
          <div class="token-box">${esc(shown)}</div>
          <div class="row">
            ${state.newToken ? `<button type="button" class="btn btn-quiet" data-action="copy-token" data-copy="${esc(state.newToken)}">Copy token</button>` : ''}
            <button type="button" class="btn btn-quiet" data-action="new-token">Create a new token</button>
            <button type="button" class="btn btn-quiet" data-action="sign-out">Sign out on this device</button>
          </div>
        </div>
      </section>
      <section class="card stack">
        <h2>Platform services</h2>
        <p class="muted">Set these on the server. Store and marketplace connections are listed below.</p>
        <ul class="check-list">
          ${rows.map(([name, on, hint, doneText]) => `
            <li>
              <span><strong>${esc(name)}</strong><br><small class="muted">${on ? esc(doneText) : esc(hint)}</small></span>
              <span class="pill ${on ? 'pill-ok' : 'pill-idle'}">${on ? 'On' : 'Off'}</span>
            </li>`).join('')}
        </ul>
      </section>
    </div>`;
}

// ---------- Settings and connections ----------

async function renderSettingsPage() {
  const base = await renderSettings();
  return base + (await connectionsHTML());
}

async function connectionsHTML() {
  const data = await api('/api/connections');
  const cards = data.connectors.map((c) => connectorCardHTML(c, data.vault_ready)).join('');
  const demo = data.connectors.find((c) => c.platform === 'DEMO');
  let pushes = '';
  if (demo?.status === 'CONNECTED') {
    const rows = await api('/api/demo/pushes');
    pushes = `
      <section class="card stack" aria-labelledby="pushes-h">
        <h2 id="pushes-h">Demo marketplace pushes</h2>
        ${rows.length
          ? `<ul class="sku-list">${rows.map((r) => `<li><span>${esc(r.sku)}</span><span>set to ${r.qty}</span></li>`).join('')}</ul>`
          : '<p class="muted">No pushes yet. Place a demo order from the Orders page.</p>'}
      </section>`;
  }
  return `
    <section class="stack" style="margin-top:32px" aria-labelledby="conn-h">
      <div class="stack" style="gap:8px">
        <h2 id="conn-h">Stores and marketplaces</h2>
        <p class="muted">Keys are encrypted on our server, never shown again, and sent only to the platform they belong to. Paste them into this page only, never into WhatsApp or a chat.</p>
      </div>
      ${data.vault_ready ? '' : '<div class="notice notice-warn" role="status"><strong>Credential storage is off</strong><p>The server needs a MASTER_KEY before it can save keys. Set it in the host environment, then reload.</p></div>'}
      <div class="conn-grid">${cards}</div>
      ${pushes}
    </section>`;
}

function connectorCardHTML(c, vaultReady) {
  const pill = {
    CONNECTED: ['pill-ok', 'Connected'],
    ERROR: ['pill-bad', 'Needs attention'],
    NOT_CONNECTED: ['pill-idle', 'Not connected'],
  }[c.status];
  const open = state.connOpen === c.platform;
  const checked = c.tested_at ? `Checked ${new Date(c.tested_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN')}` : '';
  const primary = c.status !== 'CONNECTED';
  const openLabel = open ? 'Close' : c.status === 'NOT_CONNECTED' ? 'Connect' : 'Edit keys';
  return `
    <article class="card conn-card" aria-labelledby="c-${c.platform}">
      <div class="row between"><h3 id="c-${c.platform}">${esc(c.label)}</h3><span class="pill ${pill[0]}">${pill[1]}</span></div>
      <p class="muted">${esc(c.blurb)}</p>
      ${c.detail ? `<p class="conn-detail" role="status">${esc(c.detail)}</p>` : ''}
      ${checked ? `<small class="muted">${esc(checked)}</small>` : ''}
      <div class="row">
        <button type="button" class="btn ${primary ? 'btn-primary' : 'btn-quiet'} btn-small" data-action="conn-open" data-platform="${c.platform}" aria-expanded="${open}" ${vaultReady ? '' : 'disabled'}>${openLabel}</button>
        ${c.status !== 'NOT_CONNECTED' ? `
          <button type="button" class="btn btn-quiet btn-small" data-action="conn-test" data-platform="${c.platform}">Test again</button>
          <button type="button" class="btn btn-quiet btn-small" data-action="conn-remove" data-platform="${c.platform}">Disconnect</button>` : ''}
      </div>
      ${open ? connectorFormHTML(c) : ''}
    </article>`;
}

function connectorFormHTML(c) {
  const guide = c.guide ? `<p class="muted">${esc(c.guide)}</p>` : '';
  if (!c.fields.length) {
    return `<div class="conn-form" data-platform="${c.platform}">${guide}
      <div class="row"><button type="button" class="btn btn-primary btn-small" data-action="conn-save" data-platform="${c.platform}">Connect</button></div>
    </div>`;
  }
  const fields = c.fields.map((f) => {
    const saved = c.values[f.name];
    let hint = f.help;
    if (f.secret && saved?.saved) hint = `Saved, ends in ${saved.hint}. Leave blank to keep it.`;
    const value = f.secret ? '' : esc(saved ?? f.default ?? '');
    const secretAttrs = f.secret ? 'type="password" autocomplete="new-password" spellcheck="false"' : 'autocomplete="off"';
    return `
      <label class="field"><span>${esc(f.label)}${f.optional ? ' (optional)' : ''}</span>
        <input class="input" data-field="${f.name}" ${secretAttrs} value="${value}">
        ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}
      </label>`;
  }).join('');
  return `
    <div class="conn-form" data-platform="${c.platform}">
      ${guide}
      ${fields}
      <div class="row"><button type="button" class="btn btn-primary btn-small" data-action="conn-save" data-platform="${c.platform}">Save and test</button></div>
    </div>`;
}

// ---------- Event wiring ----------

const actions = {
  'pick-camera': () => $('#camera').click(),
  'pick-file': () => $('#file').click(),
  'snap-again': () => { state.snap = { phase: 'empty' }; return render(); },
  'photo-mode': (el) => setPhotoMode(Number(el.dataset.index), el.dataset.mode),
  'photo-edit': (el) => openEditor(Number(el.dataset.index)),
  'photo-remove': (el) => removePhotoAt(Number(el.dataset.index)),
  'photo-add': () => $('#file').click(),
  'editor-close': () => closeEditor(),
  'editor-rotate': (el) => {
    state.editor.rotate = (state.editor.rotate + Number(el.dataset.by) + 360) % 360;
    drawEditor();
  },
  'editor-crop': (el) => {
    state.editor.crop = el.dataset.crop;
    showEditor();
  },
  'editor-save': () => saveEditor(),
  'toggle-password': (el) => {
    const input = $('#auth-password');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    el.textContent = reveal ? 'Hide' : 'Show';
    el.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  },
  'toggle-size': () => {
    captureEdits();
    const d = state.snap.edits.details;
    const s = document.activeElement?.dataset?.size ?? null;
    return s ? toggleSize(d, s) : null;
  },
  'add-size': () => {
    captureEdits();
    const d = state.snap.edits.details;
    const label = $('#custom-size').value.trim().toUpperCase();
    if (label && !d.sizes.includes(label)) d.sizes.push(label);
    return render();
  },
  'add-term': () => {
    captureEdits();
    const l = state.snap.edits.listing;
    const term = $('#new-term').value.trim().toLowerCase();
    if (term && !l.search_terms.includes(term) && l.search_terms.length < 8) l.search_terms.push(term);
    return render();
  },
  'remove-term': (el) => {
    captureEdits();
    state.snap.edits.listing.search_terms.splice(Number(el.dataset.index), 1);
    return render();
  },
  'add-bullet': () => {
    captureEdits();
    const l = state.snap.edits.listing;
    if (l.bullets.length < 5) l.bullets.push('');
    return render();
  },
  'remove-bullet': (el) => {
    captureEdits();
    state.snap.edits.listing.bullets.splice(Number(el.dataset.index), 1);
    return render();
  },
  step: (el) => {
    const input = el.parentElement.querySelector('input');
    input.value = Math.max(0, (Number(input.value) || 0) + Number(el.dataset.delta));
  },
  qty: (el) => {
    const input = el.parentElement.querySelector('input');
    input.value = Math.max(1, (Number(input.value) || 1) + Number(el.dataset.delta));
    state.orders.qty = Number(input.value);
  },
  'save-listing': async () => {
    captureEdits();
    state.snap.view = await patchDraft({ fields: listingPayload(state.snap.edits.listing) });
    toast('Listing saved.');
    return render();
  },
  'save-details': async () => {
    captureEdits();
    const e = state.snap.edits;
    state.snap.view = await patchDraft({ answers: detailsPayload(e.details, e.listing.category) });
    const v = state.snap.view;
    toast(v.missing.length ? `Saved. Still needed: ${missingNames(v.missing)}.` : 'Details saved. Ready to publish.', v.missing.length ? 'bad' : 'ok');
    return render();
  },
  'read-text': () => {
    const text = $('#quick-text').value.trim();
    if (!text) return toast('Type a line first, for example: sizes 7 to 10, 15 each, MRP 1499, sell 799', 'bad');
    return readTextDetails(text);
  },
  publish: async () => {
    captureEdits();
    const e = state.snap.edits;
    state.snap.busy = 'publish';
    await render();
    try {
      const saved = await patchDraft({ fields: listingPayload(e.listing), answers: detailsPayload(e.details, e.listing.category) });
      state.snap.view = saved;
      if (saved.missing.length) return toast(`Still needed: ${missingNames(saved.missing)}.`, 'bad');
      const product = await api(`/api/listings/drafts/${saved.id}/publish`, { method: 'POST' });
      state.snap = { phase: 'published', product };
      toast(`Listed as ${product.master_sku}. Stock is live.`);
    } finally {
      state.snap.busy = null;
      await render();
    }
  },
  filter: (el) => {
    state.stock.filter = el.dataset.filter;
    return render();
  },
  adjust: async (el) => {
    const sku = el.dataset.sku;
    const r = await api(`/api/stock/${encodeURIComponent(sku)}/adjust`, {
      method: 'POST',
      body: { delta: Number(el.dataset.delta), reason: 'DASHBOARD' },
    });
    const queued = r.pushedTo.length ? ` Queued for ${r.pushedTo.map((p) => LABEL[p] ?? p).join(', ')}.` : '';
    toast(`${sku}: ${r.qty} in stock.${queued}${r.oversold ? ' Oversold, restock now.' : ''}`, r.oversold ? 'bad' : 'ok');
    return render();
  },
  export: (el) => downloadCsv(el.dataset.platform),
  'order-send': () => sendOrder(false),
  'order-again': () => sendOrder(true),
  'chat-link': async () => {
    const phone = $('#chat-phone').value.replace(/\D/g, '');
    if (phone.length < 10) throw new Error('Enter the full number with the country code.');
    await api('/api/whatsapp/link', { method: 'POST', body: { phone } });
    state.chat.phone = phone;
    store.set(PHONE_KEY, phone);
    state.chat.messages = [];
    return render();
  },
  'chat-unlink': () => {
    store.del(PHONE_KEY);
    state.chat.phone = '';
    state.chat.messages = [];
    return render();
  },
  'chat-quick': (el) => sendChat(el.dataset.text),
  'chat-photo': () => $('#chat-file').click(),
  'copy-token': (el) => copy(el.dataset.copy),
  'new-token': async () => {
    const r = await api('/api/tokens', { method: 'POST', body: { label: 'second device' } });
    state.newToken = r.token;
    toast('New token created. Copy it now, because it is shown once.');
    return render();
  },
  'sign-out': async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    store.del(PHONE_KEY);
    setToken(null);
    Object.assign(state, { shop: null, newToken: null, snap: { phase: 'empty' } });
    location.hash = '#/snap';
    renderOnboard('start');
  },
  'conn-open': (el) => {
    state.connOpen = state.connOpen === el.dataset.platform ? null : el.dataset.platform;
    return render();
  },
  'conn-save': async (el) => {
    const platform = el.dataset.platform;
    const fields = {};
    document.querySelectorAll(`.conn-form[data-platform="${platform}"] [data-field]`).forEach((input) => {
      fields[input.dataset.field] = input.value;
    });
    toast('Checking with the platform…');
    const c = await api(`/api/connections/${platform}`, { method: 'PUT', body: { fields } });
    const ok = c.status === 'CONNECTED';
    state.connOpen = ok ? null : platform;
    toast(ok ? `${c.label} connected.` : c.detail, ok ? 'ok' : 'bad');
    return render();
  },
  'conn-test': async (el) => {
    const c = await api(`/api/connections/${el.dataset.platform}/test`, { method: 'POST' });
    toast(c.detail, c.status === 'CONNECTED' ? 'ok' : 'bad');
    return render();
  },
  'conn-remove': async (el) => {
    await api(`/api/connections/${el.dataset.platform}`, { method: 'DELETE' });
    state.connOpen = null;
    toast('Disconnected. Its keys are deleted from our server.');
    return render();
  },
  'auth-tab': (el) => {
    state.authTab = el.dataset.tab;
    return renderOnboard('start');
  },
  'auth-signup': async () => {
    const res = await api('/api/auth/signup', {
      method: 'POST',
      body: { shop_name: $('#auth-shop').value, email: $('#auth-email').value, password: $('#auth-password').value },
      auth: false,
    });
    setToken(res.token);
    toast(`Welcome, ${res.tenant.name}. Your shop is ready.`);
    return enterApp();
  },
  'auth-login': async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#auth-email').value, password: $('#auth-password').value },
      auth: false,
    });
    setToken(res.token);
    return enterApp();
  },
  'onboard-demo': () => seedDemoShop(),
  'onboard-continue': () => enterApp(),
  'onboard-paste': () => renderOnboard('paste'),
  'onboard-back': () => renderOnboard('start'),
  'onboard-use-token': async () => {
    const token = $('#onboard-token').value.trim();
    if (!token) throw new Error('Paste your token first.');
    setToken(token);
    try {
      await loadShop();
    } catch {
      setToken(null);
      throw new Error('That token did not work. Check it and try again.');
    }
    return enterApp();
  },
};

function toggleSize(d, size) {
  d.sizes = d.sizes.includes(size) ? d.sizes.filter((x) => x !== size) : [...d.sizes, size];
  return render();
}

function run(name, el) {
  Promise.resolve()
    .then(() => actions[name](el))
    .catch((err) => toast(err.message, 'bad'));
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const name = el.dataset.action;
  if (name === 'toggle-size') {
    captureEdits();
    const d = state.snap.edits.details;
    const size = el.dataset.size;
    d.sizes = d.sizes.includes(size) ? d.sizes.filter((x) => x !== size) : [...d.sizes, size];
    render();
    return;
  }
  run(name, el);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('.conn-form [data-field]')) {
    e.preventDefault();
    run('conn-save', e.target.closest('.conn-form').querySelector('[data-action="conn-save"]'));
    return;
  }
  const map = {
    'new-term': 'add-term',
    'custom-size': 'add-size',
    'quick-text': 'read-text',
    'onboard-token': 'onboard-use-token',
  };
  if (e.target.id === 'auth-password') {
    e.preventDefault();
    run(state.authTab === 'login' ? 'auth-login' : 'auth-signup', e.target);
    return;
  }
  const name = map[e.target.id];
  if (!name) return;
  e.preventDefault();
  run(name, e.target);
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chat-form') return;
  e.preventDefault();
  const input = $('#chat-text');
  const text = input.value;
  input.value = '';
  sendChat(text);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'file' || t.id === 'camera') {
    const files = [...(t.files ?? [])];
    t.value = '';
    if (!files.length) return;
    if (state.snap.phase === 'review') addPhotos(files);
    else startAnalysis(files);
  } else if (t.id === 'chat-file') {
    const f = t.files?.[0];
    t.value = '';
    if (f) sendChat('', f);
  } else if (t.matches('[data-listing="category"]')) {
    captureEdits();
    state.snap.edits.listing.category = t.value;
    render();
  } else if (t.name === 'platform') {
    state.orders.platform = t.value;
  } else if (t.id === 'order-sku') {
    state.orders.sku = t.value;
  } else if (t.id === 'order-qty') {
    state.orders.qty = Math.max(1, Number(t.value) || 1);
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('[data-editor]')) {
    updateEditorFromInput(t);
  } else if (t.matches('[data-price]')) {
    updateDiscount();
  } else if (t.id === 'stock-search') {
    state.stock.query = t.value;
    const grid = $('#stock-grid');
    if (grid) grid.innerHTML = stockGridHTML();
  }
});

document.addEventListener('dragover', (e) => {
  const zone = e.target.closest?.('.dropzone');
  if (zone) {
    e.preventDefault();
    zone.classList.add('is-over');
  }
});
document.addEventListener('dragleave', (e) => {
  e.target.closest?.('.dropzone')?.classList.remove('is-over');
});
document.addEventListener('drop', (e) => {
  const zone = e.target.closest?.('.dropzone');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('is-over');
  const files = e.dataTransfer?.files;
  if (files?.length) startAnalysis(files);
});

window.addEventListener('hashchange', () => render());

async function boot() {
  if (!state.token) return renderOnboard();
  try {
    await loadShop();
  } catch (err) {
    if (err.status === 401) {
      setToken(null);
      return renderOnboard();
    }
    toast('Could not reach the server. Check your connection and reload.', 'bad');
  }
  if (!location.hash) location.hash = '#/snap';
  return render();
}

boot();
