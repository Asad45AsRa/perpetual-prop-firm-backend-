import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { isMarketable, isTriggered, restingLimitCrossed, triggerDirection } from '../src/modules/trading/engine/matching';
import { classifyOrder } from '../src/modules/trading/engine/positions';

const d = (v: Decimal.Value) => new Decimal(v);
const q = (bid: number | null, ask: number | null, mark: number | null) => ({
  bid: bid == null ? null : d(bid),
  ask: ask == null ? null : d(ask),
  mark: mark == null ? null : d(mark),
});

describe('limit order eligibility', () => {
  it('is marketable when it crosses the opposite best price', () => {
    expect(isMarketable('BUY', d(90020), q(89990, 90000, 90000))).toBe(true);
    expect(isMarketable('BUY', d(90000), q(89990, 90100, 90000))).toBe(false);
    expect(isMarketable('SELL', d(89990), q(89990, 90000, 90000))).toBe(true);
  });

  it('fills a resting buy only when the ASK touches the limit, mark alone is not enough', () => {
    expect(restingLimitCrossed('BUY', d(90000), q(89995, 90005, 89950), false)).toBe(false);
    expect(restingLimitCrossed('BUY', d(90000), q(89995, 90000, 89950), false)).toBe(true);
  });

  it('needs the mark on the right side too when the market requires mark confirmation', () => {
    expect(restingLimitCrossed('BUY', d(90000), q(89995, 90000, 90010), true)).toBe(false);
    expect(restingLimitCrossed('BUY', d(90000), q(89995, 90000, 89990), true)).toBe(true);
    expect(restingLimitCrossed('SELL', d(90100), q(90100, 90110, 90090), true)).toBe(false);
  });
});

describe('trigger rules', () => {
  it('knows which way each trigger order fires', () => {
    expect(triggerDirection('STOP_MARKET', 'BUY')).toBe('UP');
    expect(triggerDirection('STOP_MARKET', 'SELL')).toBe('DOWN');
    expect(triggerDirection('TAKE_PROFIT', 'SELL')).toBe('UP'); // closes a long
    expect(triggerDirection('TAKE_PROFIT', 'BUY')).toBe('DOWN'); // closes a short
    expect(triggerDirection('STOP_LOSS', 'SELL')).toBe('DOWN');
    expect(triggerDirection('STOP_LOSS', 'BUY')).toBe('UP');
  });

  it('long stop loss fires on the mark OR on the bid touching the level', () => {
    expect(isTriggered('STOP_LOSS', 'SELL', d(89000), q(89500, 89510, 90000))).toBe(false);
    expect(isTriggered('STOP_LOSS', 'SELL', d(89000), q(89000, 89010, 89500))).toBe(true); // bid touch
    expect(isTriggered('STOP_LOSS', 'SELL', d(89000), q(89500, 89510, 89000))).toBe(true); // mark touch
  });

  it('long take profit fires when the bid touches, even if the mark is lower', () => {
    expect(isTriggered('TAKE_PROFIT', 'SELL', d(91000), q(91000, 91010, 90990))).toBe(true);
  });

  it('short take profit uses the ask, short stop loss uses the ask going up', () => {
    expect(isTriggered('TAKE_PROFIT', 'BUY', d(89000), q(88990, 89000, 89500))).toBe(true);
    expect(isTriggered('STOP_LOSS', 'BUY', d(91000), q(90990, 91000, 90500))).toBe(true);
    expect(isTriggered('STOP_LOSS', 'BUY', d(91000), q(90000, 90010, 90500))).toBe(false);
  });

  it('a buy stop entry fires on a rise', () => {
    expect(isTriggered('STOP_MARKET', 'BUY', d(91000), q(90990, 91000, 90500))).toBe(true);
    expect(isTriggered('STOP_MARKET', 'BUY', d(91000), q(90000, 90010, 90005))).toBe(false);
  });
});

describe('position mode classification', () => {
  const long = (n: string) => ({ side: 'LONG' as const, size: d(n) });
  const short = (n: string) => ({ side: 'SHORT' as const, size: d(n) });

  it('one-way: an opposite order reduces the position', () => {
    const c = classifyOrder('ONE_WAY', 'SELL', null, long('1'), null, d('0.4'));
    expect(c.closeSide).toBe('LONG');
    expect(c.closeSize.toString()).toBe('0.4');
    expect(c.openSize.toString()).toBe('0');
  });

  it('one-way: a larger opposite order closes and reverses', () => {
    const c = classifyOrder('ONE_WAY', 'SELL', null, long('1'), null, d('1.4'));
    expect(c.closeSize.toString()).toBe('1');
    expect(c.openSide).toBe('SHORT');
    expect(c.openSize.toString()).toBe('0.4');
  });

  it('one-way: the same direction adds', () => {
    const c = classifyOrder('ONE_WAY', 'BUY', null, long('1'), null, d('2'));
    expect(c.closeSize.toString()).toBe('0');
    expect(c.openSide).toBe('LONG');
    expect(c.openSize.toString()).toBe('2');
  });

  it('hedge: SELL + SHORT opens an independent short next to the long', () => {
    const c = classifyOrder('HEDGE', 'SELL', 'SHORT', long('1'), null, d('0.4'));
    expect(c.closeSize.toString()).toBe('0');
    expect(c.openSide).toBe('SHORT');
    expect(c.openSize.toString()).toBe('0.4');
  });

  it('hedge: SELL + LONG only reduces the long and never opens a short', () => {
    const c = classifyOrder('HEDGE', 'SELL', 'LONG', long('1'), short('2'), d('0.4'));
    expect(c.closeSide).toBe('LONG');
    expect(c.openSize.toString()).toBe('0');
    expect(classifyOrder('HEDGE', 'SELL', 'LONG', long('1'), null, d('1.2')).exceedsLeg).toBe(true);
  });
});
