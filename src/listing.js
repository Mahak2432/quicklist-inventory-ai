import { randomBytes, randomUUID } from 'node:crypto';
import { createProduct, InventoryError } from './inventory.js';
import { CATEGORIES } from './marketplaces.js';
import { metaEnabled, parseAnswer } from './meta.js';
import { makeStudioImage } from './studio.js';
import { readImage, signMedia, storeImage } from './uploads.js';

const QUESTIONS = {
  sizes: 'Which sizes do you have? (e.g. S, M, L, XL or UK 7 to 10)',
  stock: 'How many units of each size? (e.g. 10 each. For items with no sizes, send one total)',
  mrp: 'What is the MRP in ₹? (e.g. 1499)',
  selling_price: 'What is your selling price in ₹? (e.g. 799)',
};

export function normalizeCategory(raw = '', title = '') {
  if (CATEGORIES[raw]) return raw;
  const text = `${raw} ${title}`.toLowerCase();
  if (/shoe|sneaker|sandal|footwear|boot|slipper/.test(text)) return 'FOOTWEAR';
  if (/kurt|shirt|\btee\b|hoodie|dress|saree|jean|\btop\b|apparel|jacket/.test(text)) return 'APPAREL';
  return 'GENERIC';
}

// The vision model writes the listing content (title, bullets, description,
// search terms, HSN). The seller only supplies what a photo cannot show:
// sizes, stock, and prices. Every AI field is a suggestion they can edit.
export function normalizeAnalysis(a) {
  return {
    title: String(a.title || 'Untitled product').slice(0, 150),
    category: normalizeCategory(a.category, a.title),
    color: a.color || '',
    material: a.material || '',
    brand: a.brand ? String(a.brand).trim().slice(0, 60) : '',
    pattern: a.pattern || '',
    gender: a.gender || '',
    fit: a.fit || '',
    style: a.style || '',
    description: String(a.description || '').slice(0, 2000),
    search_terms: Array.isArray(a.search_terms) ? a.search_terms.slice(0, 8).map(String) : [],
    bullets: Array.isArray(a.bullets) ? a.bullets.slice(0, 5).map((b) => String(b).slice(0, 200)) : [],
    hsn_code: a.hsn_code_suggestion ? String(a.hsn_code_suggestion).trim() : null,
    gst_percent: null,
    confidence: Number(a.confidence) || 0,
    mock: Boolean(a.mock),
    images: { mode: 'ORIGINAL', studio: null, studio_method: null },
    answers: {},
  };
}

export function missingSlots(draft) {
  const cat = CATEGORIES[draft.category] ?? CATEGORIES.GENERIC;
  const a = draft.answers ?? {};
  const missing = [];
  if (cat.needsSizes && !a.sizes?.length) missing.push('sizes');
  const stockKnown = cat.needsSizes
    ? Boolean(a.sizes?.length) && a.sizes.every((s) => a.stock_per_size?.[s] != null)
    : a.stock_total != null;
  if (!stockKnown) missing.push('stock');
  if (a.mrp == null) missing.push('mrp');
  if (a.selling_price == null) missing.push('selling_price');
  return missing;
}

export function questionFor(missing) {
  if (!missing.length) return null;
  return 'Got it. Please reply with:\n' + missing.map((m, i) => `${i + 1}. ${QUESTIONS[m]}`).join('\n');
}

const normalizeSize = (s) => String(s).trim().replace(/\s+/g, ' ').toUpperCase();

export function mergeAnswers(current, parsed, category) {
  const cat = CATEGORIES[category] ?? CATEGORIES.GENERIC;
  const next = { ...current };
  const sizes = (parsed.sizes ?? []).map(normalizeSize).filter(Boolean);
  if (sizes.length) next.sizes = [...new Set(sizes)];

  if (parsed.stock_each != null) {
    if (cat.needsSizes && next.sizes?.length) {
      next.stock_per_size = Object.fromEntries(next.sizes.map((s) => [s, Number(parsed.stock_each)]));
    } else {
      next.stock_total = Number(parsed.stock_each);
    }
  }
  if (parsed.stock_total != null) next.stock_total = Number(parsed.stock_total);
  if (parsed.stock_per_size && typeof parsed.stock_per_size === 'object') {
    next.stock_per_size = Object.fromEntries(
      Object.entries(parsed.stock_per_size)
        .filter(([, n]) => n !== null && n !== undefined && n !== '')
        .map(([size, n]) => [normalizeSize(size), Math.max(0, Math.trunc(Number(n)))]),
    );
  }
  if (parsed.mrp != null) next.mrp = Number(parsed.mrp);
  if (parsed.selling_price != null) next.selling_price = Number(parsed.selling_price);
  return next;
}

