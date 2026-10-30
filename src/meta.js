// Meta Model API client. Base URL and model ids come from env because they
// were taken from third-party docs, not Meta's own reference. Confirm them in
// the Meta developer console before the demo.
const BASE_URL = (process.env.META_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, '');
const SPARK_MODEL = process.env.META_SPARK_MODEL || 'muse-spark-1.1';
const IMAGE_MODEL = process.env.META_IMAGE_MODEL || 'muse-image-1.0';
const TIMEOUT_MS = 90_000;

export function metaEnabled() {
  return Boolean(process.env.META_API_KEY);
}

const PHOTO_INSTRUCTIONS = `You write complete marketplace listings for small Indian sellers (Amazon, Flipkart, Meesho, Shopify).
Look at the product photo and reply with ONLY one JSON object, no prose:
{"title": string (under 150 characters: product type, key feature, colour; add brand only if printed on the product),
 "category": "APPAREL" | "FOOTWEAR" | "GENERIC",
 "color": string, "material": string, "pattern": string, "gender": string, "fit": string, "style": string,
 "bullets": [exactly 5 feature bullets, each under 200 characters],
 "description": string (2 to 4 plain, factual sentences),
 "search_terms": [up to 8 lowercase keywords a buyer would type],
 "hsn_code_suggestion": string (the common HSN code for this product type, digits only, or ""),
 "confidence": number from 0 to 1}
Describe only what is visible. Use "" or [] when unknown. Never guess sizes, stock, prices, certifications, or a brand that is not printed on the product.`;

const ANSWER_INSTRUCTIONS = `A seller is answering questions about a product listing. Their answer may be
English, Hindi or Hinglish. Reply with ONLY one JSON object, no prose:
{"sizes": string[], "stock_each": number | null, "stock_total": number | null, "mrp": number | null, "selling_price": number | null}
"stock_each" means the same count for every size ("har size ke 15"). Use null for anything not stated.`;

export async function analyzePhoto(image, hints = '') {
  if (!metaEnabled()) return mockAnalysis(hints);
  return completeJson({
    instructions: PHOTO_INSTRUCTIONS,
    text: hints ? `Seller hint: ${hints}` : 'Write the full listing for this product photo.',
    image,
  });
}

export async function parseAnswer(text) {
  return completeJson({ instructions: ANSWER_INSTRUCTIONS, text });
}

// Image edit in the OpenAI-compatible images/edits shape. Unverified against
// Meta's docs, so the caller falls back to local cleanup on any failure.
export async function editImage(image, prompt) {
  if (!metaEnabled()) throw new Error('META_API_KEY is not set');
  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('prompt', prompt);
  form.append('image', new Blob([image.buffer], { type: image.mime }), 'product');
  form.append('response_format', 'b64_json');

  const res = await fetch(`${BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Meta image API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const item = (await res.json()).data?.[0];
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64') };
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!img.ok) throw new Error(`Image download failed: ${img.status}`);
    return { buffer: Buffer.from(await img.arrayBuffer()) };
  }
  throw new Error('Image edit returned no image');
}

export async function completeJson({ instructions, text, image }) {
  const content = [{ type: 'input_text', text }];
  if (image) {
    content.push({ type: 'input_image', image_url: `data:${image.mime};base64,${image.buffer.toString('base64')}` });
  }
  const raw = await respond({ instructions, content });
  return parseJsonFromText(raw);
}

async function respond({ instructions, content }) {
  const res = await fetch(`${BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: SPARK_MODEL, instructions, input: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Meta API ${res.status}: ${detail}`);
  }
  return outputText(await res.json());
}

function outputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text) return part.text;
    }
  }
  throw new Error('Meta API returned no text');
}

export function parseJsonFromText(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Model did not return JSON');
  return JSON.parse(match[0]);
}

function mockAnalysis(hints) {
  return {
    title: hints || 'Untitled product',
    category: 'GENERIC',
    color: '',
    material: '',
    pattern: '',
    gender: '',
    fit: '',
    style: '',
    bullets: [],
    description: '',
    search_terms: [],
    hsn_code_suggestion: '',
    confidence: 0,
    mock: true,
  };
}
