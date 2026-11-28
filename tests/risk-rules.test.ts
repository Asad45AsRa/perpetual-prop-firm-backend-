import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeFloors, evaluateRisk, floorHits, isHardBreach, isTargetSettled, latestResetBoundary, reviewDeadlineOf, tradingDateOf, type RiskInput } from '../src/modules/risk/risk-rules';

const d = (v: Decimal.Value) => new Decimal(v);

// Elite model of the spec: $100 deposit x 120 = $12,000 Starting Trading Power, 10% target, 3% daily loss, 6% static drawdown
const elite: RiskInput = {
  stage: 'CHALLENGE',
  startingBalance: d(12000),
  dayStartBalance: d(12000),
  equity: d(12000),
  dailyLossPct: d(3),
  maxDrawdownPct: d(6),
  profitTargetPct: d(10),
};

describe('risk floors (spec section 10)', () => {
  it('TC-001 / TC-068: Elite first-day floors', () => {
    const f = computeFloors(elite);
    expect(f.dailyAllowance.toString()).toBe('360');
    expect(f.dailyFloor.toString()).toBe('11640');
    expect(f.staticFloor.toString()).toBe('11280');
    // The daily floor is the tighter one on day one
    expect(f.effectiveFloor.toString()).toBe('11640');
    expect(f.bindingRule).toBe('DAILY_LOSS');
  });

  it('TC-069: day-start balance above the starting power raises the allowance base and the floor', () => {
    const f = computeFloors({ ...elite, dayStartBalance: d(13000) });
    expect(f.dailyAllowance.toString()).toBe('390');
    expect(f.dailyFloor.toString()).toBe('12610');
  });

  it('TC-070: day-start balance below the starting power uses the starting power as the allowance base, static floor is tighter', () => {
    const f = computeFloors({ ...elite, dayStartBalance: d(11600) });
    expect(f.dailyAllowance.toString()).toBe('360');
    expect(f.dailyFloor.toString()).toBe('11240');
    expect(f.staticFloor.toString()).toBe('11280');
    expect(f.effectiveFloor.toString()).toBe('11280');
    expect(f.bindingRule).toBe('MAX_DRAWDOWN');
  });

  it('TC-073: the static floor never trails the equity', () => {
    const f = computeFloors({ ...elite, dayStartBalance: d(15000) });
    expect(f.staticFloor.toString()).toBe('11280');
  });

  it('TC-074: Breeze (S 8000, 4 percent daily, 7 percent drawdown)', () => {
    const f = computeFloors({ ...elite, startingBalance: d(8000), dayStartBalance: d(8000), dailyLossPct: d(4), maxDrawdownPct: d(7) });
    expect(f.dailyFloor.toString()).toBe('7680');
    expect(f.staticFloor.toString()).toBe('7440');
  });

  it('TC-075: Instant (S 4000, 3 percent daily, 6 percent drawdown)', () => {
    const f = computeFloors({ ...elite, startingBalance: d(4000), dayStartBalance: d(4000), dailyLossPct: d(3), maxDrawdownPct: d(6) });
    expect(f.dailyFloor.toString()).toBe('3880');
    expect(f.staticFloor.toString()).toBe('3760');
  });

  it('TC-082 / TC-117: the daily floor is rebased from the remaining balance after a payout reserve', () => {
    const f = computeFloors({ ...elite, dayStartBalance: d(12500) });
    expect(f.dailyFloor.toString()).toBe('12125');
    expect(f.staticFloor.toString()).toBe('11280');
  });
});

describe('hard breach (equality fails)', () => {
  it('TC-071: equity exactly on the floor breaches', () => {
    const r = evaluateRisk({ ...elite, equity: d(11640) });
    expect(r.breach).toBe('DAILY_LOSS');
  });

  it('TC-072: one cent above the floor is healthy', () => {
    expect(evaluateRisk({ ...elite, equity: d('11640.01') }).breach).toBeNull();
    expect(isHardBreach(d('11640.01'), computeFloors(elite))).toBe(false);
  });

  it('reports the static rule when the static floor is the binding one', () => {
    const r = evaluateRisk({ ...elite, dayStartBalance: d(11600), equity: d(11280) });
    expect(r.breach).toBe('MAX_DRAWDOWN');
  });

  it('exposes the room above each floor', () => {
    const r = evaluateRisk({ ...elite, equity: d(11900) });
    expect(r.dailyRoom.toString()).toBe('260');
    expect(r.staticRoom.toString()).toBe('620');
    expect(r.riskRoom.toString()).toBe('260');
  });

  it('TC-076: a breach on the same event wins over the target', () => {
    // Equity at the target would normally pass, but a floor at or above it is a breach first
    const r = evaluateRisk({ ...elite, dayStartBalance: d(14000), equity: d(13200) });
    expect(r.breach).not.toBeNull();
    expect(r.targetReached).toBe(false);
  });
});