// Rule-based fallback for when no Meta key is set. Handles the common
// phrasings: "size 7 se 10", "S, M, L", "har size ke 15", "MRP 1499", "799 mein bechna".
export function parseAnswerRegex(text) {
  const t = String(text).replace(/₹|\brs\.?/gi, ' ');
  const out = { sizes: [] };

  const range = t.match(/(\d{1,2})\s*(?:se|to|-|–)\s*(\d{1,2})/i);
  const letters = [...t.matchAll(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/gi)].map((m) => m[1].toUpperCase());
  if (range && Number(range[2]) >= Number(range[1]) && Number(range[2]) - Number(range[1]) <= 30) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    out.sizes = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i));
  } else if (letters.length) {
    out.sizes = [...new Set(letters)];
  }

  const each = t.match(/(?:har\s+(?:size\s+)?ke|each|per\s+size)\s+(\d+)|(\d+)\s*(?:pieces?|pcs?|each)\b/i);
  if (each) out.stock_each = Number(each[1] ?? each[2]);
  const total = t.match(/(?:stock|total|qty|quantity)\s*(?:is|hai|:)?\s*(\d+)/i);
  if (total) out.stock_total = Number(total[1]);

  const mrp = t.match(/mrp\s*(?:is|hai|:)?\s*(\d+(?:\.\d+)?)/i);
  if (mrp) out.mrp = Number(mrp[1]);
  const sell = t.match(/(?:bechna|bechn[ae]|selling(?:\s+price)?|sell(?:ing)?\s+at|price)\s*(?:is|hai|:|at)?\s*(\d+(?:\.\d+)?)/i)
    ?? t.match(/(\d+(?:\.\d+)?)\s*(?:mein|me|only)?\s*(?:bechna|bechn)/i);
  if (sell) out.selling_price = Number(sell[1]);

  return out;
}

