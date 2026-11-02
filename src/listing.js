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
  draft.photos = imagePath ? [newPhoto(imagePath, 'upload')] : [];
  const id = randomUUID();
  db.prepare('INSERT INTO listing_drafts (id, tenant_id, status, image_path, draft_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, tenantId, 'NEEDS_INFO', imagePath, JSON.stringify(draft));
  return draftView(id, draft);
}

export function getDraft(db, tenantId, id) {
  const row = loadRow(db, tenantId, id);
  return draftView(id, loadDraft(row));
}

// Accepts free text (`{ text }`), structured answers (`{ answers }`) and/or
// `{ image_mode: 'ORIGINAL' | 'STUDIO' }`. A STUDIO request generates the
// cleaned photo on first use.
export async function updateDraft(db, tenantId, id, input) {
  const row = loadRow(db, tenantId, id);
  const draft = loadDraft(row);
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
  if (input.image_mode) await applyModeToAll(draft, input.image_mode);
  if (input.photo_mode) await applyPhotoMode(draft, Number(input.photo_mode.index), input.photo_mode.mode);
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

// Each photo keeps its original upload and, once enhanced, a white-background
// version. `mode` says which one goes on the listing.
function newPhoto(original, source) {
  return { original, enhanced: null, mode: 'ORIGINAL', method: null, source };
}

// Drafts saved before multi-photo listings kept one photo in `image_path` and
// its white version under `images`. Read those into the new shape.
function photosOf(row, draft) {
  if (draft.photos) return draft.photos;
  if (!row.image_path) return [];
  const legacy = draft.images ?? {};
  return [{
    original: row.image_path,
    enhanced: legacy.studio ?? null,
    mode: legacy.mode === 'STUDIO' ? 'STUDIO' : 'ORIGINAL',
    method: legacy.studio_method ?? null,
    source: 'upload',
  }];
}

function loadDraft(row) {
  const draft = JSON.parse(row.draft_json);
  draft.photos = photosOf(row, draft);
  delete draft.images;
  return draft;
}

// Media links name a photo and a version, such as `0-original` or `1-enhanced`.
// Links made before multi-photo listings used `original` and `studio` for the first photo.
function parseVariant(variant) {
  const m = /^(\d+)-(original|enhanced)$/.exec(variant);
  if (m) return { index: Number(m[1]), kind: m[2] };
  return { index: 0, kind: variant === 'studio' ? 'enhanced' : 'original' };
}

function fileOf(photo, kind) {
  if (!photo) return null;
  return kind === 'enhanced' ? photo.enhanced : photo.original;
}

// The version a photo shows on the listing.
function chosenKind(photo) {
  return photo.mode === 'STUDIO' && photo.enhanced ? 'enhanced' : 'original';
}

async function applyPhotoMode(draft, index, mode) {
  if (mode !== 'ORIGINAL' && mode !== 'STUDIO') {
    throw new InventoryError('BAD_IMAGE_MODE', 'image_mode must be ORIGINAL or STUDIO');
  }
  const photo = draft.photos[index];
  if (!photo) throw new InventoryError('NOT_FOUND', `No photo ${index}`);
  if (mode === 'STUDIO' && !photo.enhanced) {
    const original = readImage(photo.original);
    if (!original) throw new InventoryError('NOT_FOUND', 'The original photo is missing');
    const studio = await makeStudioImage(original);
    photo.enhanced = storeImage(studio.buffer, studio.mime);
    photo.method = studio.method;
  }
  photo.mode = mode;
}

async function applyModeToAll(draft, mode) {
  for (let i = 0; i < draft.photos.length; i++) await applyPhotoMode(draft, i, mode);
}

export function publishDraft(db, tenantId, id) {
  const row = loadRow(db, tenantId, id);
  const draft = loadDraft(row);
  const missing = missingSlots(draft);
  if (missing.length) throw new InventoryError('NEEDS_INFO', questionFor(missing));

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
    // One signed public link per photo, so marketplaces can fetch each image without a login.
    media_urls: draft.photos.map((photo, i) => {
      const variant = `${i}-${chosenKind(photo)}`;
      return `/m/${id}/${variant}?sig=${signMedia(id, variant)}`;
    }),
    variants,
  });
  db.prepare("UPDATE listing_drafts SET status = 'PUBLISHED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return product;
}

// Which photo a seller sees for a draft: their chosen version, or the original.
export function mediaName(db, tenantId, id, variant = 'auto') {
  const draft = loadDraft(loadRow(db, tenantId, id));
  if (variant === 'auto') {
    const first = draft.photos[0];
    return first ? fileOf(first, chosenKind(first)) : null;
  }
  const { index, kind } = parseVariant(variant);
  return fileOf(draft.photos[index], kind);
}

// Used by the signed public media route. The HMAC check happens before this
// is called, so no tenant lookup is needed here.
export function publicMedia(db, id, variant) {
  const row = db.prepare('SELECT * FROM listing_drafts WHERE id = ?').get(id);
  if (!row) return null;
  const { index, kind } = parseVariant(variant);
  return fileOf(loadDraft(row).photos[index], kind);
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

export const MAX_PHOTOS = 8;

// Adds a photo to a draft. `front` puts it first, so it becomes the main image.
export function addPhoto(db, tenantId, id, { buffer, mime, source = 'upload', front = false }) {
  const row = loadRow(db, tenantId, id);
  const draft = loadDraft(row);
  if (draft.photos.length >= MAX_PHOTOS) {
    throw new InventoryError('TOO_MANY_PHOTOS', `A listing holds up to ${MAX_PHOTOS} photos`);
  }
  const photo = newPhoto(storeImage(buffer, mime), source);
  if (front) draft.photos.unshift(photo);
  else draft.photos.push(photo);
  saveDraft(db, tenantId, id, draft);
  return draftView(id, draft);
}

// Swaps in a photo the seller has edited. If they chose the white version, it is made again.
export async function replacePhoto(db, tenantId, id, index, { buffer, mime }) {
  const row = loadRow(db, tenantId, id);
  const draft = loadDraft(row);
  const photo = draft.photos[index];
  if (!photo) throw new InventoryError('NOT_FOUND', `No photo ${index}`);
  const wasStudio = photo.mode === 'STUDIO';
  Object.assign(photo, { original: storeImage(buffer, mime), enhanced: null, method: null, mode: 'ORIGINAL', source: 'edited' });
  if (wasStudio) await applyPhotoMode(draft, index, 'STUDIO');
  saveDraft(db, tenantId, id, draft);
  return draftView(id, draft);
}

export function removePhoto(db, tenantId, id, index) {
  const row = loadRow(db, tenantId, id);
  const draft = loadDraft(row);
  if (!draft.photos[index]) throw new InventoryError('NOT_FOUND', `No photo ${index}`);
  draft.photos.splice(index, 1);
  saveDraft(db, tenantId, id, draft);
  return draftView(id, draft);
}

// Words that ask for a new picture of the product, such as "put on a mannequin".
const NOTE_PHOTO = /\b(mann?e?quin|manequ[a-z]*|model|wear|worn|put on|on a body|background)\b/i;
export function wantsNotePhoto(note) {
  return NOTE_PHOTO.test(String(note ?? ''));
}

function saveDraft(db, tenantId, id, draft) {
  db.prepare('UPDATE listing_drafts SET draft_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?')
    .run(JSON.stringify(draft), id, tenantId);
}