describe('profit target (net of exit fees)', () => {
  it('target balance is the starting power x (1 + target rate)', () => {
    const r = evaluateRisk(elite);
    expect(r.profitTarget.toString()).toBe('1200');
    expect(r.targetBalance.toString()).toBe('13200');
  });

  it('TC-077: $1,200 of profit that is only $1,196 after the exit fees does not pass', () => {
    const r = evaluateRisk({ ...elite, equity: d(13200), estimatedExitFees: d(4) });
    expect(r.netProjected.toString()).toBe('13196');
    expect(r.targetReached).toBe(false);
  });

  it('TC-078: the net projection at or above the target is a pass candidate', () => {
    expect(evaluateRisk({ ...elite, equity: d(13204), estimatedExitFees: d(4) }).targetReached).toBe(true);
    expect(evaluateRisk({ ...elite, equity: d(13200) }).targetReached).toBe(true);
  });

  it('the final decision uses the settled balance', () => {
    expect(isTargetSettled(d('13199.999999'), d(13200))).toBe(false);
    expect(isTargetSettled(d(13200), d(13200))).toBe(true);
  });

  it('only a challenge with a target above zero can pass (Instant has no target)', () => {
    expect(evaluateRisk({ ...elite, stage: 'FUNDED', equity: d(14000) }).targetReached).toBe(false);
    const instant = evaluateRisk({ ...elite, profitTargetPct: d(0), equity: d(14000) });
    expect(instant.targetEnabled).toBe(false);
    expect(instant.targetReached).toBe(false);
  });

  it('progress is clamped between 0 and 100 percent', () => {
    expect(evaluateRisk({ ...elite, equity: d(12600) }).targetProgressPct.toString()).toBe('50');
    expect(evaluateRisk({ ...elite, equity: d(11800) }).targetProgressPct.toString()).toBe('0');
    expect(evaluateRisk({ ...elite, equity: d(15000) }).targetProgressPct.toString()).toBe('100');
  });
});

describe('pre-trade breach projection (TC-020 / TC-080)', () => {
  it('an entry fee that takes the equity to the floor is predictable', () => {
    // Equity 11,644 and a 4 dollar entry fee: 11,640 is exactly the daily floor
    const floors = computeFloors(elite);
    expect(isHardBreach(d(11644).minus(4), floors)).toBe(true);
    expect(isHardBreach(d(11644).minus(3.99), floors)).toBe(false);
  });
});

describe('daily reset boundary (00:00 UTC)', () => {
  it('is today at the reset hour once it has passed', () => {
    expect(latestResetBoundary(new Date('2026-11-24T10:15:00Z'), 0).toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });

  it('is the previous day before the reset hour of today', () => {
    expect(latestResetBoundary(new Date('2026-11-24T10:15:00Z'), 12).toISOString()).toBe('2026-11-23T12:00:00.000Z');
  });

  it('is exact at the boundary', () => {
    expect(latestResetBoundary(new Date('2026-11-24T00:00:00Z'), 0).toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });

  it('crosses a month end', () => {
    expect(latestResetBoundary(new Date('2026-12-01T00:00:30Z'), 6).toISOString()).toBe('2026-11-30T06:00:00.000Z');
  });
});

describe('Risk Engine v1.1 additions', () => {
  it('R-078: both floors can be reached on the same event and both observations are kept', () => {
    const floors = computeFloors({ ...elite, dayStartBalance: d(11600) }); // daily 11,240, static 11,280
    expect(floorHits(d(11200), floors)).toEqual({ daily: true, static: true });
    expect(floorHits(d(11260), floors)).toEqual({ daily: false, static: true });
  });

  it('R-027: a daily floor below the static floor leaves the static floor as the effective threshold', () => {
    expect(computeFloors({ ...elite, dayStartBalance: d(11600) }).effectiveFloor.toString()).toBe('11280');
  });

  it('R-092: the daily floor after a $500 payout rebase (remaining balance 12,500)', () => {
    const f = computeFloors({ ...elite, dayStartBalance: d(12500) });
    expect(f.dailyAllowance.toString()).toBe('375');
    expect(f.dailyFloor.toString()).toBe('12125');
    expect(f.staticFloor.toString()).toBe('11280');
  });

  it('technical review deadline is exactly 72 hours after the breach', () => {
    expect(reviewDeadlineOf(new Date('2026-11-25T10:00:00.000Z')).toISOString()).toBe('2026-11-28T10:00:00.000Z');
  });

  it('R-019 / R-020: the trading date is the UTC date of the boundary, whenever the job runs', () => {
    const boundary = latestResetBoundary(new Date('2026-11-25T00:07:45Z'), 0); // a late run
    expect(boundary.toISOString()).toBe('2026-11-25T00:00:00.000Z');
    expect(tradingDateOf(boundary).toISOString()).toBe('2026-11-25T00:00:00.000Z');
    // The same date for a repeated run later the same day
    expect(tradingDateOf(latestResetBoundary(new Date('2026-11-25T18:00:00Z'), 0)).toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });

  it('R-104: an extreme gap that takes the equity below zero is a breach with the same rule', () => {
    expect(evaluateRisk({ ...elite, equity: d(-50) }).breach).not.toBeNull();
  });
});