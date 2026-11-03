import { createHmac, timingSafeEqual } from 'node:crypto';
import { adjustStock, getStock, InventoryError, listLowStock } from './inventory.js';
import { analyzePhoto } from './meta.js';
import { createDraft, getDraft, publishDraft, updateDraft } from './listing.js';
import { listOnShopify } from './connections.js';
import { storeImage } from './uploads.js';

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`;

const HELP = [
  'Commands:',
  '• Send a product photo to start a listing',
  '• studio or original: choose the photo version to publish',
  '• YES: publish the draft once it is complete',
  '• sold 3 SHOE-NAV-3F2A-7 (or sold SKU 3)',
  '• restock SKU +20',
  '• stock SKU',
  '• low stock',
  'Voice notes are not supported yet. Type your answers instead.',
].join('\n');

export function verifyChallenge(query) {
  if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN) {
    return query.get('hub.challenge');
  }
  return null;
}

// Meta signs every webhook body with the app secret. Checking it stops anyone
// who finds the URL from faking sales.
export function signatureValid(rawBody, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const received = Buffer.from(String(header));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function parseIncoming(payload) {
  const out = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        out.push({
          id: m.id,
          from: normalizePhone(m.from),
          type: m.type,
          text: m.text?.body ?? '',
          mediaId: m.image?.id ?? null,
          caption: m.image?.caption ?? '',
        });
      }
    }
  }
  return out;
}

export function normalizePhone(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

export async function linkPhone(db, tenantId, phone) {
  const p = normalizePhone(phone);
  if (!p) throw new InventoryError('BAD_PHONE', 'Phone number is required');
  await db.prepare(`INSERT INTO phone_links (phone, tenant_id) VALUES (?, ?)
              ON CONFLICT(phone) DO UPDATE SET tenant_id = excluded.tenant_id, pending_draft_id = NULL`).run(p, tenantId);
  return { phone: p, tenant_id: tenantId };
}

export async function handleIncoming(db, msg) {
  const link = await db.prepare('SELECT tenant_id, pending_draft_id FROM phone_links WHERE phone = ?').get(msg.from);
  if (!link) return 'This number is not linked to a seller account. Ask the account owner to link it in the app.';
  const tenantId = link.tenant_id;

  if (msg.type === 'image') return startDraftFromPhoto(db, msg, tenantId);
  if (msg.type !== 'text') return 'Only text and photos work on WhatsApp for now. Please type your answer.';

  const t = msg.text.trim();
  if (/^help$/i.test(t)) return HELP;
  if (/^low stock$/i.test(t)) return lowStockText(db, tenantId);

  const stock = t.match(/^stock\s+(\S+)$/i);
  if (stock) return stockText(db, tenantId, stock[1].toUpperCase());

  const sale = matchQtySku(t, /^(sold|sell)\s+/i);
  if (sale) return adjustText(db, tenantId, msg, sale.sku, -sale.qty, 'WHATSAPP_SALE');

  const restock = matchQtySku(t, /^(restock|add)\s+/i);
  if (restock) return adjustText(db, tenantId, msg, restock.sku, restock.qty, 'WHATSAPP_RESTOCK');

  if (link.pending_draft_id) return draftReply(db, tenantId, link, msg, t);
  return HELP;
}

// "sold 3 SKU" or "sold SKU 3". A leading + is allowed on restock amounts.
export function matchQtySku(text, verbRe) {
  if (!verbRe.test(text)) return null;
  const rest = text.replace(verbRe, '').trim();
  let m = rest.match(/^\+?(\d+)\s+(\S+)$/);
  if (m) return { qty: Number(m[1]), sku: m[2].toUpperCase() };
  m = rest.match(/^(\S+)\s+\+?(\d+)$/);
  if (m) return { qty: Number(m[2]), sku: m[1].toUpperCase() };
  return null;
}

async function adjustText(db, tenantId, msg, sku, delta, reason) {
  try {
    // The WhatsApp message id is the idempotency key, so Meta's webhook retries
    // cannot apply the same sale twice.
    const r = await adjustStock(db, tenantId, sku, delta, {
      reason,
      source: 'WHATSAPP',
      externalRef: msg.id,
    });
    if (r.duplicate) return `${sku}: already applied. Stock is ${r.qty}.`;
    const sync = r.pushedTo.length ? ` Synced to ${r.pushedTo.join(', ')}.` : '';
    const low = r.qty <= 5 ? ' Running low, reply "restock ' + sku + ' +N".' : '';
    return `${sku}: stock now ${r.qty}.${sync}${low}`;
  } catch (err) {
    if (err instanceof InventoryError) return `Could not update ${sku}: ${err.message}`;
    throw err;
  }
}

async function stockText(db, tenantId, sku) {
  try {
    const s = await getStock(db, tenantId, sku);
    return `${s.sku} (${s.title}): ${s.stock_qty} in stock, ₹${s.selling_price ?? '-'}`;
  } catch (err) {
    if (err instanceof InventoryError) return `No SKU ${sku}.`;
    throw err;
  }
}

async function lowStockText(db, tenantId) {
  const rows = await listLowStock(db, tenantId, 5);
  if (!rows.length) return 'Nothing is low right now.';
  return 'Low stock (5 or fewer):\n' + rows.map((r) => `• ${r.sku}: ${r.stock_qty}`).join('\n');
}

async function startDraftFromPhoto(db, msg, tenantId) {
  const media = msg.media ?? (await downloadMedia(msg.mediaId));
  const analysis = await analyzePhoto(media, msg.caption);
  const imagePath = storeImage(media.buffer, media.mime);
  const view = await createDraft(db, tenantId, analysis, imagePath);
  await db.prepare('UPDATE phone_links SET pending_draft_id = ? WHERE phone = ?').run(view.id, msg.from);
  const head = `Detected: ${view.draft.title} (${view.draft.category}).`;
  const photo = 'Photo: reply "studio" for a white-background version, or "original" to keep yours.';
  return view.question ? `${head}\n${view.question}\n${photo}` : `${head}\n${summary(view.draft)}\n${photo}`;
}

async function draftReply(db, tenantId, link, msg, text) {
  if (/^cancel$/i.test(text)) {
    await db.prepare('UPDATE phone_links SET pending_draft_id = NULL WHERE phone = ?').run(msg.from);
    return 'Draft cancelled.';
  }
  const current = await getDraft(db, tenantId, link.pending_draft_id);

  if (/^(studio|original)$/i.test(text)) {
    const view = await updateDraft(db, tenantId, link.pending_draft_id, { image_mode: text.toUpperCase() });
    const next = view.question ?? `${summary(view.draft)}\nReply YES to publish, or send corrections.`;
    return `Photo set to ${text.toLowerCase()}.\n${next}`;
  }

  if (/^yes$/i.test(text) && !current.question) {
    const product = await publishDraft(db, tenantId, link.pending_draft_id);
    await db.prepare('UPDATE phone_links SET pending_draft_id = NULL WHERE phone = ?').run(msg.from);
    const shopify = await listOnShopify(db, tenantId, product);
    const shopifyNote = shopify ? ` ${shopify.detail}` : '';
    return `Listed as ${product.master_sku} with ${product.variants.length} SKU(s). Stock is live.${shopifyNote}`;
  }

  const view = await updateDraft(db, tenantId, link.pending_draft_id, { text });
  if (view.question) return view.question;
  return `${summary(view.draft)}\nReply YES to publish, or send corrections.`;
}

function summary(draft) {
  const a = draft.answers;
  const sizes = a.sizes?.length ? `Sizes: ${a.sizes.join(', ')}. ` : '';
  const stock = a.stock_per_size
    ? `Stock per size: ${Object.values(a.stock_per_size)[0]}. `
    : `Stock: ${a.stock_total}. `;
  return `${draft.title}. ${sizes}${stock}MRP ₹${a.mrp}, selling ₹${a.selling_price}.`;
}

async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WHATSAPP_TOKEN is not set, so photos cannot be downloaded');
  const auth = { Authorization: `Bearer ${token}` };
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json();
  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`WhatsApp media download failed: ${fileRes.status}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), mime: meta.mime_type };
}

export async function sendText(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log(`[whatsapp dry-run] to ${to}: ${body}`);
    return { sent: false, reason: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set' };
  }
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  return { sent: res.ok, status: res.status };
}
