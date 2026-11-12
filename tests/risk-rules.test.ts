import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { evaluateRisk, type RiskInput } from '../src/modules/risk/risk-rules';

const d = (v: Decimal.Value) => new Decimal(v);

const base: RiskInput = {
  stage: 'CHALLENGE',
  startingBalance: d(10000),
  equity: d(10000),
  highWaterMark: d(10000),
  dayStartBalance: d(10000),
  dayStartEquity: d(10000),
  dailyLossPct: d(5),
  maxDrawdownPct: d(10),
  profitTargetPct: d(8),
  dailyLossMethod: 'BALANCE_BASED',
  drawdownType: 'STATIC',
};

describe('evaluateRisk', () => {
  it('has no breach at the start', () => {
    const r = evaluateRisk(base);
    expect(r.breach).toBeNull();
    expect(r.targetReached).toBe(false);
  });

  it('breaches the daily loss limit', () => {
    const r = evaluateRisk({ ...base, equity: d(9500), dayStartBalance: d(10000) });
    expect(r.breach).toBe('DAILY_LOSS');
  });

  it('breaches max drawdown first when both are exceeded', () => {
    const r = evaluateRisk({ ...base, equity: d(9000) });
    expect(r.breach).toBe('MAX_DRAWDOWN');
  });

  it('uses the peak for trailing drawdown', () => {
    const input = { ...base, equity: d(10900), highWaterMark: d(12000), drawdownType: 'TRAILING' as const };
    // 12000 - 10900 = 1100 >= 1000 limit
    expect(evaluateRisk(input).breach).toBe('MAX_DRAWDOWN');
    // Static drawdown ignores the peak, so no breach here
    expect(evaluateRisk({ ...input, drawdownType: 'STATIC' }).breach).toBeNull();
  });

  it('uses day-start equity for the equity based daily loss', () => {
    const input = { ...base, equity: d(10200), dayStartEquity: d(10800), dayStartBalance: d(10000) };
    expect(evaluateRisk({ ...input, dailyLossMethod: 'EQUITY_BASED' }).dailyLoss.toString()).toBe('600');
    expect(evaluateRisk({ ...input, dailyLossMethod: 'BALANCE_BASED' }).dailyLoss.toString()).toBe('0');
  });

  it('detects the profit target only in the challenge stage', () => {
    const input = { ...base, equity: d(10800) };
    expect(evaluateRisk(input).targetReached).toBe(true);
    expect(evaluateRisk({ ...input, stage: 'FUNDED' }).targetReached).toBe(false);
  });
});