export function createDraft(db, tenantId, analysis, imagePath = null) {
  const draft = normalizeAnalysis(analysis);
  const id = randomUUID();
  db.prepare('INSERT INTO listing_drafts (id, tenant_id, status, image_path, draft_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, tenantId, 'NEEDS_INFO', imagePath, JSON.stringify(draft));
  return draftView(id, draft);
}

export function getDraft(db, tenantId, id) {
  const row = loadRow(db, tenantId, id);
  return draftView(id, JSON.parse(row.draft_json));
}

// Accepts free text (`{ text }`), structured answers (`{ answers }`) and/or
// `{ image_mode: 'ORIGINAL' | 'STUDIO' }`. A STUDIO request generates the
// cleaned photo on first use.
export async function updateDraft(db, tenantId, id, input) {
  const row = loadRow(db, tenantId, id);
  const draft = JSON.parse(row.draft_json);
  let parsed = input.answers ?? {};
  let parser = 'form';
  let parserError = null;

  if (input.text != null) {
    parser = 'rules';
    if (metaEnabled()) {
      try {
        parsed = await parseAnswer(input.text);
        parser = 'muse-spark';
      } catch (err) {
        parserError = err.message;
        parsed = parseAnswerRegex(input.text);
      }
    } else {
      parsed = parseAnswerRegex(input.text);
    }
  }

  draft.answers = mergeAnswers(draft.answers, parsed, draft.category);
  if (input.fields) applyFields(draft, input.fields);
  if (input.image_mode) await applyImageMode(draft, readImage(row.image_path), input.image_mode);
  saveDraft(db, tenantId, id, draft);
  return { ...draftView(id, draft), parser, parser_error: parserError };
}

const FIELD_LIMITS = { title: 150, brand: 60, color: 60, material: 60, description: 2000, hsn_code: 20 };

// Applies the seller's edits to the listing text. Each field is trimmed and
// length-limited, and the category must be one we know.
function applyFields(draft, fields) {
  if (fields.title != null && String(fields.title).trim()) draft.title = String(fields.title).trim().slice(0, FIELD_LIMITS.title);
  if (fields.category != null) {
    if (!CATEGORIES[fields.category]) throw new InventoryError('BAD_CATEGORY', 'Unknown category');
    draft.category = fields.category;
  }
  for (const key of ['brand', 'color', 'material', 'description']) {
    if (fields[key] != null) draft[key] = String(fields[key]).slice(0, FIELD_LIMITS[key]);
  }
  if ('hsn_code' in fields) draft.hsn_code = fields.hsn_code ? String(fields.hsn_code).trim().slice(0, FIELD_LIMITS.hsn_code) : null;
  if (Array.isArray(fields.bullets)) {
    draft.bullets = fields.bullets.map((b) => String(b).trim().slice(0, 200)).filter(Boolean).slice(0, 5);
  }
  if (Array.isArray(fields.search_terms)) {
    draft.search_terms = [...new Set(fields.search_terms.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  }
}

async function applyImageMode(draft, original, mode) {
  if (mode !== 'ORIGINAL' && mode !== 'STUDIO') {
    throw new InventoryError('BAD_IMAGE_MODE', 'image_mode must be ORIGINAL or STUDIO');
  }
  if (mode === 'STUDIO' && !draft.images.studio) {
    if (!original) throw new InventoryError('NOT_FOUND', 'No original photo for this draft');
    const studio = await makeStudioImage(original);
    draft.images.studio = storeImage(studio.buffer, studio.mime);
    draft.images.studio_method = studio.method;
  }
  draft.images.mode = mode;
}

export function publishDraft(db, tenantId, id) {
  const row = loadRow(db, tenantId, id);
  const draft = JSON.parse(row.draft_json);
  const missing = missingSlots(draft);
  if (missing.length) throw new InventoryError('NEEDS_INFO', questionFor(missing));

  const variant = draft.images.mode === 'STUDIO' && draft.images.studio ? 'studio' : 'original';
  const { masterSku, variants } = buildVariants(draft);
  const product = createProduct(db, tenantId, {
    master_sku: masterSku,
    title: draft.title,
    category: draft.category,
    hsn_code: draft.hsn_code,
    gst_percent: draft.gst_percent,
    attributes: {
      color: draft.color,
      brand: draft.brand,
      material: draft.material,
      pattern: draft.pattern,
      gender: draft.gender,
      fit: draft.fit,
      style: draft.style,
      description: draft.description,
      search_terms: draft.search_terms,
      bullets: draft.bullets,
    },
    // Signed public link, so marketplaces can fetch the image without a login.
    media_urls: row.image_path ? [`/m/${id}/${variant}?sig=${signMedia(id, variant)}`] : [],
    variants,
  });
  db.prepare("UPDATE listing_drafts SET status = 'PUBLISHED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return product;
}

// Which photo a seller sees for a draft: their chosen version, or the original.
export function mediaName(db, tenantId, id, variant = 'auto') {
  const row = loadRow(db, tenantId, id);
  const draft = JSON.parse(row.draft_json);
  if (variant === 'original') return row.image_path;
  if (variant === 'studio') return draft.images?.studio ?? null;
  return draft.images?.mode === 'STUDIO' && draft.images?.studio ? draft.images.studio : row.image_path;
}

// Used by the signed public media route. The HMAC check happens before this
// is called, so no tenant lookup is needed here.
export function publicMedia(db, id, variant) {
  const row = db.prepare('SELECT image_path, draft_json FROM listing_drafts WHERE id = ?').get(id);
  if (!row) return null;
  if (variant === 'studio') return JSON.parse(row.draft_json).images?.studio ?? null;
  return row.image_path;
}

// Builds SKUs like SHOE-NAV-3F2A-UK7. The random suffix keeps two navy
// shoes from colliding in one seller's account.
export function buildVariants(draft) {
  const cat = CATEGORIES[draft.category] ?? CATEGORIES.GENERIC;
  const colorCode = draft.color.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'STD';
  const suffix = randomBytes(2).toString('hex').toUpperCase();
  const masterSku = `${cat.skuCode}-${colorCode}-${suffix}`;
  const a = draft.answers;

  if (!cat.needsSizes) {
    return {
      masterSku,
      variants: [{
        sku: masterSku,
        size: null,
        color: draft.color || null,
        mrp: a.mrp,
        selling_price: a.selling_price,
        stock_qty: a.stock_total ?? 0,
      }],
    };
  }

  return {
    masterSku,
    variants: a.sizes.map((size) => ({
      sku: `${masterSku}-${size.replace(/\s+/g, '')}`,
      size,
      color: draft.color || null,
      mrp: a.mrp,
      selling_price: a.selling_price,
      stock_qty: a.stock_per_size?.[size] ?? 0,
    })),
  };
}

function draftView(id, draft) {
  const missing = missingSlots(draft);
  return { id, draft, missing, question: questionFor(missing) };
}

function loadRow(db, tenantId, id) {
  const row = db.prepare('SELECT * FROM listing_drafts WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!row) throw new InventoryError('NOT_FOUND', `No draft ${id}`);
  return row;
}

function saveDraft(db, tenantId, id, draft) {
  db.prepare('UPDATE listing_drafts SET draft_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?')
    .run(JSON.stringify(draft), id, tenantId);
}
