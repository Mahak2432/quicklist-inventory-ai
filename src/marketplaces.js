// Category rules and per-marketplace export shapes.
// The export headers are placeholders for the shape each marketplace expects.
// Before a real upload, copy the exact headers from that seller panel's bulk
// template, since the column names change by category.

export const CATEGORIES = {
  APPAREL: { label: 'Apparel', needsSizes: true, skuCode: 'APP' },
  FOOTWEAR: { label: 'Footwear', needsSizes: true, skuCode: 'SHOE' },
  GENERIC: { label: 'General', needsSizes: false, skuCode: 'ITEM' },
};

const exportRow = {
  AMAZON_IN: (p, v, image) => ({
    sku: v.sku,
    product_type: p.category,
    item_name: p.title,
    brand: p.attributes.brand ?? '',
    color: v.color ?? '',
    size: v.size ?? '',
    standard_price: v.selling_price ?? '',
    quantity: v.stock_qty,
    hsn_code: p.hsn_code ?? '',
    country_of_origin: 'IN',
    main_image_url: image,
  }),
  FLIPKART: (p, v, image) => ({
    seller_sku: v.sku,
    product_title: p.title,
    brand: p.attributes.brand ?? '',
    color: v.color ?? '',
    size: v.size ?? '',
    mrp: v.mrp ?? '',
    selling_price: v.selling_price ?? '',
    stock: v.stock_qty,
    hsn_code: p.hsn_code ?? '',
    gst_rate: p.gst_percent ?? '',
    image_url: image,
  }),
  MEESHO: (p, v, image) => ({
    supplier_sku: v.sku,
    product_name: p.title,
    size: v.size ?? '',
    color: v.color ?? '',
    mrp: v.mrp ?? '',
    selling_price: v.selling_price ?? '',
    stock: v.stock_qty,
    hsn_code: p.hsn_code ?? '',
    gst_rate: p.gst_percent ?? '',
    image_url: image,
  }),
  SHOPIFY: (p, v, image) => ({
    Handle: p.master_sku.toLowerCase(),
    Title: p.title,
    Vendor: p.attributes.brand ?? '',
    'Option1 Name': 'Size',
    'Option1 Value': v.size ?? '',
    'Variant SKU': v.sku,
    'Variant Price': v.selling_price ?? '',
    'Variant Compare At Price': v.mrp ?? '',
    'Variant Inventory Qty': v.stock_qty,
    'Image Src': image,
  }),
};

export const PLATFORMS = Object.keys(exportRow);

// Things a marketplace will reject the listing for. Returned as warnings so
// the seller can fix them before uploading.
export function exportWarnings(product, platform) {
  const warnings = [];
  if (!product.hsn_code) warnings.push('HSN code missing');
  if (!product.media_urls.length) warnings.push('No product image');
  if (platform === 'AMAZON_IN' && !product.attributes.brand) warnings.push('Brand required on Amazon');
  if (platform === 'FLIPKART' && !product.attributes.brand) warnings.push('Brand required on Flipkart');
  for (const v of product.variants) {
    if (v.mrp == null || v.selling_price == null) warnings.push(`${v.sku}: MRP or selling price missing`);
    else if (v.selling_price > v.mrp) warnings.push(`${v.sku}: selling price is above MRP`);
  }
  return warnings;
}

export function buildCsv(platform, products, baseUrl = '') {
  const build = exportRow[platform];
  if (!build) throw new Error(`Unknown platform ${platform}`);
  const rows = [];
  for (const p of products) {
    const image = p.media_urls[0] ? `${baseUrl}${p.media_urls[0]}` : '';
    for (const v of p.variants) rows.push(build(p, v, image));
  }
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\n') + '\n';
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
