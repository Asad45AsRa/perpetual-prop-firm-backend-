import Decimal from 'decimal.js';
import type { PositionSide } from './calculations';
import { maintenanceMarginRef, unrealizedPnl } from './calculations';

// =====================================================================
// Pure account metrics and pre-trade exposure checks (cross margin).
//   Equity           = balance + floating PnL (at mark price)
//   Available margin = equity - initial margin of open positions - margin reserved by resting orders
//   Gross exposure   = sum of |size| x mark over ALL open legs (+ worst case of resting opening orders)
// =====================================================================

export interface Leg {
  marketKey: string;
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
  mark: Decimal;
  // Initial margin held by this leg
  margin: Decimal;
}

// An opening order that is still working (resting limit). Stops reserve nothing until they trigger.
export interface WorkingExposure {
  marketKey: string;
  // Direction of the exposure it would create
  side: PositionSide;
  remaining: Decimal;
  price: Decimal;
  // Margin + fee buffer held for it
  reserved: Decimal;
}

export interface AccountMetrics {
  balance: Decimal;
  unrealizedPnl: Decimal;
  equity: Decimal;
  initialMargin: Decimal;
  maintenanceMarginRef: Decimal;
  reservedMargin: Decimal;
  availableMargin: Decimal;
  // Open legs only
  grossExposure: Decimal;
  // Open legs + worst case of working opening orders
  grossWithOrders: Decimal;
}

const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));

export function computeMetrics(
  balance: Decimal,
  legs: Leg[],
  working: WorkingExposure[] = [],
  mmrFraction: Decimal.Value = '0.5',
): AccountMetrics {
  const upl = sum(legs.map((l) => unrealizedPnl(l.side, l.size, l.entryPrice, l.mark)));
  const im = sum(legs.map((l) => l.margin));
  const reserved = sum(working.map((w) => w.reserved));
  const equity = balance.plus(upl);
  const gross = sum(legs.map((l) => l.size.mul(l.mark)));
  const grossOrders = sum(working.map((w) => w.remaining.mul(w.price)));

  return {
    balance,
    unrealizedPnl: upl,
    equity,
    initialMargin: im,
    maintenanceMarginRef: maintenanceMarginRef(im, mmrFraction),
    reservedMargin: reserved,
    availableMargin: equity.minus(im).minus(reserved),
    grossExposure: gross,
    grossWithOrders: gross.plus(grossOrders),
  };
}

// Open notional for one market and side: legs at mark + working opening orders.
export function symbolSideNotional(legs: Leg[], working: WorkingExposure[], marketKey: string, side: PositionSide): Decimal {
  const legPart = sum(legs.filter((l) => l.marketKey === marketKey && l.side === side).map((l) => l.size.mul(l.mark)));
  const orderPart = sum(working.filter((w) => w.marketKey === marketKey && w.side === side).map((w) => w.remaining.mul(w.price)));
  return legPart.plus(orderPart);
}

export type ExposureRejection = 'POSITION_CAP' | 'GROSS_EXPOSURE_CAP' | 'INSUFFICIENT_MARGIN';

export interface ExposureCheckInput {
  before: AccountMetrics;
  after: AccountMetrics;
  // Platform rule: gross exposure after the trade must stay within this multiple of equity
  grossMultiple: Decimal.Value;
  // Open notional of the market + side after the trade, and its approved cap (null = no cap)
  symbolSideNotionalAfter: Decimal;
  symbolSideCap: Decimal.Value | null;
  // False for pure reductions: they are never blocked by caps or margin
  increasesExposure: boolean;
}

// Returns the reason the new exposure must be rejected, or null when it is allowed.
// An account that is already above the gross cap (because prices moved) may still reduce.
export function checkNewExposure(input: ExposureCheckInput): ExposureRejection | null {
  if (!input.increasesExposure) return null;

  if (input.symbolSideCap != null && input.symbolSideNotionalAfter.gt(input.symbolSideCap)) return 'POSITION_CAP';

  const cap = input.after.equity.mul(input.grossMultiple);
  if (input.after.grossWithOrders.gt(cap) && input.after.grossWithOrders.gt(input.before.grossWithOrders)) {
    return 'GROSS_EXPOSURE_CAP';
  }

  if (input.after.availableMargin.lt(0)) return 'INSUFFICIENT_MARGIN';
  return null;
}

// True when gross exposure is above the platform cap (UI warning "OVER_CAP"). Not an account breach.
export function isOverCap(metrics: AccountMetrics, grossMultiple: Decimal.Value): boolean {
  return metrics.grossExposure.gt(metrics.equity.mul(grossMultiple));
}
