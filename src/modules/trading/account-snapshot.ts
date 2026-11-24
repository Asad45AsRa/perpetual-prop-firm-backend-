import type { AccountStage, AccountStatus, PositionMode } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { Decimal, toD } from '../../utils/decimal';
import { priceFeed } from '../markets/price-feed';
import { unrealizedPnl } from './engine/calculations';
import { computeMetrics, isOverCap, type Leg, type WorkingExposure } from './engine/exposure';
import { maintenanceMargin } from './engine/market-policy';

// =====================================================================
// Live account view (cross margin). Two steps so the terminal can refresh it every second WITHOUT a database read:
//   1. loadAccountInputs  : the stored part (balance, open legs, margin held by resting orders). One DB read.
//   2. computeSnapshot    : pure maths on those inputs and the LIVE mark prices from the Hyperliquid feed.
// All values come from stored ledger state and live marks. Nothing is estimated or invented.
// =====================================================================

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
  // |size| x mark x (0.5 / symbol max leverage)
  maintenanceMargin: Decimal;
  unrealizedPnl: Decimal;
  // Cross margin: positions are not liquidated one by one, so this is always null.
  liquidationPrice: Decimal | null;
}

export interface AccountSnapshot {
  balance: Decimal;
  unrealizedPnl: Decimal;
  equity: Decimal;
  // Initial margin of open positions
  marginUsed: Decimal;
  // Classic free margin: equity - used margin - reserved margin (display only)
  freeMargin: Decimal;
  // New-entry margin capacity: max(0, min(balance, equity) - used margin - pending margin)
  availableMargin: Decimal;
  // Total maintenance threshold of the account
  maintenanceMargin: Decimal;
  reservedMargin: Decimal;
  grossExposure: Decimal;
  grossExposureLimit: Decimal;
  grossExposureMultiple: number;
  // Gross exposure is above the model cap: new exposure is blocked, reducing is allowed
  overCap: boolean;
  positionMode: PositionMode;
  positions: PositionView[];
}

export interface StoredLeg {
  id: string;
  marketId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: Decimal;
  entryPrice: Decimal;
  margin: Decimal;
  leverage: number;
  // Last mark stored with the position (used only while the live mark is stale)
  storedMark: Decimal;
  // Maximum leverage the symbol permits
  maxLeverage: number;
}

export interface AccountInputs {
  accountId: string;
  stage: AccountStage;
  status: AccountStatus;
  startingBalance: Decimal;
  balance: Decimal;
  positionMode: PositionMode;
  // Gross exposure cap as a multiple of CURRENT equity (10 for evaluation / funded models, 3 for Instant)
  grossExposureMultiple: number;
  legs: StoredLeg[];
  working: WorkingExposure[];
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

// Step 1: everything that is stored in the database for one account.
export async function loadAccountInputs(tx: Tx, accountId: string): Promise<AccountInputs> {
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { stage: true, status: true, startingBalance: true, balance: true, positionMode: true, plan: { select: { grossExposureMultiple: true } } },
  });
  const rows = await tx.position.findMany({
    where: { accountId, size: { gt: 0 } },
    include: { market: { select: { symbol: true, maxLeverage: true } } },
    orderBy: { openedAt: 'asc' },
  });
  const working = await tx.order.findMany({
    where: { accountId, status: { in: ['NEW', 'PARTIALLY_FILLED'] }, reservedMargin: { gt: 0 } },
    include: { market: { select: { symbol: true } } },
  });

  return {
    accountId,
    stage: account.stage,
    status: account.status,
    startingBalance: toD(account.startingBalance),
    balance: toD(account.balance),
    positionMode: account.positionMode,
    grossExposureMultiple: account.plan.grossExposureMultiple,
    legs: rows.map((p) => ({
      id: p.id,
      marketId: p.marketId,
      symbol: p.market.symbol,
      side: p.side,
      size: toD(p.size),
      entryPrice: toD(p.entryPrice),
      margin: toD(p.margin),
      leverage: p.leverage,
      storedMark: toD(p.markPrice),
      maxLeverage: p.market.maxLeverage,
    })),
    working: working.map((o) => ({
      marketKey: o.market.symbol,
      side: o.side === 'BUY' ? 'LONG' : 'SHORT',
      remaining: toD(o.size).minus(toD(o.filledSize)),
      price: toD(o.limitPrice ?? 0),
      reserved: toD(o.reservedMargin),
    })),
  };
}

