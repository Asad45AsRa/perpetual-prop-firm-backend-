import type { PositionMode } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { Decimal, toD } from '../../utils/decimal';
import { maintenanceMarginRef, unrealizedPnl } from './engine/calculations';
import { computeMetrics, isOverCap, type Leg, type WorkingExposure } from './engine/exposure';
import { priceFeed } from '../markets/price-feed';
import { getSetting } from '../settings/settings.service';

export interface PositionView {
  positionId: string;
  marketId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  notional: Decimal;
  leverage: number;
  // Initial margin held by the position
  margin: Decimal;
  // Reference only (never liquidates)
  maintenanceMarginRef: Decimal;
  unrealizedPnl: Decimal;
  // Cross margin: positions are not liquidated one by one, so this is always null.
  liquidationPrice: Decimal | null;
}

export interface AccountSnapshot {
  balance: Decimal;
  unrealizedPnl: Decimal;
  equity: Decimal;
  // Initial margin of open positions (older name kept for existing callers)
  marginUsed: Decimal;
  // Equity - initial margin - margin reserved by working orders
  freeMargin: Decimal;
  availableMargin: Decimal;
  maintenanceMarginRef: Decimal;
  reservedMargin: Decimal;
  grossExposure: Decimal;
  grossExposureLimit: Decimal;
  // Gross exposure is above the platform cap: new exposure is blocked, reducing is allowed
  overCap: boolean;
  positionMode: PositionMode;
  positions: PositionView[];
}

// Mark price used for floating PnL: the live mark when it is fresh, otherwise the last stored mark
// of the position (a stale feed never makes PnL jump, and trading is blocked anyway).
export function resolveMark(symbol: string, storedMark: Decimal): Decimal {
  if (priceFeed.isMarkFresh(symbol)) {
    const live = priceFeed.getMark(symbol);
    if (live) return live.mark;
  }
  return storedMark;
}

// Builds a live view of an account: balance + floating PnL = equity (cross margin).
export async function computeAccountSnapshot(tx: Tx, accountId: string): Promise<AccountSnapshot> {
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { balance: true, positionMode: true },
  });
  const rows = await tx.position.findMany({
    where: { accountId, size: { gt: 0 } },
    include: { market: { select: { symbol: true } } },
    orderBy: { openedAt: 'asc' },
  });
  const working = await tx.order.findMany({
    where: { accountId, status: { in: ['NEW', 'PARTIALLY_FILLED'] }, reservedMargin: { gt: 0 } },
    include: { market: { select: { symbol: true } } },
  });
  const config = await getSetting('trading');

  const views: PositionView[] = rows.map((p) => {
    const size = toD(p.size);
    const entry = toD(p.entryPrice);
    const mark = resolveMark(p.market.symbol, toD(p.markPrice));
    const margin = toD(p.margin);
    return {
      positionId: p.id,
      marketId: p.marketId,
      symbol: p.market.symbol,
      side: p.side,
      size,
      entryPrice: entry,
      markPrice: mark,
      notional: size.mul(mark),
      leverage: p.leverage,
      margin,
      maintenanceMarginRef: maintenanceMarginRef(margin, config.mmrFractionOfImr),
      unrealizedPnl: unrealizedPnl(p.side, size, entry, mark),
      liquidationPrice: null,
    };
  });

  const legs: Leg[] = views.map((v) => ({
    marketKey: v.symbol,
    side: v.side,
    size: v.size,
    entryPrice: v.entryPrice,
    mark: v.markPrice,
    margin: v.margin,
  }));
  const exposures: WorkingExposure[] = working.map((o) => ({
    marketKey: o.market.symbol,
    side: o.side === 'BUY' ? 'LONG' : 'SHORT',
    remaining: toD(o.size).minus(toD(o.filledSize)),
    price: toD(o.limitPrice ?? 0),
    reserved: toD(o.reservedMargin),
  }));

  const metrics = computeMetrics(toD(account.balance), legs, exposures, config.mmrFractionOfImr);

  return {
    balance: metrics.balance,
    unrealizedPnl: metrics.unrealizedPnl,
    equity: metrics.equity,
    marginUsed: metrics.initialMargin,
    freeMargin: metrics.availableMargin,
    availableMargin: metrics.availableMargin,
    maintenanceMarginRef: metrics.maintenanceMarginRef,
    reservedMargin: metrics.reservedMargin,
    grossExposure: metrics.grossExposure,
    grossExposureLimit: metrics.equity.mul(config.grossExposureMultiple),
    overCap: isOverCap(metrics, config.grossExposureMultiple),
    positionMode: account.positionMode,
    positions: views,
  };
}
