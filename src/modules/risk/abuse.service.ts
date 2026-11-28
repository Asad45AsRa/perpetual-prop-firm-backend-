import type { AbuseFlagStatus, AbuseFlagType, Prisma } from '@prisma/client';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { audit } from '../audit/audit.service';
import { getSetting } from '../settings/settings.service';
import {
  detectCopyTrading,
  detectCrossAccountHedge,
  detectLatencyAbuse,
  type AccountFill,
  type OpeningFill,
  type OpenLeg,
} from './abuse-rules';

// =====================================================================
// Detection of trading behaviour that harms the firm. Everything here creates FLAGS for staff review; nothing locks an
// account by itself (the specification requires a reviewed decision before any punitive action). The only automatic action is
// the pre-trade block of cross-account hedging in abuse-guard.ts.
// =====================================================================

const DAY_MS = 86_400_000;
const dayBucket = (now: Date) => now.toISOString().slice(0, 10);
const hourBucket = (now: Date) => now.toISOString().slice(0, 13);

async function createFlagOnce(data: {
  type: AbuseFlagType;
  accountId: string;
  relatedAccountIds?: string[];
  summary: string;
  evidence: Prisma.InputJsonObject;
  dedupeKey: string;
}): Promise<boolean> {
  try {
    await prisma.abuseFlag.create({ data: { ...data, relatedAccountIds: data.relatedAccountIds ?? [] } });
    return true;
  } catch (err) {
    // The same finding already exists (unique dedupe key): not an error
    if ((err as { code?: string }).code === 'P2002') return false;
    throw err;
  }
}

// A blocked attempt to open the opposite side in a second account (called by the order service, outside the order transaction).
export async function recordHedgeAttempt(p: { userId: string; accountId: string; otherAccountId: string; symbol: string; openSide: string }) {
  const now = new Date();
  await createFlagOnce({
    type: 'CROSS_ACCOUNT_HEDGE',
    accountId: p.accountId,
    relatedAccountIds: [p.otherAccountId],
    summary: `Blocked attempt to open ${p.openSide} ${p.symbol} while another account of the same trader holds the opposite side`,
    evidence: { userId: p.userId, symbol: p.symbol, openSide: p.openSide, blocked: true, at: now.toISOString() },
    dedupeKey: `hedge-attempt:${p.accountId}:${p.otherAccountId}:${p.symbol}:${hourBucket(now)}`,
  });
}

const isOpening = (side: string, positionSide: string | null) => (side === 'BUY' && positionSide === 'LONG') || (side === 'SELL' && positionSide === 'SHORT');

async function scanCrossAccountHedge(now: Date): Promise<number> {
  const rows = await prisma.position.findMany({
    where: { size: { gt: 0 }, account: { status: 'ACTIVE' } },
    select: { accountId: true, marketId: true, side: true, market: { select: { symbol: true } }, account: { select: { userId: true } } },
  });
  const legs: OpenLeg[] = rows.map((r) => ({ userId: r.account.userId, accountId: r.accountId, marketId: r.marketId, symbol: r.market.symbol, side: r.side }));

  let created = 0;
  for (const f of detectCrossAccountHedge(legs)) {
    const ok = await createFlagOnce({
      type: 'CROSS_ACCOUNT_HEDGE',
      accountId: f.longAccountId,
      relatedAccountIds: [f.shortAccountId],
      summary: `Opposite ${f.symbol} positions in two accounts of one trader (LONG and SHORT at the same time)`,
      evidence: { userId: f.userId, symbol: f.symbol, longAccountId: f.longAccountId, shortAccountId: f.shortAccountId },
      dedupeKey: `hedge:${f.longAccountId}:${f.shortAccountId}:${f.symbol}:${dayBucket(now)}`,
    });
    if (ok) created++;
  }
  return created;
}

async function scanCopyTrading(now: Date, s: Awaited<ReturnType<typeof getSetting<'risk'>>>): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await prisma.fill.findMany({
    where: { createdAt: { gte: since }, positionSide: { not: null } },
    select: { id: true, accountId: true, marketId: true, side: true, positionSide: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 50_000,
  });
  const fills: OpeningFill[] = rows
    .filter((r) => isOpening(r.side, r.positionSide))
    .map((r) => ({ fillId: r.id, accountId: r.accountId, marketId: r.marketId, side: r.positionSide!, at: r.createdAt.getTime() }));

  let created = 0;
  for (const f of detectCopyTrading(fills, { windowMs: s.copyTradingWindowSeconds * 1000, minAccounts: s.copyTradingMinAccounts, minRepeats: s.copyTradingMinRepeats })) {
    const ok = await createFlagOnce({
      type: 'COPY_TRADING',
      accountId: f.accountIds[0],
      relatedAccountIds: f.accountIds.slice(1),
      summary: `${f.accountIds.length} accounts opened the same trade within ${s.copyTradingWindowSeconds}s, ${f.occurrences} times in 24h`,
      evidence: { accountIds: f.accountIds, occurrences: f.occurrences, samples: f.samples.map((x) => ({ ...x, at: new Date(x.at).toISOString() })) },
      dedupeKey: `copy:${f.accountIds.join(',')}:${dayBucket(now)}`,
    });
    if (ok) created++;
  }
  return created;
}

