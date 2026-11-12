import Decimal from 'decimal.js';

// =====================================================================
// Pure risk rules (daily loss, max drawdown, profit target).
// The exact calculation methods must be confirmed with the client, so
// both variants are supported and chosen per plan:
//   dailyLossMethod: BALANCE_BASED | EQUITY_BASED
//   drawdownType   : STATIC (from starting balance) | TRAILING (from peak)
// =====================================================================

export interface RiskInput {
  stage: 'CHALLENGE' | 'FUNDED';
  startingBalance: Decimal;
  equity: Decimal;
  highWaterMark: Decimal;
  dayStartBalance: Decimal;
  dayStartEquity: Decimal;
  dailyLossPct: Decimal;
  maxDrawdownPct: Decimal;
  profitTargetPct: Decimal;
  dailyLossMethod: 'BALANCE_BASED' | 'EQUITY_BASED';
  drawdownType: 'STATIC' | 'TRAILING';
}

export type BreachType = 'DAILY_LOSS' | 'MAX_DRAWDOWN';

export interface RiskResult {
  dailyLoss: Decimal;
  dailyLossLimit: Decimal;
  drawdown: Decimal;
  drawdownLimit: Decimal;
  profit: Decimal;
  profitTarget: Decimal;
  breach: BreachType | null;
  // Only meaningful for the challenge stage
  targetReached: boolean;
}

export function evaluateRisk(input: RiskInput): RiskResult {
  const hundred = new Decimal(100);

  const dailyReference =
    input.dailyLossMethod === 'EQUITY_BASED' ? input.dayStartEquity : input.dayStartBalance;
  const dailyLoss = Decimal.max(0, dailyReference.minus(input.equity));
  const dailyLossLimit = input.startingBalance.mul(input.dailyLossPct).div(hundred);

  const drawdownReference =
    input.drawdownType === 'TRAILING' ? input.highWaterMark : input.startingBalance;
  const drawdown = Decimal.max(0, drawdownReference.minus(input.equity));
  const drawdownLimit = input.startingBalance.mul(input.maxDrawdownPct).div(hundred);

  const profit = input.equity.minus(input.startingBalance);
  const profitTarget = input.startingBalance.mul(input.profitTargetPct).div(hundred);

  // Max drawdown is checked first because it is the stricter, permanent rule.
  let breach: BreachType | null = null;
  if (drawdown.gte(drawdownLimit)) breach = 'MAX_DRAWDOWN';
  else if (dailyLoss.gte(dailyLossLimit)) breach = 'DAILY_LOSS';

  return {
    dailyLoss,
    dailyLossLimit,
    drawdown,
    drawdownLimit,
    profit,
    profitTarget,
    breach,
    targetReached: input.stage === 'CHALLENGE' && !breach && profit.gte(profitTarget),
  };
}
