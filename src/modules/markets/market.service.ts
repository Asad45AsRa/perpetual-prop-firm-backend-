import { Decimal } from '../../utils/decimal';
import { prisma } from '../../config/prisma';
import { launchSymbols } from '../../config/env';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/api-error';
import { fetchPerpMeta } from './hyperliquid.client';
import { CATALOG_TIER_VERSION, LEGACY_TIER_VERSION, MARKET_CATALOG, UNREVIEWED_DEFAULT } from './market.catalog';
import { priceFeed, type TrackedMarket } from './price-feed';

// Reads Hyperliquid metadata and saves the supported symbols in our DB (market registry).
// Only symbols listed in LAUNCH_SYMBOLS (BTC, ETH at first) are stored.
//  * New rows get the reviewed catalog limits. A symbol without a reviewed row is created DISABLED.
//  * Existing rows keep their admin settings (enabled / halted / limits / fees). Only exchange
//    facts (decimals, tick, step) are refreshed. A lower Hyperliquid leverage limit always wins.
//  * A contract that Hyperliquid delisted (or no longer lists) becomes CLOSE-ONLY.
export async function syncMarkets() {
  const assets = await fetchPerpMeta();
  const byName = new Map(assets.map((a) => [a.name.toUpperCase(), a]));
  let synced = 0;

  for (const symbol of launchSymbols) {
    const asset = byName.get(symbol);

    // Delisted or missing: no new exposure, existing positions may still be closed
    if (!asset || asset.isDelisted) {
      const result = await prisma.market.updateMany({
        where: { symbol, isCloseOnly: false },
        data: { isCloseOnly: true, delistedAt: new Date(), riskTierVersion: `delisted-${Date.now()}` },
      });
      if (result.count > 0) logger.warn({ symbol }, 'Market is delisted on Hyperliquid, switched to close-only');
      continue;
    }

    // Hyperliquid perps allow at most (6 - szDecimals) price decimals
    const pricePrecision = Math.max(0, 6 - asset.szDecimals);
    const sizeStep = new Decimal(10).pow(-asset.szDecimals);
    const priceTick = new Decimal(10).pow(-pricePrecision);
    const reviewed = MARKET_CATALOG[symbol];
    const entry = reviewed ?? UNREVIEWED_DEFAULT;
    const leverageCap = Math.min(asset.maxLeverage, entry.maxLeverage);

    const existing = await prisma.market.findUnique({ where: { symbol: asset.name } });

    if (!existing) {
      await prisma.market.create({
        data: {
          symbol: asset.name,
          baseAsset: asset.name,
          hlKey: asset.name,
          marketType: entry.marketType,
          szDecimals: asset.szDecimals,
          pricePrecision,
          priceTick: priceTick.toFixed(),
          sizeStep: sizeStep.toFixed(),
          minSize: sizeStep.toFixed(),
          maxLeverage: leverageCap,
          maxNotionalUsd: entry.maxNotionalUsd,
          requireMarkConfirm: entry.requireMarkConfirm ?? false,
          riskTierVersion: reviewed ? CATALOG_TIER_VERSION : LEGACY_TIER_VERSION,
          // Never auto-enable a symbol nobody has reviewed
          isEnabled: !!reviewed,
        },
      });
    } else {
      const lowerLeverage = Math.min(existing.maxLeverage, asset.maxLeverage);
      // Rows created by an older version have no reviewed limits yet: apply the catalog once
      const adoptCatalog = !!reviewed && existing.riskTierVersion === LEGACY_TIER_VERSION && existing.maxNotionalUsd === null;

      await prisma.market.update({
        where: { id: existing.id },
        data: {
          hlKey: asset.name,
          szDecimals: asset.szDecimals,
          pricePrecision,
          priceTick: priceTick.toFixed(),
          sizeStep: sizeStep.toFixed(),
          minSize: sizeStep.toFixed(),
          // Back from delisted
          ...(existing.delistedAt ? { delistedAt: null, isCloseOnly: false } : {}),
          ...(adoptCatalog
            ? {
                marketType: entry.marketType,
                maxLeverage: leverageCap,
                maxNotionalUsd: entry.maxNotionalUsd,
                requireMarkConfirm: entry.requireMarkConfirm ?? false,
                riskTierVersion: CATALOG_TIER_VERSION,
              }
            : lowerLeverage < existing.maxLeverage
              ? { maxLeverage: lowerLeverage, riskTierVersion: `hl-limit-${Date.now()}` }
              : {}),
        },
      });
    }
    synced++;
  }

  logger.info({ synced }, 'Markets synced from Hyperliquid');
  return synced;
}

export async function getEnabledSymbols(): Promise<string[]> {
  const rows = await prisma.market.findMany({ where: { isEnabled: true }, select: { symbol: true } });
  return rows.map((r) => r.symbol);
}

// Symbol + exact Hyperliquid coin key, used to start the price feed.
export async function getTrackedMarkets(): Promise<TrackedMarket[]> {
  const rows = await prisma.market.findMany({ where: { isEnabled: true }, select: { symbol: true, hlKey: true } });
  return rows.map((r) => ({ symbol: r.symbol, coin: r.hlKey }));
}

type MarketRow = Awaited<ReturnType<typeof prisma.market.findFirstOrThrow>>;

// Public shape of one market with its live data. "tradable" is the single flag the UI needs.
export function presentMarket(m: MarketRow) {
  const tick = priceFeed.getPrice(m.symbol);
  const bookFresh = priceFeed.isBookFresh(m.symbol);
  const markFresh = priceFeed.isMarkFresh(m.symbol);
  return {
    symbol: m.symbol,
    marketType: m.marketType,
    maxLeverage: m.maxLeverage,
    maxNotionalUsd: m.maxNotionalUsd?.toString() ?? null,
    minNotionalUsd: m.minNotionalUsd.toString(),
    szDecimals: m.szDecimals,
    pricePrecision: m.pricePrecision,
    priceTick: m.priceTick.toString(),
    sizeStep: m.sizeStep.toString(),
    minSize: m.minSize.toString(),
    isHalted: m.isHalted,
    isCloseOnly: m.isCloseOnly,
    fundingSupported: m.fundingSupported,
    price: tick?.mid.toString() ?? null,
    bid: tick?.bid?.toString() ?? null,
    ask: tick?.ask?.toString() ?? null,
    mark: tick?.mark?.toString() ?? null,
    oracle: tick?.oracle?.toString() ?? null,
    fundingRate: tick?.funding?.toString() ?? null,
    bookFresh,
    markFresh,
    // Trading is blocked while the price is stale
    priceFresh: bookFresh && markFresh,
    tradable: m.isEnabled && !m.isHalted && !m.isCloseOnly && bookFresh && markFresh,
    updatedAt: tick?.ts ?? null,
  };
}

// Public market list with the live price attached.
export async function listMarkets() {
  const markets = await prisma.market.findMany({ where: { isEnabled: true }, orderBy: { symbol: 'asc' } });
  return markets.map(presentMarket);
}

export async function getMarketOrThrow(symbol: string) {
  const market = await prisma.market.findUnique({ where: { symbol: symbol.toUpperCase() } });
  if (!market || !market.isEnabled) throw ApiError.notFound('Market not available');
  return market;
}
