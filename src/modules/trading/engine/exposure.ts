import Decimal from 'decimal.js';
import type { PositionSide } from './calculations';
import { unrealizedPnl } from './calculations';
import { maintenanceMargin } from './market-policy';

// =====================================================================
// Pure account metrics and pre-trade exposure checks (cross margin).
//   Equity              = balance + floating PnL (at mark price)
//   New-entry capacity  = max(0, min(balance, equity) - used margin - pending margin)
//                         (floating losses reduce it, floating GAINS never increase it)
//   Maintenance margin  = sum of |size| x mark x (0.5 / symbol max leverage) over all open legs
//   Gross exposure      = sum of |size| x mark over ALL open legs (+ worst case of resting opening orders)
// =====================================================================

export interface Leg {
  marketKey: string;
  side: PositionSide;
  size: Decimal;
  entryPrice: Decimal;
  mark: Decimal;
  // Initial margin held by this leg
  margin: Decimal;
  // Maximum leverage the symbol permits (maintenance margin does not use the leverage the trader selected)
  maxLeverage: number;
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
  // Total maintenance threshold of the account (forced close when equity falls to it)
  maintenanceMargin: Decimal;
  reservedMargin: Decimal;
  // Classic free margin: equity - initial margin - reserved (can include floating gains, display only)
  freeMargin: Decimal;
  // New-entry margin capacity before clamping (negative = the order cannot be funded)
  marginCapacityRaw: Decimal;
  // New-entry margin capacity shown to the trader: max(0, marginCapacityRaw)
  availableMargin: Decimal;
  // Open legs only
  grossExposure: Decimal;
  // Open legs + worst case of working opening orders
  grossWithOrders: Decimal;
}

const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));

export function computeMetrics(balance: Decimal, legs: Leg[], working: WorkingExposure[] = []): AccountMetrics {
  const upl = sum(legs.map((l) => unrealizedPnl(l.side, l.size, l.entryPrice, l.mark)));
  const im = sum(legs.map((l) => l.margin));
  const reserved = sum(working.map((w) => w.reserved));
  const equity = balance.plus(upl);
  const gross = sum(legs.map((l) => l.size.mul(l.mark)));
  const grossOrders = sum(working.map((w) => w.remaining.mul(w.price)));
  const maintenance = sum(legs.map((l) => maintenanceMargin(l.size.mul(l.mark), l.maxLeverage)));
  const capacityRaw = Decimal.min(balance, equity).minus(im).minus(reserved);

  return {
    balance,
    unrealizedPnl: upl,
    equity,
    initialMargin: im,
    maintenanceMargin: maintenance,
    reservedMargin: reserved,
    freeMargin: equity.minus(im).minus(reserved),
    marginCapacityRaw: capacityRaw,
    availableMargin: Decimal.max(0, capacityRaw),
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
  // Platform rule: gross exposure after the trade must stay within this multiple of the current equity
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

  // Spec: the cap is a multiple of CURRENT equity, i.e. the equity before this order (and before its fee)
  const cap = input.before.equity.mul(input.grossMultiple);
  if (input.after.grossWithOrders.gt(cap) && input.after.grossWithOrders.gt(input.before.grossWithOrders)) {
    return 'GROSS_EXPOSURE_CAP';
  }

  if (input.after.marginCapacityRaw.lt(0)) return 'INSUFFICIENT_MARGIN';
  return null;
}

// True when gross exposure is above the platform cap (UI warning "OVER_CAP"). Not an account breach.
export function isOverCap(metrics: AccountMetrics, grossMultiple: Decimal.Value): boolean {
  return metrics.grossExposure.gt(metrics.equity.mul(grossMultiple));
}