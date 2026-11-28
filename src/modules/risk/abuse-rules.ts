export type Side = 'LONG' | 'SHORT';

// ---------------------------------------------------------------------
// 1) Hedging between accounts of the same trader
// ---------------------------------------------------------------------
export interface OpenLeg {
  userId: string;
  accountId: string;
  marketId: string;
  symbol: string;
  side: Side;
}

export interface HedgeFinding {
  userId: string;
  symbol: string;
  longAccountId: string;
  shortAccountId: string;
}

// A trader holds a LONG in one account and a SHORT in another account on the same market: the pair is risk free for the
// trader and a certain cost for the firm.
export function detectCrossAccountHedge(legs: OpenLeg[]): HedgeFinding[] {
  const byKey = new Map<string, { longs: Set<string>; shorts: Set<string>; symbol: string; userId: string }>();
  for (const l of legs) {
    const key = `${l.userId}|${l.marketId}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { longs: new Set(), shorts: new Set(), symbol: l.symbol, userId: l.userId }));
    (l.side === 'LONG' ? e.longs : e.shorts).add(l.accountId);
  }
  const out: HedgeFinding[] = [];
  for (const e of byKey.values()) {
    for (const longAccountId of e.longs) {
      for (const shortAccountId of e.shorts) {
        if (longAccountId !== shortAccountId) out.push({ userId: e.userId, symbol: e.symbol, longAccountId, shortAccountId });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// 2) Copy trading: several accounts open the same trade within a few seconds, again and again
// ---------------------------------------------------------------------
export interface OpeningFill {
  fillId: string;
  accountId: string;
  marketId: string;
  side: Side;
  // Epoch milliseconds
  at: number;
}

export interface CopyTradingFinding {
  accountIds: string[];
  // How often this group traded together
  occurrences: number;
  // The first matching groups (market, side, time and fill ids), as evidence
  samples: { marketId: string; side: Side; at: number; fillIds: string[] }[];
}

export interface CopyTradingOptions {
  windowMs: number;
  minAccounts: number;
  minRepeats: number;
}

export function detectCopyTrading(fills: OpeningFill[], opts: CopyTradingOptions): CopyTradingFinding[] {
  const groups = new Map<string, OpeningFill[]>();
  for (const f of fills) {
    const key = `${f.marketId}|${f.side}`;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }

  const byAccountSet = new Map<string, CopyTradingFinding>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < list.length) {
      // All fills inside the window that starts at fill i
      let j = i;
      const members: OpeningFill[] = [];
      while (j < list.length && list[j].at - list[i].at <= opts.windowMs) members.push(list[j++]);
      const accounts = [...new Set(members.map((m) => m.accountId))].sort();
      if (accounts.length >= opts.minAccounts) {
        const key = accounts.join(',');
        let f = byAccountSet.get(key);
        if (!f) byAccountSet.set(key, (f = { accountIds: accounts, occurrences: 0, samples: [] }));
        f.occurrences++;
        if (f.samples.length < 10) f.samples.push({ marketId: list[i].marketId, side: list[i].side, at: list[i].at, fillIds: members.map((m) => m.fillId) });
        i = j; // the cluster is used up
      } else {
        i++;
      }
    }
  }
  return [...byAccountSet.values()].filter((f) => f.occurrences >= opts.minRepeats);
}

// ---------------------------------------------------------------------
// 3) Latency abuse: very short holds with an unnatural win rate
// ---------------------------------------------------------------------
export interface AccountFill {
  at: number;
  marketId: string;
  side: Side;
  // True when the fill opens or increases the position
  opening: boolean;
  // -1 loss, 0 no result (opening fill), 1 win (closing fills only carry a result)
  result: -1 | 0 | 1;
}

export interface LatencyOptions {
  maxAvgHoldMs: number;
  minWinRatePct: number;
  minCloses: number;
}

export interface LatencyFinding {
  closes: number;
  avgHoldSeconds: number;
  winRatePct: number;
}

// The fills of ONE account, any order. The hold time of a close is measured from the latest opening fill of the same
// market and side (the shortest plausible hold, so a scalper is not hidden by an earlier entry).
export function detectLatencyAbuse(fills: AccountFill[], opts: LatencyOptions): LatencyFinding | null {
  const sorted = [...fills].sort((a, b) => a.at - b.at);
  const lastOpen = new Map<string, number>();
  let closes = 0;
  let wins = 0;
  let holdTotal = 0;
  for (const f of sorted) {
    const key = `${f.marketId}|${f.side}`;
    if (f.opening) {
      lastOpen.set(key, f.at);
    } else if (f.result !== 0) {
      const opened = lastOpen.get(key);
      if (opened === undefined) continue;
      closes++;
      holdTotal += f.at - opened;
      if (f.result === 1) wins++;
    }
  }
  if (closes < opts.minCloses) return null;
  const avgHold = holdTotal / closes;
  const winRate = (wins / closes) * 100;
  if (avgHold < opts.maxAvgHoldMs && winRate > opts.minWinRatePct) {
    return { closes, avgHoldSeconds: Math.round(avgHold / 100) / 10, winRatePct: Math.round(winRate * 10) / 10 };
  }
  return null;
}