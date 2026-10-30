import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  adjustStock,
  getStock,
  InventoryError,
  listLowStock,
  mapChannel,
  upsertProduct,
} from './inventory.js';

const CHANNELS = ['AMAZON_IN', 'FLIPKART', 'MEESHO', 'SHOPIFY'];

// Builds a server bound to one tenant. Every tool call is scoped to that
// tenant, so an agent holding one seller's token can't touch another seller's stock.
export function buildMcpServer(db, tenantId) {
  const server = new McpServer({ name: 'quicklist-inventory', version: '0.1.0' });

  const run = (fn) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(fn(), null, 2) }] };
    } catch (err) {
      const code = err instanceof InventoryError ? err.code : 'ERROR';
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message: err.message }) }] };
    }
  };

  server.registerTool('inventory_upsert_product', {
    description: 'Create or update a product by master_sku. Existing variants keep their stock.',
    inputSchema: {
      master_sku: z.string().min(1).max(64),
      title: z.string().min(1).max(255),
      category: z.enum(['APPAREL', 'FOOTWEAR', 'GENERIC']).optional(),
      hsn_code: z.string().optional(),
      gst_percent: z.number().optional(),
      attributes: z.record(z.string(), z.any()).optional(),
      media_urls: z.array(z.url()).optional(),
      variants: z.array(z.object({
        sku: z.string().min(1),
        size: z.string().optional(),
        color: z.string().optional(),
        mrp: z.number().optional(),
        selling_price: z.number().optional(),
        stock_qty: z.number().int().optional(),
      })).optional(),
    },
  }, (args) => run(() => upsertProduct(db, tenantId, args)));

  server.registerTool('inventory_adjust_stock', {
    description: 'Change stock for one SKU by delta (negative for a sale). Pass platform_order_id so a retried call is applied only once.',
    inputSchema: {
      variant_sku: z.string().min(1),
      delta: z.number().int(),
      reason: z.string().default('MCP'),
      platform_order_id: z.string().optional(),
      source_platform: z.string().default('MCP'),
    },
  }, (a) => run(() => adjustStock(db, tenantId, a.variant_sku, a.delta, {
    reason: a.reason,
    source: a.source_platform,
    externalRef: a.platform_order_id ?? null,
  })));

  server.registerTool('inventory_get_stock', {
    description: 'Get the current stock and price for one SKU.',
    inputSchema: { variant_sku: z.string().min(1) },
  }, (a) => run(() => getStock(db, tenantId, a.variant_sku)));

  server.registerTool('inventory_list_low_stock', {
    description: 'List SKUs with stock at or below the threshold, lowest first.',
    inputSchema: { threshold: z.number().int().min(0).default(5) },
  }, (a) => run(() => listLowStock(db, tenantId, a.threshold)));

  server.registerTool('inventory_map_channel_id', {
    description: 'Link a SKU to its listing id on a marketplace (ASIN, FSN, or variant id).',
    inputSchema: {
      variant_sku: z.string().min(1),
      platform: z.enum(CHANNELS),
      platform_listing_id: z.string().min(1),
    },
  }, (a) => run(() => mapChannel(db, tenantId, a.variant_sku, a.platform, a.platform_listing_id)));

  return server;
}

// Stateless Streamable HTTP: a fresh server per request, so no session
// state lives in memory between calls.
export async function handleMcpRequest(db, tenantId, req, res, body) {
  const server = buildMcpServer(db, tenantId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
