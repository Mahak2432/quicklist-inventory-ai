import { CONNECTORS } from './connectors.js';
import { pushForTenant } from './connections.js';

// One adapter per connector. Keys are read per tenant at push time, so one
// seller's credentials are never used for another seller's stock.
export function makeAdapters(db) {
  return Object.fromEntries(Object.keys(CONNECTORS).map((platform) => [platform, {
    pushStock({ tenantId, sku, qty }) {
      const link = db
        .prepare('SELECT platform_listing_id FROM channel_mappings WHERE tenant_id = ? AND sku = ? AND platform = ?')
        .get(tenantId, sku, platform);
      return pushForTenant(db, tenantId, platform, { sku, qty, listingId: link?.platform_listing_id ?? null });
    },
  }]));
}
