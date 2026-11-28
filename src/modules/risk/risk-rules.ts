import Decimal from 'decimal.js';

// =====================================================================
// Pure risk rules (no database, no network, no clock).
// Source: Perpeye Trading Terminal v1.0 Complete Implementation Specification (23 Nov 2026), sections 8, 10 and 14.
//
//   Daily allowance      = DailyLossRate x max(StartingTP, UTC day-start REALIZED balance)
//   Daily equity floor   = UTC day-start REALIZED balance - Daily allowance
//   Static drawdown floor= StartingTP x (1 - StaticDDRate)          (never trails the equity)
//   Hard breach          = Equity <= max(Daily floor, Static floor)  (equality FAILS the account)
//   Evaluation target    = StartingTP x (1 + target rate); passed only when the NET settled balance
//                          (after the exit fees of the closing fills) is >= the target and there is no breach.
//
// All rates are stored as plain percentages (3 means 3 percent).
// =====================================================================

export type BreachType = 'DAILY_LOSS' | 'MAX_DRAWDOWN';

const HUNDRED = new Decimal(100);

export interface RiskFloorInput {
  // Starting Trading Power of the account
  startingBalance: Decimal;
  // Realized balance at the last UTC day start (open PnL is NOT part of it)
  dayStartBalance: Decimal;
  dailyLossPct: Decimal;
  maxDrawdownPct: Decimal;
}

export interface RiskFloors {
  dailyAllowance: Decimal;
  dailyFloor: Decimal;
  staticFloor: Decimal;
  // The tighter (higher) of the two floors: the account fails when equity reaches it
  effectiveFloor: Decimal;
  // The floor that is the effective one. When both are equal the static floor is reported.
  bindingRule: BreachType;
}

export function computeFloors(input: RiskFloorInput): RiskFloors {
  const allowanceBase = Decimal.max(input.startingBalance, input.dayStartBalance);
  const dailyAllowance = allowanceBase.mul(input.dailyLossPct).div(HUNDRED);
  const dailyFloor = input.dayStartBalance.minus(dailyAllowance);
  const staticFloor = input.startingBalance.minus(input.startingBalance.mul(input.maxDrawdownPct).div(HUNDRED));

  const staticBinds = staticFloor.gte(dailyFloor);
  return {
    dailyAllowance,
    dailyFloor,
    staticFloor,
    effectiveFloor: staticBinds ? staticFloor : dailyFloor,
    bindingRule: staticBinds ? 'MAX_DRAWDOWN' : 'DAILY_LOSS',
  };
}

// Hard breach: equity at or below the effective floor (equality counts).
export const isHardBreach = (equity: Decimal, floors: RiskFloors): boolean => equity.lte(floors.effectiveFloor);

export interface RiskInput extends RiskFloorInput {
  stage: 'CHALLENGE' | 'FUNDED';
  equity: Decimal;
  // Profit target in percent of the Starting Trading Power. 0 = no evaluation target (Instant).
  profitTargetPct: Decimal;
  // Taker fees that closing every open position at the current marks would cost (0 when flat).
  // A target is only reached when the equity still covers it AFTER these exit fees.
  estimatedExitFees?: Decimal;
}

export interface RiskResult extends RiskFloors {
  // Loss since the UTC day start (0 when the equity is above the day-start balance)
  dailyLoss: Decimal;
  // Same value as dailyAllowance (name kept for existing callers)
  dailyLossLimit: Decimal;
  // Loss below the Starting Trading Power (0 when the equity is above it)
  drawdown: Decimal;
  // Starting Trading Power x static drawdown rate
  drawdownLimit: Decimal;
  // Equity room above each floor (negative = the floor is crossed)
  dailyRoom: Decimal;
  staticRoom: Decimal;
  riskRoom: Decimal;
  // Equity minus Starting Trading Power
  profit: Decimal;
  // Target profit in dollars and the balance that has to be reached
  profitTarget: Decimal;
  targetBalance: Decimal;
  // True only for a challenge with a target above zero
  targetEnabled: boolean;
  // Equity after the estimated exit fees
  netProjected: Decimal;
  // 0 to 100, based on the net projection
  targetProgressPct: Decimal;
  breach: BreachType | null;
  // The net projection (after exit fees) has reached the target and there is no breach.
  // The final decision is taken on the settled balance, see isTargetSettled().
  targetReached: boolean;
}

export function evaluateRisk(input: RiskInput): RiskResult {
  const floors = computeFloors(input);
  const equity = input.equity;

  const breach: BreachType | null = isHardBreach(equity, floors) ? floors.bindingRule : null;

  const profitTarget = input.startingBalance.mul(input.profitTargetPct).div(HUNDRED);
  const targetBalance = input.startingBalance.plus(profitTarget);
  const targetEnabled = input.stage === 'CHALLENGE' && input.profitTargetPct.gt(0);
  const netProjected = equity.minus(input.estimatedExitFees ?? new Decimal(0));

  let targetProgressPct = new Decimal(0);
  if (targetEnabled && profitTarget.gt(0)) {
    targetProgressPct = Decimal.min(HUNDRED, Decimal.max(0, netProjected.minus(input.startingBalance).div(profitTarget).mul(HUNDRED)));
  }

  return {
    ...floors,
    dailyLoss: Decimal.max(0, input.dayStartBalance.minus(equity)),
    dailyLossLimit: floors.dailyAllowance,
    drawdown: Decimal.max(0, input.startingBalance.minus(equity)),
    drawdownLimit: input.startingBalance.mul(input.maxDrawdownPct).div(HUNDRED),
    dailyRoom: equity.minus(floors.dailyFloor),
    staticRoom: equity.minus(floors.staticFloor),
    riskRoom: equity.minus(floors.effectiveFloor),
    profit: equity.minus(input.startingBalance),
    profitTarget,
    targetBalance,
    targetEnabled,
    netProjected,
    targetProgressPct,
    breach,
    targetReached: targetEnabled && !breach && netProjected.gte(targetBalance),
  };
}

// Final pass test: the NET SETTLED balance (every position closed, every exit fee booked) must reach the target.
export const isTargetSettled = (settledBalance: Decimal, targetBalance: Decimal): boolean => settledBalance.gte(targetBalance);

// Which floors the equity has reached (both can be true on the same event; the breach record keeps both observed values).
export const floorHits = (equity: Decimal, floors: RiskFloors) => ({
  daily: equity.lte(floors.dailyFloor),
  static: equity.lte(floors.staticFloor),
});

// ---- Technical breach review (Rulebook PE-1.1) ----
export const BREACH_REVIEW_WINDOW_HOURS = 72;
export const reviewDeadlineOf = (breachedAt: Date): Date => new Date(breachedAt.getTime() + BREACH_REVIEW_WINDOW_HOURS * 3_600_000);

// ---- Daily reset boundary ----
// The UTC trading date (00:00 UTC of that day) a boundary belongs to. Key of the daily risk snapshot.
export const tradingDateOf = (boundary: Date): Date => new Date(Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth(), boundary.getUTCDate()));

// Latest "hourUtc:00:00 UTC" that is not after "now". The daily loss baseline snaps at this moment.
export function latestResetBoundary(now: Date, hourUtc: number): Date {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (boundary.getTime() > now.getTime()) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary;
}