import { describe, expect, it } from 'vitest';
import { detectCopyTrading, detectCrossAccountHedge, detectLatencyAbuse, type AccountFill, type OpeningFill } from '../src/modules/risk/abuse-rules';

describe('cross-account hedge detection', () => {
  const leg = (accountId: string, side: 'LONG' | 'SHORT', userId = 'u1', marketId = 'btc') => ({ userId, accountId, marketId, symbol: marketId.toUpperCase(), side });

  it('flags a LONG and a SHORT of the same market in two accounts of one trader', () => {
    const f = detectCrossAccountHedge([leg('a', 'LONG'), leg('b', 'SHORT')]);
    expect(f).toEqual([{ userId: 'u1', symbol: 'BTC', longAccountId: 'a', shortAccountId: 'b' }]);
  });

  it('does not flag the same side, different markets or different traders', () => {
    expect(detectCrossAccountHedge([leg('a', 'LONG'), leg('b', 'LONG')])).toHaveLength(0);
    expect(detectCrossAccountHedge([leg('a', 'LONG', 'u1', 'btc'), leg('b', 'SHORT', 'u1', 'eth')])).toHaveLength(0);
    expect(detectCrossAccountHedge([leg('a', 'LONG', 'u1'), leg('b', 'SHORT', 'u2')])).toHaveLength(0);
  });
});

describe('copy trading detection', () => {
  const opts = { windowMs: 5000, minAccounts: 3, minRepeats: 3 };
  const fill = (id: string, accountId: string, at: number, side: 'LONG' | 'SHORT' = 'LONG', marketId = 'btc'): OpeningFill => ({ fillId: id, accountId, marketId, side, at });

  const burst = (t: number, tag: string) => [fill(`${tag}1`, 'a', t), fill(`${tag}2`, 'b', t + 1000), fill(`${tag}3`, 'c', t + 3000)];

  it('flags three accounts opening the same trade within 5 seconds, repeated 3 times', () => {
    const fills = [...burst(0, 'x'), ...burst(60_000, 'y'), ...burst(120_000, 'z')];
    const found = detectCopyTrading(fills, opts);
    expect(found).toHaveLength(1);
    expect(found[0].accountIds).toEqual(['a', 'b', 'c']);
    expect(found[0].occurrences).toBe(3);
  });

  it('does not flag a pattern that happened only twice', () => {
    expect(detectCopyTrading([...burst(0, 'x'), ...burst(60_000, 'y')], opts)).toHaveLength(0);
  });

  it('does not flag fills that are further apart than the window or on opposite sides', () => {
    const slow = [0, 60_000, 120_000].flatMap((t, i) => [fill(`s${i}1`, 'a', t), fill(`s${i}2`, 'b', t + 6000), fill(`s${i}3`, 'c', t + 12_000)]);
    expect(detectCopyTrading(slow, opts)).toHaveLength(0);
    const opposite = [0, 60_000, 120_000].flatMap((t, i) => [fill(`o${i}1`, 'a', t, 'LONG'), fill(`o${i}2`, 'b', t + 1000, 'SHORT'), fill(`o${i}3`, 'c', t + 2000, 'LONG')]);
    expect(detectCopyTrading(opposite, opts)).toHaveLength(0);
  });
});

describe('latency abuse detection', () => {
  const opts = { maxAvgHoldMs: 30_000, minWinRatePct: 80, minCloses: 20 };

  // n round trips of `holdMs`, `wins` of them profitable
  const trades = (n: number, holdMs: number, wins: number): AccountFill[] => {
    const out: AccountFill[] = [];
    for (let i = 0; i < n; i++) {
      const t = i * 120_000;
      out.push({ at: t, marketId: 'btc', side: 'LONG', opening: true, result: 0 });
      out.push({ at: t + holdMs, marketId: 'btc', side: 'LONG', opening: false, result: i < wins ? 1 : -1 });
    }
    return out;
  };

  it('flags an average hold under 30 seconds with a win rate above 80 percent', () => {
    const f = detectLatencyAbuse(trades(25, 10_000, 23), opts);
    expect(f).not.toBeNull();
    expect(f!.closes).toBe(25);
    expect(f!.avgHoldSeconds).toBe(10);
    expect(f!.winRatePct).toBe(92);
  });

  it('does not flag long holds, a normal win rate or too few trades', () => {
    expect(detectLatencyAbuse(trades(25, 120_000, 23), opts)).toBeNull();
    expect(detectLatencyAbuse(trades(25, 10_000, 12), opts)).toBeNull();
    expect(detectLatencyAbuse(trades(10, 10_000, 10), opts)).toBeNull();
  });
});