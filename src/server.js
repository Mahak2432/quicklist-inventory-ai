import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { makeAdapters } from './channels.js';
import { CONNECTORS } from './connectors.js';
import { listConnections, listDemoPushes, listOnShopify, removeConnection, retestConnection, saveConnection } from './connections.js';
import { vaultReady } from './vault.js';
import { bearerFrom, createAccount, createTenant, getTenant, issueToken, login, revokeToken, tenantForToken } from './auth.js';
import {
  adjustStock,
  drainOutbox,
  getStock,
  InventoryError,
  listLowStock,
  listProducts,
  mapChannel,
  upsertProduct,
} from './inventory.js';
import { createDraft, getDraft, mediaName, publicMedia, publishDraft, updateDraft } from './listing.js';
import { buildCsv, exportWarnings, PLATFORMS } from './marketplaces.js';
import { handleMcpRequest } from './mcp.js';
import { analyzePhoto, metaEnabled } from './meta.js';
import { describeOrder, ORDER_PLATFORMS, processOrder } from './orders.js';
import { ALLOWED_IMAGE_TYPES, readImage, storeImage, verifyMedia } from './uploads.js';
import { handleIncoming, linkPhone, normalizePhone, parseIncoming, sendText, signatureValid, verifyChallenge } from './whatsapp.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const STATUS_FOR_CODE = {
  NOT_FOUND: 404,
  DUPLICATE: 409,
  INSUFFICIENT_STOCK: 409,
  CONFLICT: 409,
  NEEDS_INFO: 422,
  VAULT_OFF: 503,
  EMAIL_TAKEN: 409,
  BAD_LOGIN: 401,
  BAD_INPUT: 400,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp(db) {
  return createServer(async (req, res) => {
    try {
      await route(db, req, res);
    } catch (err) {
      sendError(res, err);
    }
  });
}

