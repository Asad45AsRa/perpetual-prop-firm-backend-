import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { Decimal, toD } from '../../utils/decimal';
import { evaluateAccount } from '../risk/risk.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { fundingCashflow } from '../trading/engine/calculations';
import { roundLedger } from '../trading/engine/fees';
import { lockAccount } from '../trading/order-engine';
import { fetchFundingHistory, fetchMetaAndAssetCtxs } from './hyperliquid.client';
import { priceFeed } from './price-feed';

// =====================================================================
// Hourly funding, matched to Hyperliquid:
//  * Funding is paid on every UTC hour boundary to positions that are STILL OPEN at that instant,
//    with NO pro-rata. Open 10:59:59 and still open at 11:00 = full payment. Closed before = nothing.
//  * amount = -(signed size) x oracle price x hourly rate. Positive rate: longs pay, shorts receive.
//  * Two steps: (1) at the boundary every open position gets a pending row (size + oracle price),
//    (2) when the official rate is known the cash flow is posted to the ledger.
//    A missing rate is NEVER replaced by zero: the row stays pending and is retried.
//  * Replay safe: one row per position and hour (unique key), one ledger entry per row (idempotency key).
// =====================================================================

const HOUR_MS = 3_600_000;
// How far from the boundary a published funding timestamp may be
const RATE_MATCH_WINDOW_MS = 10 * 60_000;
// Pending rows older than this raise an error log (needs a human)
const PENDING_ALERT_MS = 3 * HOUR_MS;

export const hourStartOf = (ms: number): Date => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);

// Step 1: snapshot of the positions that are open at the boundary.
export async function captureFundingBoundary(hourStart: Date): Promise<number> {
  const positions = await prisma.position.findMany({
    where: { size: { gt: 0 }, market: { fundingSupported: true } },
    include: { market: { select: { symbol: true, hlKey: true } } },
  });
  if (positions.length === 0) return 0;

  // Oracle price: the live feed, or one REST call when the feed has no fresh value
  const oracleBySymbol = new Map<string, Decimal>();
  const missing = positions.filter((p) => !priceFeed.isMarkFresh(p.market.symbol));
  for (const p of positions) {
    const live = priceFeed.isMarkFresh(p.market.symbol) ? priceFeed.getMark(p.market.symbol) : undefined;
    if (live) oracleBySymbol.set(p.market.symbol, live.oracle);
  }
  if (missing.length > 0) {
    try {
      const { ctxs } = await fetchMetaAndAssetCtxs();
      for (const p of missing) {
        const ctx = ctxs.get(p.market.hlKey);
        if (ctx) oracleBySymbol.set(p.market.symbol, new Decimal(ctx.oraclePx));
      }
    } catch (err) {
      logger.warn({ err }, 'Could not load oracle prices for funding, rows stay without oracle');
    }
  }

  const result = await prisma.fundingPayment.createMany({
    data: positions.map((p) => ({
      accountId: p.accountId,
      positionId: p.id,
      marketId: p.marketId,
      hourStart,
      side: p.side,
      size: p.size,
      oraclePrice: oracleBySymbol.get(p.market.symbol)?.toFixed() ?? null,
    })),
    skipDuplicates: true,
  });
  logger.info({ hourStart: hourStart.toISOString(), created: result.count }, 'Funding boundary captured');
  return result.count;
}

// Stores the official rate of one market and hour when it is known. Returns it (or null).
async function ensureRate(market: { id: string; hlKey: string }, hourStart: Date): Promise<Decimal | null> {
  const stored = await prisma.fundingRate.findUnique({ where: { marketId_hourStart: { marketId: market.id, hourStart } } });
  if (stored) return toD(stored.rate);

  const start = hourStart.getTime();
  const history = await fetchFundingHistory(market.hlKey, start - RATE_MATCH_WINDOW_MS, start + RATE_MATCH_WINDOW_MS);
  // The entry closest to the boundary
  const entry = history
    .filter((e) => Math.abs(e.time - start) <= RATE_MATCH_WINDOW_MS)
    .sort((a, b) => Math.abs(a.time - start) - Math.abs(b.time - start))[0];
  if (!entry) return null;

  await prisma.fundingRate.createMany({ data: [{ marketId: market.id, hourStart, rate: entry.fundingRate }], skipDuplicates: true });
  return new Decimal(entry.fundingRate);
}

// Step 2: post every pending funding row whose rate and oracle price are known.
export async function applyPendingFunding(now = Date.now()): Promise<number> {
  // Give Hyperliquid a few seconds to publish the rate of the hour that just ended
  const cutoff = new Date(now - 5_000);
  const pending = await prisma.fundingPayment.findMany({
    where: { appliedAt: null, hourStart: { lte: cutoff } },
    include: { market: { select: { id: true, hlKey: true, symbol: true } } },
    orderBy: { hourStart: 'asc' },
    take: 500,
  });

  const rates = new Map<string, Decimal | null>();
  const touched = new Set<string>();
  let applied = 0;

  for (const row of pending) {
    const key = `${row.marketId}:${row.hourStart.toISOString()}`;
    if (!rates.has(key)) {
      try {
        rates.set(key, await ensureRate(row.market, row.hourStart));
      } catch (err) {
        logger.warn({ err, symbol: row.market.symbol }, 'Could not load the funding rate');
        rates.set(key, null);
      }
    }
    const rate = rates.get(key);

    if (!rate || !row.oraclePrice) {
      if (now - row.hourStart.getTime() > PENDING_ALERT_MS) {
        logger.error({ paymentId: row.id, symbol: row.market.symbol, hourStart: row.hourStart, hasRate: !!rate, hasOracle: !!row.oraclePrice }, 'FUNDING STILL PENDING, needs review');
      }
      continue;
    }

    const amount = roundLedger(fundingCashflow(row.side, toD(row.size), toD(row.oraclePrice), rate));

    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, row.accountId);
      // Re-read after the lock: another worker may have posted it already
      const fresh = await tx.fundingPayment.findUnique({ where: { id: row.id } });
      if (!fresh || fresh.appliedAt) return;

      if (!amount.isZero()) {
        await postLedgerEntry(tx, {
          accountId: row.accountId,
          type: 'FUNDING',
          amount,
          refType: 'funding',
          refId: row.id,
          idempotencyKey: `funding:${row.positionId}:${row.hourStart.toISOString()}`,
          description: `Funding ${row.market.symbol} ${row.hourStart.toISOString()}`,
        });
      }
      await tx.fundingPayment.update({ where: { id: row.id }, data: { rate: rate.toFixed(), amount: amount.toFixed(), appliedAt: new Date() } });
    });
    touched.add(row.accountId);
    applied++;
  }

  // A funding charge can push equity to a floor: check the account rules afterwards
  for (const accountId of touched) await evaluateAccount(accountId).catch((err) => logger.error({ err, accountId }, 'Risk check after funding failed'));
  if (applied > 0) logger.info({ applied }, 'Funding applied');
  return applied;
}
