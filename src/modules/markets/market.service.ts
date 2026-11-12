import { Decimal } from '../../utils/decimal';
import { prisma } from '../../config/prisma';
import { launchSymbols } from '../../config/env';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/api-error';
import { fetchPerpMeta } from './hyperliquid.client';
import { priceFeed } from './price-feed';

// Reads Hyperliquid metadata and saves the supported symbols in our DB.
// Only symbols listed in LAUNCH_SYMBOLS (BTC, ETH at first) are stored.
// Existing rows keep their admin settings (enabled / halted).
export async function syncMarkets() {
  const assets = await fetchPerpMeta();
  let synced = 0;

  for (const asset of assets) {
    if (asset.isDelisted || !launchSymbols.includes(asset.name.toUpperCase())) continue;

    // Hyperliquid perps allow at most (6 - szDecimals) price decimals
    const pricePrecision = Math.max(0, 6 - asset.szDecimals);
    const minSize = new Decimal(10).pow(-asset.szDecimals);

    await prisma.market.upsert({
      where: { symbol: asset.name },
      create: {
        symbol: asset.name,
        baseAsset: asset.name,
        szDecimals: asset.szDecimals,
        pricePrecision,
        minSize: minSize.toFixed(),
        maxLeverage: asset.maxLeverage,
        isEnabled: true,
      },
      update: {
        szDecimals: asset.szDecimals,
        pricePrecision,
        minSize: minSize.toFixed(),
        maxLeverage: asset.maxLeverage,
      },
    });
    synced++;
  }

  logger.info({ synced }, 'Markets synced from Hyperliquid');
  return synced;
}

export async function getEnabledSymbols(): Promise<string[]> {
  const rows = await prisma.market.findMany({ where: { isEnabled: true }, select: { symbol: true } });
  return rows.map((r) => r.symbol);
}

// Public market list with the live price attached.
export async function listMarkets() {
  const markets = await prisma.market.findMany({ where: { isEnabled: true }, orderBy: { symbol: 'asc' } });
  return markets.map((m) => {
    const tick = priceFeed.getPrice(m.symbol);
    return {
      symbol: m.symbol,
      maxLeverage: m.maxLeverage,
      szDecimals: m.szDecimals,
      pricePrecision: m.pricePrecision,
      minSize: m.minSize.toString(),
      isHalted: m.isHalted,
      price: tick?.mid.toString() ?? null,
      bid: tick?.bid?.toString() ?? null,
      ask: tick?.ask?.toString() ?? null,
      // Trading is blocked while the price is stale
      priceFresh: priceFeed.isFresh(m.symbol),
    };
  });
}

export async function getMarketOrThrow(symbol: string) {
  const market = await prisma.market.findUnique({ where: { symbol: symbol.toUpperCase() } });
  if (!market || !market.isEnabled) throw ApiError.notFound('Market not available');
  return market;
}
