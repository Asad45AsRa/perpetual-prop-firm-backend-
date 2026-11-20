import type { MarketType } from '@prisma/client';

// =====================================================================
// Reviewed market limits (the "market registry" defaults).
// Only values that are documented in the product spec live here. Nothing is guessed:
//  * a symbol that is NOT in this catalog is created DISABLED, with the 2x "other crypto" cap,
//    until an admin reviews and approves its leverage / notional limits;
//  * maxNotionalUsd = null means "no per-symbol cap" (the account-wide gross exposure rule still applies).
// The owner must confirm every row before launch. Admins can change them later in the admin panel.
// =====================================================================

export interface CatalogEntry {
  marketType: MarketType;
  // Leverage cap for this symbol (the lower of this value and Hyperliquid's own maximum is used)
  maxLeverage: number;
  // Max open notional (USD) per symbol and side, per account
  maxNotionalUsd: number | null;
  // Resting limit orders also need the mark price to cross the limit
  requireMarkConfirm?: boolean;
}

export const MARKET_CATALOG: Record<string, CatalogEntry> = {
  BTC: { marketType: 'CRYPTO', maxLeverage: 10, maxNotionalUsd: 1_000_000 },
  ETH: { marketType: 'CRYPTO', maxLeverage: 10, maxNotionalUsd: 1_000_000 },
  SOL: { marketType: 'CRYPTO', maxLeverage: 10, maxNotionalUsd: 300_000 },
};

// Used for any symbol that has no reviewed catalog row.
export const UNREVIEWED_DEFAULT: CatalogEntry = { marketType: 'CRYPTO', maxLeverage: 2, maxNotionalUsd: null };

// Marks rows that already received the catalog limits (or were edited by an admin).
export const CATALOG_TIER_VERSION = 'catalog-1';
export const LEGACY_TIER_VERSION = 'v1';
