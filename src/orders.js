import { adjustStock, InventoryError } from './inventory.js';

export const ORDER_PLATFORMS = ['AMAZON_IN', 'FLIPKART', 'MEESHO', 'SHOPIFY', 'WOOCOMMERCE', 'CUSTOM_SITE', 'DEMO'];

// Each marketplace sends a different order shape. Map each one to a common
// { orderId, lines: [{ lineId, sku, quantity }] } before any stock logic runs.
// Flipkart and Meesho use the generic shape below, since their real payloads
// need a relay or webhook adapter that is not built yet.
export function normalizeOrder(platform, raw) {
  if (platform === 'AMAZON_IN') {
    return {
      orderId: String(raw.AmazonOrderId ?? ''),
      lines: (raw.OrderItems ?? []).map((i) => ({
        lineId: String(i.OrderItemId ?? ''),
        sku: i.SellerSKU,
        quantity: Number(i.QuantityOrdered),
      })),
    };
  }
  if (platform === 'SHOPIFY' || platform === 'WOOCOMMERCE') {
    return {
      orderId: String(raw.id ?? ''),
      lines: (raw.line_items ?? []).map((i) => ({ lineId: String(i.id ?? ''), sku: i.sku, quantity: Number(i.quantity) })),
    };
  }
  return {
    orderId: String(raw.order_id ?? ''),
    lines: (raw.lines ?? []).map((i) => ({ lineId: String(i.line_id ?? ''), sku: i.sku, quantity: Number(i.quantity) })),
  };
}

// Applies one marketplace order. Each line is keyed by platform + order +
// line, so retried webhooks and overlapping polls cannot deduct twice.
export async function processOrder(db, tenantId, platform, raw) {
  if (!ORDER_PLATFORMS.includes(platform)) throw new InventoryError('BAD_PLATFORM', `Unknown platform ${platform}`);
  const order = normalizeOrder(platform, raw);
  if (!order.orderId || !order.lines.length) {
    throw new InventoryError('BAD_ORDER', 'Order needs an id and at least one line');
  }

  const lines = [];
  for (const line of order.lines) {
    const base = { lineId: line.lineId, sku: line.sku, quantity: line.quantity };
    if (!line.sku || !Number.isInteger(line.quantity) || line.quantity <= 0 || !line.lineId) {
      lines.push({ ...base, status: 'REJECTED', error: 'Line needs a lineId, sku and a positive whole quantity' });
      continue;
    }
    try {
      const r = await adjustStock(db, tenantId, line.sku, -line.quantity, {
        reason: 'ORDER',
        source: platform,
        externalRef: `${order.orderId}:${line.lineId}`,
        allowNegative: true,
      });
      lines.push({
        ...base,
        status: r.duplicate ? 'DUPLICATE' : 'APPLIED',
        qty: r.qty,
        oversold: r.oversold,
        pushedTo: r.pushedTo,
      });
    } catch (err) {
      if (err instanceof InventoryError && err.code === 'NOT_FOUND') {
        lines.push({ ...base, status: 'UNKNOWN_SKU', error: err.message });
      } else {
        throw err;
      }
    }
  }

  return { platform, orderId: order.orderId, lines };
}

export function describeOrder(result) {
  const parts = result.lines.map((l) => {
    if (l.status === 'APPLIED') {
      const flag = l.oversold ? ' OVERSOLD, restock now' : '';
      return `${l.quantity}x ${l.sku}: stock now ${l.qty}${flag}`;
    }
    if (l.status === 'DUPLICATE') return `${l.sku}: already counted`;
    return `${l.sku || 'line'}: ${l.error}`;
  });
  return `Order ${result.orderId} on ${result.platform}. ${parts.join('; ')}`;
}