async function route(db, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') {
    return json(res, 200, { ok: true, meta_enabled: metaEnabled() });
  }
  if (pathname === '/webhooks/whatsapp') return whatsappWebhook(db, req, res, url);
  const publicImage = pathname.match(/^\/m\/([\w-]+)\/(original|studio)$/);
  if (req.method === 'GET' && publicImage) return publicImageRoute(db, res, publicImage[1], publicImage[2], url);
  if (req.method === 'POST' && pathname === '/api/auth/signup') return accountSignup(db, req, res);
  if (req.method === 'POST' && pathname === '/api/auth/login') return accountLogin(db, req, res);
  if (req.method === 'POST' && pathname === '/api/tenants') return signup(db, req, res);

  if (req.method === 'GET' && !pathname.startsWith('/api') && !pathname.startsWith('/mcp')) {
    return serveStatic(res, pathname);
  }

  const tenantId = tenantForToken(db, bearerFrom(req));
  if (!tenantId) return json(res, 401, { error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' });

  if (pathname === '/mcp') {
    if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return handleMcpRequest(db, tenantId, req, res, await readJson(req));
  }
  return apiRoute(db, tenantId, req, res, url);
}

async function apiRoute(db, tenantId, req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/me') {
    return json(res, 200, {
      tenant: getTenant(db, tenantId),
      meta_enabled: metaEnabled(),
      platforms: PLATFORMS,
      integrations: {
        meta: metaEnabled(),
        whatsapp: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
        public_base_url: Boolean(PUBLIC_BASE_URL),
        vault: vaultReady(),
      },
    });
  }
  if (method === 'POST' && pathname === '/api/whatsapp/simulate') {
    const b = await readJson(req);
    const phone = normalizePhone(b.phone);
    const link = db.prepare('SELECT tenant_id FROM phone_links WHERE phone = ?').get(phone);
    if (!link || link.tenant_id !== tenantId) throw new HttpError(403, 'That number is not linked to this shop');
    const hasImage = Boolean(b.image_base64);
    if (hasImage && !ALLOWED_IMAGE_TYPES.includes(b.mime)) throw new HttpError(415, 'Send a JPEG, PNG or WebP photo');
    const text = String(b.text ?? '');
    const msg = {
      id: `sim-${randomUUID()}`,
      from: phone,
      type: hasImage ? 'image' : 'text',
      text,
      caption: text,
      mediaId: null,
      media: hasImage ? { buffer: Buffer.from(b.image_base64, 'base64'), mime: b.mime } : null,
    };
    return json(res, 200, { reply: await handleIncoming(db, msg) });
  }

  if (method === 'GET' && pathname === '/api/connections') {
    return json(res, 200, { vault_ready: vaultReady(), connectors: listConnections(db, tenantId) });
  }
  const connection = pathname.match(/^\/api\/connections\/([A-Z_]+)(\/test)?$/);
  if (connection) {
    const [, platform, testPath] = connection;
    if (!CONNECTORS[platform]) throw new HttpError(404, `Unknown connector ${platform}`);
    if (method === 'PUT' && !testPath) {
      const body = await readJson(req);
      return json(res, 200, await saveConnection(db, tenantId, platform, body.fields ?? {}));
    }
    if (method === 'POST' && testPath) return json(res, 200, await retestConnection(db, tenantId, platform));
    if (method === 'DELETE' && !testPath) {
      removeConnection(db, tenantId, platform);
      return json(res, 200, { removed: true });
    }
  }
  if (method === 'GET' && pathname === '/api/demo/pushes') return json(res, 200, listDemoPushes(db, tenantId));

  if (method === 'POST' && pathname === '/api/auth/logout') {
    revokeToken(db, bearerFrom(req));
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/tokens') {
    const body = await readJson(req);
    return json(res, 201, issueToken(db, tenantId, String(body.label ?? 'api').slice(0, 60)));
  }
  if (method === 'POST' && pathname === '/api/whatsapp/link') {
    return json(res, 200, linkPhone(db, tenantId, (await readJson(req)).phone));
  }

  if (method === 'POST' && pathname === '/api/listings/drafts') {
    return createDraftRoute(db, tenantId, req, res, searchParams.get('hint') ?? '');
  }
  const draft = pathname.match(/^\/api\/listings\/drafts\/([\w-]+)(\/publish)?$/);
  if (draft) {
    const [, id, publish] = draft;
    if (method === 'GET' && !publish) return json(res, 200, getDraft(db, tenantId, id));
    if (method === 'PATCH' && !publish) return json(res, 200, await updateDraft(db, tenantId, id, await readJson(req)));
    if (method === 'POST' && publish) {
      const product = publishDraft(db, tenantId, id);
      return json(res, 201, { ...product, shopify: await listOnShopify(db, tenantId, product) });
    }
  }
  const media = pathname.match(/^\/api\/media\/([\w-]+)$/);
  if (method === 'GET' && media) {
    const img = readImage(mediaName(db, tenantId, media[1], searchParams.get('variant') ?? 'auto'));
    if (!img) throw new HttpError(404, 'No image for this draft');
    return raw(res, 200, img.buffer, img.mime);
  }

  if (method === 'GET' && pathname === '/api/products') return json(res, 200, listProducts(db, tenantId));
  if (method === 'POST' && pathname === '/api/products') {
    const body = await readJson(req);
    if (!body.master_sku || !body.title) throw new HttpError(400, 'master_sku and title are required');
    return json(res, 201, upsertProduct(db, tenantId, body));
  }

  const stock = pathname.match(/^\/api\/stock\/([^/]+)$/);
  if (method === 'GET' && stock) return json(res, 200, getStock(db, tenantId, decodeURIComponent(stock[1])));
  const adjust = pathname.match(/^\/api\/stock\/([^/]+)\/adjust$/);
  if (method === 'POST' && adjust) {
    const body = await readJson(req);
    if (!Number.isInteger(body.delta)) throw new HttpError(400, 'delta must be a whole number');
    const sku = decodeURIComponent(adjust[1]);
    return json(res, 200, adjustStock(db, tenantId, sku, body.delta, { reason: body.reason ?? 'DASHBOARD', source: 'DASHBOARD' }));
  }
  if (method === 'GET' && pathname === '/api/low-stock') {
    return json(res, 200, listLowStock(db, tenantId, Number(searchParams.get('threshold') ?? 5)));
  }
  if (method === 'POST' && pathname === '/api/channels') {
    const b = await readJson(req);
    return json(res, 201, mapChannel(db, tenantId, b.sku, b.platform, b.platform_listing_id));
  }

  const order = pathname.match(/^\/api\/orders\/([A-Z_]+)$/);
  if (method === 'POST' && order) {
    const platform = order[1];
    if (!ORDER_PLATFORMS.includes(platform)) throw new HttpError(400, `Unknown platform ${platform}`);
    const result = processOrder(db, tenantId, platform, await readJson(req));
    return json(res, 200, { ...result, message: describeOrder(result) });
  }

  if (method === 'POST' && pathname === '/api/outbox/drain') {
    return json(res, 200, await drainOutbox(db, tenantId, makeAdapters(db)));
  }

  const csv = pathname.match(/^\/api\/exports\/([A-Z_]+)\.csv$/);
  if (method === 'GET' && csv) {
    const platform = csv[1];
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, `Unknown platform ${platform}`);
    const body = buildCsv(platform, listProducts(db, tenantId), PUBLIC_BASE_URL);
    return raw(res, 200, body, 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="${platform.toLowerCase()}-listings.csv"`,
    });
  }
  const readiness = pathname.match(/^\/api\/readiness\/([A-Z_]+)$/);
  if (method === 'GET' && readiness) {
    const platform = readiness[1];
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, `Unknown platform ${platform}`);
    const products = listProducts(db, tenantId).map((p) => ({ master_sku: p.master_sku, warnings: exportWarnings(p, platform) }));
    return json(res, 200, products);
  }

  throw new HttpError(404, `No route for ${method} ${pathname}`);
}

// Caps how many shops one address can open per hour, so the open signup
// endpoint can't be used to flood the database. Uses the last address in
// X-Forwarded-For, which the proxy appends, so clients can't spoof it.
const signupHits = new Map();
function signupAllowed(req) {
  const limit = Number(process.env.SIGNUP_PER_HOUR || 30);
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (signupHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limit) {
    signupHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  signupHits.set(ip, recent);
  return true;
}

// Separate buckets for sign-up and log-in, so repeated failed log-ins can't block new shops.
const rateBuckets = { signup: new Map(), login: new Map() };
function rateAllowed(bucket, req, limit) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim();
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const hits = rateBuckets[bucket];
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limit) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

async function accountSignup(db, req, res) {
  if (!rateAllowed('signup', req, Number(process.env.SIGNUP_PER_HOUR || 30))) {
    throw new HttpError(429, 'Too many sign-ups from this address. Try again later.');
  }
  return json(res, 201, await createAccount(db, await readJson(req)));
}

async function accountLogin(db, req, res) {
  if (!rateAllowed('login', req, Number(process.env.LOGIN_PER_HOUR || 60))) {
    throw new HttpError(429, 'Too many sign-in attempts from this address. Try again later.');
  }
  return json(res, 200, await login(db, await readJson(req)));
}

async function signup(db, req, res) {
  if (!signupAllowed(req)) throw new HttpError(429, 'Too many shops from this address. Try again later.');
  const body = await readJson(req);
  const name = String(body.name ?? '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, 'name is required');
  return json(res, 201, createTenant(db, name));
}

async function createDraftRoute(db, tenantId, req, res, hint) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!ALLOWED_IMAGE_TYPES.includes(type)) {
    throw new HttpError(415, `Send a JPEG, PNG or WebP photo (got ${type || 'no content type'})`);
  }
  const buffer = await readBody(req, MAX_IMAGE_BYTES);
  if (!buffer.length) throw new HttpError(400, 'Photo is empty');

  // A failed vision call should not lose the photo. The seller can still
  // enter the details by hand.
  let analysis;
  let analysisError = null;
  try {
    analysis = await analyzePhoto({ buffer, mime: type }, hint);
  } catch (err) {
    analysisError = err.message;
    analysis = { title: hint || 'Untitled product', category: 'GENERIC' };
  }
  const view = createDraft(db, tenantId, analysis, storeImage(buffer, type));
  return json(res, 201, { ...view, analysis_error: analysisError });
}

async function whatsappWebhook(db, req, res, url) {
  if (req.method === 'GET') {
    const challenge = verifyChallenge(url.searchParams);
    if (challenge) return raw(res, 200, challenge, 'text/plain');
    return json(res, 403, { error: 'FORBIDDEN' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  const rawBody = await readBody(req, MAX_JSON_BYTES);
  if (!signatureValid(rawBody, req.headers['x-hub-signature-256'])) {
    return json(res, 401, { error: 'BAD_SIGNATURE' });
  }

  // Acknowledge first. Meta retries any webhook that takes too long, and
  // vision calls can be slow.
  json(res, 200, { received: true });
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return;
  }
  for (const msg of parseIncoming(payload)) {
    processWhatsApp(db, msg).catch((err) => console.error('[whatsapp]', err));
  }
}

async function processWhatsApp(db, msg) {
  const reply = await handleIncoming(db, msg).catch((err) => `Sorry, something went wrong: ${err.message}`);
  await sendText(msg.from, reply);
}

// Public image link for marketplace exports. The HMAC stops anyone from
// guessing links to other sellers' photos.
function publicImageRoute(db, res, id, variant, url) {
  if (!verifyMedia(id, variant, url.searchParams.get('sig'))) throw new HttpError(403, 'Bad or missing signature');
  const img = readImage(publicMedia(db, id, variant));
  if (!img) throw new HttpError(404, 'No image for this draft');
  return raw(res, 200, img.buffer, img.mime, { 'Cache-Control': 'public, max-age=86400' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  return raw(res, 200, readFileSync(file), CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function json(res, status, body) {
  raw(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function raw(res, status, body, contentType, extra = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extra });
  res.end(body);
}

function sendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) return json(res, err.status, { error: 'HTTP', message: err.message });
  if (err instanceof InventoryError) {
    return json(res, STATUS_FOR_CODE[err.code] ?? 400, { error: err.code, message: err.message });
  }
  console.error(err);
  return json(res, 500, { error: 'INTERNAL', message: err.message });
}

// Background worker: flushes pending marketplace stock pushes every minute.
export function startOutboxWorker(db, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    const tenants = db.prepare("SELECT DISTINCT tenant_id FROM outbox WHERE status = 'PENDING'").all();
    for (const { tenant_id } of tenants) {
      await drainOutbox(db, tenant_id, makeAdapters(db)).catch((err) => console.error('[outbox]', err));
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = openDb();
  const port = Number(process.env.PORT || 3000);
  createApp(db).listen(port, () => {
    startOutboxWorker(db);
    console.log(`QuickListInventoryAI running on http://localhost:${port}`);
    console.log(metaEnabled() ? 'Meta API: enabled' : 'Meta API: not configured, using mock photo analysis');
  });
}