async function scanLatencyAbuse(now: Date, s: Awaited<ReturnType<typeof getSetting<'risk'>>>): Promise<number> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const rows = await prisma.fill.findMany({
    where: { createdAt: { gte: since }, positionSide: { not: null }, account: { status: 'ACTIVE' } },
    select: { accountId: true, marketId: true, side: true, positionSide: true, realizedPnl: true, createdAt: true },
    take: 100_000,
  });
  const byAccount = new Map<string, AccountFill[]>();
  for (const r of rows) {
    const opening = isOpening(r.side, r.positionSide);
    const pnl = r.realizedPnl.toNumber();
    const fill: AccountFill = { at: r.createdAt.getTime(), marketId: r.marketId, side: r.positionSide!, opening, result: opening ? 0 : pnl > 0 ? 1 : pnl < 0 ? -1 : 0 };
    const list = byAccount.get(r.accountId);
    if (list) list.push(fill);
    else byAccount.set(r.accountId, [fill]);
  }

  let created = 0;
  for (const [accountId, fills] of byAccount) {
    const f = detectLatencyAbuse(fills, { maxAvgHoldMs: s.latencyMaxAvgHoldSeconds * 1000, minWinRatePct: s.latencyMinWinRatePct, minCloses: s.latencyMinCloses });
    if (!f) continue;
    const ok = await createFlagOnce({
      type: 'LATENCY_ABUSE',
      accountId,
      summary: `Average hold ${f.avgHoldSeconds}s with a ${f.winRatePct}% win rate over ${f.closes} closed trades in 7 days`,
      evidence: { ...f, windowDays: 7 },
      dedupeKey: `latency:${accountId}:${dayBucket(now)}`,
    });
    if (ok) created++;
  }
  return created;
}

// Runs all detectors once. Returns how many NEW flags were created by each of them.
export async function runAbuseScan(now: Date = new Date()) {
  const settings = await getSetting('risk');
  if (!settings.abuseScanEnabled) return { hedge: 0, copyTrading: 0, latency: 0, skipped: true };

  const result = { hedge: await scanCrossAccountHedge(now), copyTrading: await scanCopyTrading(now, settings), latency: await scanLatencyAbuse(now, settings), skipped: false };
  if (result.hedge + result.copyTrading + result.latency > 0) logger.warn(result, 'Abuse scan created new flags for review');
  return result;
}

// ----------------------------- staff workflow -----------------------------

export async function listAbuseFlags(filter: { status?: AbuseFlagStatus; type?: AbuseFlagType; accountId?: string; page: number; pageSize: number }) {
  const where: Prisma.AbuseFlagWhereInput = { status: filter.status, type: filter.type, accountId: filter.accountId };
  const [items, total] = await Promise.all([
    prisma.abuseFlag.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize }),
    prisma.abuseFlag.count({ where }),
  ]);
  return { items, total, page: filter.page, pageSize: filter.pageSize };
}

// Staff decision on a flag. It only records the decision: acting on a CONFIRMED flag (lock the account, void trades) is a
// separate, audited admin action, so an innocent trader is never punished by a scan alone.
export async function resolveAbuseFlag(id: string, actorId: string, decision: 'CONFIRMED' | 'DISMISSED', note: string) {
  const flag = await prisma.abuseFlag.findUnique({ where: { id } });
  if (!flag) throw ApiError.notFound('Abuse flag not found');
  if (flag.status !== 'OPEN') throw ApiError.conflict('This flag was already resolved');

  const updated = await prisma.abuseFlag.update({
    where: { id },
    data: { status: decision, reviewedById: actorId, reviewedAt: new Date(), reviewNote: note },
  });
  await audit({ actorId, action: `abuse_flag.${decision.toLowerCase()}`, entity: 'AbuseFlag', entityId: id, metadata: { type: flag.type, accountId: flag.accountId, note } });
  return updated;
}