// Step 2: pure maths on the stored inputs and the live marks.
export function computeSnapshot(inputs: AccountInputs): AccountSnapshot {
  const views: PositionView[] = inputs.legs.map((l) => {
    const mark = resolveMark(l.symbol, l.storedMark);
    return {
      positionId: l.id,
      marketId: l.marketId,
      symbol: l.symbol,
      side: l.side,
      size: l.size,
      entryPrice: l.entryPrice,
      markPrice: mark,
      notional: l.size.mul(mark),
      leverage: l.leverage,
      margin: l.margin,
      maintenanceMargin: maintenanceMargin(l.size.mul(mark), l.maxLeverage),
      unrealizedPnl: unrealizedPnl(l.side, l.size, l.entryPrice, mark),
      liquidationPrice: null,
    };
  });

  const legs: Leg[] = views.map((v, i) => ({
    marketKey: v.symbol,
    side: v.side,
    size: v.size,
    entryPrice: v.entryPrice,
    mark: v.markPrice,
    margin: v.margin,
    maxLeverage: inputs.legs[i].maxLeverage,
  }));
  const metrics = computeMetrics(inputs.balance, legs, inputs.working);

  return {
    balance: metrics.balance,
    unrealizedPnl: metrics.unrealizedPnl,
    equity: metrics.equity,
    marginUsed: metrics.initialMargin,
    freeMargin: metrics.freeMargin,
    availableMargin: metrics.availableMargin,
    maintenanceMargin: metrics.maintenanceMargin,
    reservedMargin: metrics.reservedMargin,
    grossExposure: metrics.grossExposure,
    grossExposureLimit: metrics.equity.mul(inputs.grossExposureMultiple),
    grossExposureMultiple: inputs.grossExposureMultiple,
    overCap: isOverCap(metrics, inputs.grossExposureMultiple),
    positionMode: inputs.positionMode,
    positions: views,
  };
}

// Builds a live view of an account in one call (database read + live marks).
export async function computeAccountSnapshot(tx: Tx, accountId: string): Promise<AccountSnapshot> {
  return computeSnapshot(await loadAccountInputs(tx, accountId));
}

// JSON shape of the account overview, shared by GET /accounts/:id and the /ws/account stream.
export function presentAccountOverview(
  meta: { id: string; stage: AccountStage; status: AccountStatus; startingBalance: Decimal.Value },
  snapshot: AccountSnapshot,
) {
  return {
    id: meta.id,
    stage: meta.stage,
    status: meta.status,
    positionMode: snapshot.positionMode,
    startingBalance: new Decimal(meta.startingBalance).toString(),
    balance: snapshot.balance.toString(),
    unrealizedPnl: snapshot.unrealizedPnl.toString(),
    equity: snapshot.equity.toString(),
    marginUsed: snapshot.marginUsed.toString(),
    reservedMargin: snapshot.reservedMargin.toString(),
    freeMargin: snapshot.freeMargin.toString(),
    availableMargin: snapshot.availableMargin.toString(),
    maintenanceMargin: snapshot.maintenanceMargin.toString(),
    // Older name of maintenanceMargin, kept so existing clients keep working
    maintenanceMarginRef: snapshot.maintenanceMargin.toString(),
    grossExposure: snapshot.grossExposure.toString(),
    grossExposureLimit: snapshot.grossExposureLimit.toString(),
    grossExposureMultiple: snapshot.grossExposureMultiple,
    overCap: snapshot.overCap,
    positions: snapshot.positions.map((p) => ({
      id: p.positionId,
      symbol: p.symbol,
      side: p.side,
      size: p.size.toString(),
      entryPrice: p.entryPrice.toString(),
      markPrice: p.markPrice.toString(),
      notional: p.notional.toString(),
      leverage: p.leverage,
      margin: p.margin.toString(),
      maintenanceMargin: p.maintenanceMargin.toString(),
      maintenanceMarginRef: p.maintenanceMargin.toString(),
      unrealizedPnl: p.unrealizedPnl.toString(),
      liquidationPrice: null,
    })),
  };
}