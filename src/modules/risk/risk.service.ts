import type { AccountStatus, Prisma, RiskEventType } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { prisma, type Tx } from '../../config/prisma';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { audit } from '../audit/audit.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { priceFeed } from '../markets/price-feed';
import { getSetting } from '../settings/settings.service';
import { computeAccountSnapshot, type AccountSnapshot } from '../trading/account-snapshot';
import { feeAmount, resolveFeeRate } from '../trading/engine/fees';
import { cancelActiveOrders, lockAccount as lockAccountRow } from '../trading/order-engine';
import { tradingEvents } from '../trading/trading-events';
import { executeMarketOrder } from '../trading/trading.service';
import { latestBreachEvent } from './breach-review.service';
import { computeFloors, evaluateRisk, isTargetSettled, latestResetBoundary, reviewDeadlineOf, tradingDateOf, type RiskInput, type RiskResult } from './risk-rules';

// =====================================================================
// Risk engine, challenge evaluation and automatic account restrictions.
// Rules: Perpeye Trading Terminal v1.0 Complete Implementation Specification (23 Nov 2026), sections 8, 10 and 14.
//
// Event priority on every fresh evaluation (spec section 6 / 8):
//   1. daily / static hard breach  -> fail the account, cancel working orders, close every position at the server mark
//   2. margin-only forced close    -> only when NOT breached and equity <= total maintenance threshold (account stays ACTIVE)
//   3. evaluation pass             -> only on the NET settled balance (after exit fees) and with no breach
// A decision is NEVER taken on a stale mark price: the account is evaluated again with the first fresh mark.
// Every decision runs inside one transaction that holds the account row lock, and is re-evaluated under that lock,
// so two simultaneous checks or an order that fills in between can never produce two outcomes.
// =====================================================================

// Raised inside the pass transaction when the settled balance (after the closing fees) is below the target.
// The transaction rolls back, so nothing is closed or cancelled for a pass that did not happen.
class PassNotSettledError extends Error {
  constructor(
    public settledBalance: Decimal,
    public targetBalance: Decimal,
  ) {
    super('Net settled balance is below the profit target');
  }
}

interface ClosedFill {
  symbol: string;
  side: string;
  size: string;
  price: string;
  fee: string;
  realizedPnl: string;
}

type AccountWithPlan = Prisma.TradingAccountGetPayload<{ include: { plan: true } }>;

type Outcome =
  | { kind: 'BREACHED'; breach: string; accountStatus: AccountStatus }
  | { kind: 'MARGIN_CLOSE' }
  | { kind: 'PASSED'; fundedAccountId: string };

// All marks of the open positions are fresh (a flat account is always evaluable).
const marksFresh = (snapshot: AccountSnapshot): boolean => snapshot.positions.every((p) => priceFeed.isMarkFresh(p.symbol));

function riskInputOf(account: AccountWithPlan, equity: Decimal, estimatedExitFees?: Decimal): RiskInput {
  return {
    stage: account.stage,
    startingBalance: toD(account.startingBalance),
    dayStartBalance: toD(account.dayStartBalance),
    dailyLossPct: toD(account.plan.dailyLossPct),
    maxDrawdownPct: toD(account.plan.maxDrawdownPct),
    profitTargetPct: toD(account.plan.profitTargetPct),
    equity,
    estimatedExitFees,
  };
}

// Evidence stored with every risk event (equity, floors, marks and time) so a decision can be reproduced in a dispute.
function evidenceOf(account: AccountWithPlan, result: RiskResult, snapshot: AccountSnapshot): Prisma.InputJsonObject {
  return {
    at: new Date().toISOString(),
    stage: account.stage,
    startingBalance: toD(account.startingBalance).toString(),
    dayStartBalance: toD(account.dayStartBalance).toString(),
    balance: snapshot.balance.toString(),
    equity: snapshot.equity.toString(),
    unrealizedPnl: snapshot.unrealizedPnl.toString(),
    dailyAllowance: result.dailyAllowance.toString(),
    dailyFloor: result.dailyFloor.toString(),
    staticFloor: result.staticFloor.toString(),
    effectiveFloor: result.effectiveFloor.toString(),
    bindingRule: result.bindingRule,
    // Both observed values are kept when the equity reached both floors on the same event
    dailyFloorHit: snapshot.equity.lte(result.dailyFloor),
    staticFloorHit: snapshot.equity.lte(result.staticFloor),
    ruleVersion: account.plan.ruleVersion,
    // Kept under the older names as well, so existing admin screens keep working
    dailyLoss: result.dailyLoss.toString(),
    dailyLossLimit: result.dailyLossLimit.toString(),
    drawdown: result.drawdown.toString(),
    drawdownLimit: result.drawdownLimit.toString(),
    maintenanceMargin: snapshot.maintenanceMargin.toString(),
    marks: snapshot.positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: p.size.toString(),
      mark: p.markPrice.toString(),
      markAgeMs: priceFeed.markAgeMs(p.symbol),
    })),
  };
}

// Closes every open position of the account at the SERVER MARK (spec: "close positions at valid server mark").
// The live mark is used when it is fresh, otherwise the last mark stored with the position. The order book mid is never used.
// Each close is an ordinary reduce-only taker fill, so the exit fee is booked (there is no separate liquidation penalty).
async function closeAllPositions(tx: Tx, accountId: string): Promise<ClosedFill[]> {
  const positions = await tx.position.findMany({
    where: { accountId, size: { gt: 0 } },
    include: { market: true },
  });

  const closed: ClosedFill[] = [];
  for (const p of positions) {
    const symbol = p.market.symbol;
    const live = priceFeed.isMarkFresh(symbol) ? priceFeed.getMark(symbol) : undefined;
    const mark = live ? live.mark : toD(p.markPrice);
    const result = await executeMarketOrder(tx, {
      accountId,
      symbol,
      side: p.side === 'LONG' ? 'SELL' : 'BUY',
      size: toD(p.size),
      leverage: p.leverage,
      reduceOnly: true,
      force: true,
      priceOverride: { mid: mark, bid: null, ask: null },
    });
    for (const f of result.fills) {
      closed.push({
        symbol,
        side: f.side,
        size: f.size.toString(),
        price: f.price.toString(),
        fee: f.fee.toString(),
        realizedPnl: f.realizedPnl.toString(),
      });
    }
  }
  return closed;
}

async function recordEvent(tx: Tx, accountId: string, type: RiskEventType, details: Prisma.InputJsonValue) {
  await tx.riskEvent.create({ data: { accountId, type, details } });
}

// Taker fees that closing every open position at the current marks would cost.
// Same rate resolution and rounding as a real fill, so the projection matches the booked fee.
async function estimateExitFees(tx: Tx, snapshot: AccountSnapshot): Promise<Decimal> {
  if (snapshot.positions.length === 0) return ZERO;
  const [settings, markets] = await Promise.all([
    getSetting('trading'),
    tx.market.findMany({
      where: { id: { in: snapshot.positions.map((p) => p.marketId) } },
      select: { id: true, marketType: true, takerFeeRate: true },
    }),
  ]);
  const byId = new Map(markets.map((m) => [m.id, m]));

  let total = ZERO;
  for (const p of snapshot.positions) {
    const market = byId.get(p.marketId);
    if (!market) continue;
    const rate = resolveFeeRate({ marketType: market.marketType, liquidity: 'TAKER', schedule: settings.fees, takerOverride: market.takerFeeRate });
    total = total.plus(feeAmount(p.notional, rate));
  }
  return total;
}

// Number of distinct UTC days with at least one fill.
async function countTradingDays(client: Tx, accountId: string): Promise<number> {
  const rows = await client.$queryRaw<{ days: bigint }[]>`SELECT COUNT(DISTINCT DATE("createdAt")) AS days FROM "Fill" WHERE "accountId" = ${accountId}::uuid`;
  return Number(rows[0]?.days ?? 0);
}

// ----------------------------- lock / close -----------------------------

// Cancels working orders, closes positions, sets the status and writes the risk event. Runs inside the caller's transaction.
async function applyLock(tx: Tx, accountId: string, status: AccountStatus, eventType: RiskEventType, reason: string, details: Prisma.InputJsonObject, actorId?: string) {
  // Working orders (limits, stops, TP / SL) must not fire after the account is locked
  await cancelActiveOrders(tx, accountId, `RISK_${eventType}`);
  const closed = await closeAllPositions(tx, accountId);
  const after = await tx.tradingAccount.update({ where: { id: accountId }, data: { status, statusReason: reason }, select: { balance: true } });

  const full: Prisma.InputJsonObject = { ...details, closedFills: closed, balanceAfterClose: toD(after.balance).toString() };
  await recordEvent(tx, accountId, eventType, full);
  await audit({ actorId, action: `risk.${eventType.toLowerCase()}`, entity: 'TradingAccount', entityId: accountId, metadata: full }, tx);
}

// Close positions, lock the account and write the risk event (used by admin and system actions).
// Idempotent: an automatic lock only applies to an ACTIVE account, so the same breach arriving twice is recorded once.
// A manual lock applies unless the account already has the requested status. Returns true when the lock was applied.
export async function lockAccount(
  accountId: string,
  status: AccountStatus,
  eventType: RiskEventType,
  reason: string,
  details: Prisma.InputJsonObject = {},
  actorId?: string,
): Promise<boolean> {
  const applied = await prisma.$transaction(
    async (tx) => {
      await lockAccountRow(tx, accountId);
      const current = await tx.tradingAccount.findUnique({ where: { id: accountId }, select: { status: true } });
      if (!current) return false;
      const manual = eventType === 'MANUAL_LOCK';
      if (manual ? current.status === status : current.status !== 'ACTIVE') return false;
      await applyLock(tx, accountId, status, eventType, reason, details, actorId);
      return true;
    },
    { timeout: 15_000 },
  );
  if (applied) tradingEvents.accountChanged(accountId, 'risk');
  return applied;
}

// Margin-only forced close (spec section 8): the account is healthy (no daily / static breach) but its equity fell to the
// total maintenance threshold. Pending orders are cancelled and every position is closed at the server mark, with NO extra
// penalty (only the ordinary taker exit fee). The account stays ACTIVE.
async function forceCloseForMargin(tx: Tx, accountId: string, details: Prisma.InputJsonObject) {
  await cancelActiveOrders(tx, accountId, 'RISK_MAINTENANCE_MARGIN');
  const closed = await closeAllPositions(tx, accountId);
  const full: Prisma.InputJsonObject = { ...details, closedFills: closed };
  await recordEvent(tx, accountId, 'LIQUIDATION', full);
  await audit({ action: 'risk.maintenance_margin_close', entity: 'TradingAccount', entityId: accountId, metadata: full }, tx);
}

// Challenge passed: the positions were closed and the closing fees booked, the NET settled balance reached the target.
// Marks the account PASSED and creates the funded account with the ORIGINAL Starting Trading Power (evaluation profit is not carried over).
async function passChallenge(tx: Tx, account: AccountWithPlan, result: RiskResult, snapshot: AccountSnapshot, exitFees: Decimal): Promise<string> {
  const accountId = account.id;
  await cancelActiveOrders(tx, accountId, 'CHALLENGE_PASSED');
  const closed = await closeAllPositions(tx, accountId);

  // Final test on the NET SETTLED balance (flat account: balance = equity). Not enough after the exit fees = no pass, roll back.
  const settled = toD((await tx.tradingAccount.findUniqueOrThrow({ where: { id: accountId }, select: { balance: true } })).balance);
  if (!isTargetSettled(settled, result.targetBalance)) throw new PassNotSettledError(settled, result.targetBalance);

  await tx.tradingAccount.update({ where: { id: accountId }, data: { status: 'PASSED', statusReason: 'Profit target reached' } });

  // Challenge to funded transition: the funded account starts at the original Starting Trading Power
  const funded = await tx.tradingAccount.create({
    data: {
      userId: account.userId,
      planId: account.planId,
      sourceAccountId: account.id,
      stage: 'FUNDED',
      startingBalance: account.plan.accountSize,
      highWaterMark: account.plan.accountSize,
      dayStartBalance: account.plan.accountSize,
      dayStartEquity: account.plan.accountSize,
    },
  });
  await postLedgerEntry(tx, {
    accountId: funded.id,
    type: 'DEPOSIT',
    amount: toD(account.plan.accountSize),
    refType: 'challenge',
    refId: account.id,
    idempotencyKey: `funded:${funded.id}:initial`,
    description: 'Funded account activation',
  });

  const details: Prisma.InputJsonObject = {
    ...evidenceOf(account, result, snapshot),
    profit: result.profit.toString(),
    targetBalance: result.targetBalance.toString(),
    estimatedExitFees: exitFees.toString(),
    netSettledBalance: settled.toString(),
    closedFills: closed,
    fundedAccountId: funded.id,
  };
  await recordEvent(tx, accountId, 'PROFIT_TARGET_REACHED', details);
  await audit({ action: 'risk.challenge_passed', entity: 'TradingAccount', entityId: accountId, metadata: details }, tx);
  return funded.id;
}

// ----------------------------- evaluation -----------------------------

// The authoritative evaluation. Holds the account row lock, reads the state again and applies at most the first matching rule
// of the priority list. Returns what happened (empty = nothing to do).
async function enforceInTx(tx: Tx, accountId: string): Promise<Outcome[]> {
  await lockAccountRow(tx, accountId);
  const outcomes: Outcome[] = [];

  // A margin close can be followed by a fee-driven breach, so the state is evaluated again after it (at most 3 rounds)
  for (let round = 0; round < 3; round++) {
    const account = await tx.tradingAccount.findUnique({ where: { id: accountId }, include: { plan: true } });
    if (!account || account.status !== 'ACTIVE') break;

    const snapshot = await computeAccountSnapshot(tx, accountId);
    // Never fail, liquidate or pass an account on a stale mark: wait for the first fresh mark
    if (!marksFresh(snapshot)) break;

    const result = evaluateRisk(riskInputOf(account, snapshot.equity));

    // 1) Hard breach: daily or static floor reached (equality fails the account)
    if (result.breach) {
      const status: AccountStatus = account.stage === 'CHALLENGE' ? 'BREACHED' : 'DISABLED';
      const type: RiskEventType = result.breach === 'DAILY_LOSS' ? 'DAILY_LOSS_BREACH' : 'MAX_DRAWDOWN_BREACH';
      const evidence = evidenceOf(account, result, snapshot);
      const breachedAt = new Date();
      await applyLock(tx, accountId, status, type, `Rule breached: ${result.breach}`, {
        ...evidence,
        breachedAt: breachedAt.toISOString(),
        // The trader may ask for a technical review until this moment (72 hours)
        reviewDeadline: reviewDeadlineOf(breachedAt).toISOString(),
      });
      outcomes.push({ kind: 'BREACHED', breach: result.breach, accountStatus: status });
      break;
    }

    // 2) Maintenance margin: only for a healthy account (the account stays ACTIVE)
    if (snapshot.positions.length > 0 && snapshot.equity.lte(snapshot.maintenanceMargin)) {
      await forceCloseForMargin(tx, accountId, { ...evidenceOf(account, result, snapshot), reason: 'MAINTENANCE_MARGIN' });
      outcomes.push({ kind: 'MARGIN_CLOSE' });
      continue;
    }

    // 3) Evaluation target. Tested once per transaction and only before anything else was changed, because a failed
    //    settlement rolls the whole transaction back.
    if (round === 0 && result.targetEnabled && snapshot.equity.gte(result.targetBalance)) {
      const exitFees = await estimateExitFees(tx, snapshot);
      const net = evaluateRisk(riskInputOf(account, snapshot.equity, exitFees));
      if (!net.targetReached) break;
      if ((await countTradingDays(tx, accountId)) < account.plan.minTradingDays) break;
      const fundedAccountId = await passChallenge(tx, account, net, snapshot, exitFees);
      outcomes.push({ kind: 'PASSED', fundedAccountId });
    }
    break;
  }
  return outcomes;
}

// Checks one account against all rules and enforces the result.
// The cheap check below runs without a lock on every call; the account row lock is only taken when a rule may apply.
export async function evaluateAccount(accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId }, include: { plan: true } });
  if (!account || account.status !== 'ACTIVE') return;

  const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, accountId));
  // Stale marks: no breach, no liquidation, no pass (spec section 6 "Data outage")
  if (!marksFresh(snapshot)) return;

  // Peak equity (information only: the static drawdown floor never trails)
  if (snapshot.equity.gt(toD(account.highWaterMark))) {
    await prisma.tradingAccount.update({ where: { id: accountId }, data: { highWaterMark: snapshot.equity.toFixed() } });
  }

  const quick = evaluateRisk(riskInputOf(account, snapshot.equity));
  const maintenanceHit = snapshot.positions.length > 0 && snapshot.equity.lte(snapshot.maintenanceMargin);
  const targetCandidate =
    !quick.breach &&
    quick.targetEnabled &&
    snapshot.equity.gte(quick.targetBalance) &&
    (account.plan.minTradingDays <= 0 || (await countTradingDays(prisma, accountId)) >= account.plan.minTradingDays);
  if (!quick.breach && !maintenanceHit && !targetCandidate) return;

  let outcomes: Outcome[];
  try {
    outcomes = await prisma.$transaction((tx) => enforceInTx(tx, accountId), { timeout: 15_000, maxWait: 5_000 });
  } catch (err) {
    if (err instanceof PassNotSettledError) {
      logger.info({ accountId, settled: err.settledBalance.toString(), target: err.targetBalance.toString() }, 'Profit target not reached after the exit fees, no pass');
      return;
    }
    throw err;
  }
  if (outcomes.length === 0) return;

  tradingEvents.accountChanged(accountId, 'risk');
  for (const o of outcomes) {
    if (o.kind === 'BREACHED') logger.warn({ accountId, breach: o.breach, status: o.accountStatus }, 'Account breached and locked');
    else if (o.kind === 'MARGIN_CLOSE') logger.warn({ accountId }, 'Positions force-closed at the maintenance margin threshold');
    else logger.info({ accountId, fundedAccountId: o.fundedAccountId }, 'Challenge passed');
  }
}

// Evaluates every active account that currently holds open positions.
export async function runRiskMonitor() {
  const accounts = await prisma.tradingAccount.findMany({
    where: { status: 'ACTIVE', positions: { some: { size: { gt: 0 } } } },
    select: { id: true },
  });
  for (const { id } of accounts) {
    try {
      await evaluateAccount(id);
    } catch (err) {
      logger.error({ err, accountId: id }, 'Risk evaluation failed');
    }
  }
}

// ----------------------------- daily reset -----------------------------

const RESET_CHUNK = 5;

// Realized balance of the account at a UTC boundary, rebuilt from the append-only ledger (the last entry before the boundary).
// A late or repeated job therefore gets exactly the same value as an on-time one.
async function realizedBalanceAt(tx: Tx, accountId: string, boundary: Date, fallback: Decimal): Promise<Decimal> {
  const last = await tx.ledgerEntry.findFirst({
    where: { accountId, createdAt: { lt: boundary } },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  });
  return last ? toD(last.balanceAfter) : fallback;
}

// Snaps the "UTC day-start realized balance" of one account and stores the immutable daily snapshot (unique per account and
// UTC trading date). Safe to run twice or late: an existing snapshot for the date is never touched, and the balance comes from
// the ledger state at the boundary, not from the moment the job ran. Open positions are untouched (their PnL is not part of
// the realized balance).
async function resetOneAccount(accountId: string, boundary: Date, now: Date): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      await lockAccountRow(tx, accountId);
      const account = await tx.tradingAccount.findUnique({ where: { id: accountId }, include: { plan: true } });
      if (!account || account.status !== 'ACTIVE') return false;

      const tradingDate = tradingDateOf(boundary);
      const done = await tx.dailyRiskSnapshot.findUnique({ where: { accountId_tradingDate_kind: { accountId, tradingDate, kind: 'DAILY' } }, select: { id: true } });
      if (done) return false;

      const snapshot = await computeAccountSnapshot(tx, accountId);
      const dayStart = await realizedBalanceAt(tx, accountId, boundary, toD(account.startingBalance));
      const floors = computeFloors({
        startingBalance: toD(account.startingBalance),
        dayStartBalance: dayStart,
        dailyLossPct: toD(account.plan.dailyLossPct),
        maxDrawdownPct: toD(account.plan.maxDrawdownPct),
      });

      await tx.dailyRiskSnapshot.create({
        data: {
          accountId,
          tradingDate,
          kind: 'DAILY',
          startingBalance: account.startingBalance,
          dayStartBalance: dayStart.toFixed(),
          // Informational only (the floors use the realized balance): equity when the job ran
          dayStartEquity: snapshot.equity.toFixed(),
          dailyAllowance: floors.dailyAllowance.toFixed(),
          dailyFloor: floors.dailyFloor.toFixed(),
          staticFloor: floors.staticFloor.toFixed(),
        },
      });
      await tx.tradingAccount.update({
        where: { id: accountId },
        data: { dayStartBalance: dayStart.toFixed(), dayStartEquity: snapshot.equity.toFixed(), lastDailyResetAt: now },
      });
      return true;
    },
    { timeout: 15_000 },
  );
}

// Resets the "start of day" reference values at 00:00 UTC (daily reset job, also run once at start-up to catch a missed reset).
// Only accounts that already existed at the boundary are reset: an account opened later today keeps its own day start.
export async function runDailyReset(now: Date = new Date()) {
  const boundary = latestResetBoundary(now, env.DAILY_RESET_UTC_HOUR);
  const due = await prisma.tradingAccount.findMany({
    where: {
      status: 'ACTIVE',
      createdAt: { lt: boundary },
      OR: [{ lastDailyResetAt: null }, { lastDailyResetAt: { lt: boundary } }],
    },
    select: { id: true },
  });

  let reset = 0;
  for (let i = 0; i < due.length; i += RESET_CHUNK) {
    const results = await Promise.all(
      due.slice(i, i + RESET_CHUNK).map(({ id }) =>
        resetOneAccount(id, boundary, now).catch((err) => {
          logger.error({ err, accountId: id }, 'Daily reset failed for one account');
          return false;
        }),
      ),
    );
    reset += results.filter(Boolean).length;
  }
  logger.info({ due: due.length, reset, boundary: boundary.toISOString() }, 'Daily reset completed');
}

// ----------------------------- payout rebase -----------------------------

// A payout moves gross profit out of the trading balance. At that single event the daily floor is rebased once, using the
// remaining balance as the new day-start reference: allowance = rate x max(StartingTP, remaining), floor = remaining - allowance.
// The static floor never changes and the payout is not a trading loss. Idempotent per payout id: a repeated call, an approval
// after a reservation, or a retry never rebases again. Call it inside the transaction that deducted the balance, after the
// ledger entry was posted. A rejected or failed payout does not call it (no second rebase).
export async function rebaseDailyFloorForPayout(tx: Tx, accountId: string, payoutId: string, now: Date = new Date()): Promise<boolean> {
  await lockAccountRow(tx, accountId);
  const kind = `PAYOUT_REBASE:${payoutId}`;
  const tradingDate = tradingDateOf(latestResetBoundary(now, env.DAILY_RESET_UTC_HOUR));

  const done = await tx.dailyRiskSnapshot.findFirst({ where: { accountId, kind }, select: { id: true } });
  if (done) return false;

  const account = await tx.tradingAccount.findUnique({ where: { id: accountId }, include: { plan: true } });
  if (!account) return false;

  const snapshot = await computeAccountSnapshot(tx, accountId);
  const floors = computeFloors({
    startingBalance: toD(account.startingBalance),
    dayStartBalance: snapshot.balance,
    dailyLossPct: toD(account.plan.dailyLossPct),
    maxDrawdownPct: toD(account.plan.maxDrawdownPct),
  });

  await tx.dailyRiskSnapshot.create({
    data: {
      accountId,
      tradingDate,
      kind,
      payoutId,
      startingBalance: account.startingBalance,
      dayStartBalance: snapshot.balance.toFixed(),
      dayStartEquity: snapshot.equity.toFixed(),
      dailyAllowance: floors.dailyAllowance.toFixed(),
      dailyFloor: floors.dailyFloor.toFixed(),
      staticFloor: floors.staticFloor.toFixed(),
    },
  });
  await tx.tradingAccount.update({ where: { id: accountId }, data: { dayStartBalance: snapshot.balance.toFixed() } });
  await audit(
    { action: 'risk.floor_rebased', entity: 'TradingAccount', entityId: accountId, metadata: { payoutId, dayStartBalance: snapshot.balance.toString(), dailyFloor: floors.dailyFloor.toString(), staticFloor: floors.staticFloor.toString() } },
    tx,
  );
  return true;
}

// ----------------------------- risk event history -----------------------------

// Paginated risk and breach history of one account (newest first). `before` is the createdAt of the last item of the previous page.
export async function listRiskEvents(accountId: string, opts: { limit: number; before?: Date }) {
  const rows = await prisma.riskEvent.findMany({
    where: { accountId, createdAt: opts.before ? { lt: opts.before } : undefined },
    orderBy: { createdAt: 'desc' },
    take: opts.limit + 1,
    select: { id: true, type: true, details: true, createdAt: true },
  });
  const hasMore = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit);
  return { items, nextBefore: hasMore ? items[items.length - 1].createdAt.toISOString() : null };
}

// ----------------------------- risk status -----------------------------

// Live risk and performance view of one account (GET /trading/accounts/:accountId/risk).
// Everything is computed by the server from the ledger state and the live marks.
export async function getRiskStatus(accountId: string) {
  const account = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId }, include: { plan: true } });
  const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, accountId));
  const exitFees = await estimateExitFees(prisma, snapshot);
  const r = evaluateRisk(riskInputOf(account, snapshot.equity, exitFees));

  const [totals, wins, losses, tradingDays] = await Promise.all([
    prisma.fill.aggregate({ where: { accountId }, _sum: { realizedPnl: true, fee: true }, _count: { _all: true } }),
    prisma.fill.count({ where: { accountId, realizedPnl: { gt: 0 } } }),
    prisma.fill.count({ where: { accountId, realizedPnl: { lt: 0 } } }),
    countTradingDays(prisma, accountId),
  ]);
  const breachEvent = account.status === 'BREACHED' || account.status === 'DISABLED' ? await latestBreachEvent(accountId) : null;
  const breachReview = breachEvent ? await prisma.breachReview.findUnique({ where: { riskEventId: breachEvent.id }, select: { id: true, status: true, requestedAt: true } }) : null;
  const realized = toD(totals._sum.realizedPnl ?? 0);
  const fees = toD(totals._sum.fee ?? 0);
  const closes = wins + losses;

  return {
    accountId,
    stage: account.stage,
    status: account.status,
    statusReason: account.statusReason,
    asOf: new Date().toISOString(),
    // Rule version of the plan this account was bought with (a later plan change never touches it)
    ruleVersion: account.plan.ruleVersion,
    // Set after a daily / static breach: when, why, and until when a technical review can be requested
    breach: breachEvent
      ? {
          eventId: breachEvent.id,
          type: breachEvent.type,
          at: breachEvent.createdAt.toISOString(),
          reviewDeadline: reviewDeadlineOf(breachEvent.createdAt).toISOString(),
          review: breachReview,
        }
      : null,
    // False while a mark of an open position is stale: the account is then not evaluated (no breach, no pass)
    feedHealthy: marksFresh(snapshot),
    startingBalance: toD(account.startingBalance).toString(),
    balance: snapshot.balance.toString(),
    equity: snapshot.equity.toString(),
    unrealizedPnl: snapshot.unrealizedPnl.toString(),
    dailyLoss: {
      ratePct: toD(account.plan.dailyLossPct).toString(),
      dayStartBalance: toD(account.dayStartBalance).toString(),
      allowance: r.dailyAllowance.toString(),
      floor: r.dailyFloor.toString(),
      room: r.dailyRoom.toString(),
      lossToday: r.dailyLoss.toString(),
      lastResetAt: account.lastDailyResetAt ? account.lastDailyResetAt.toISOString() : null,
    },
    staticDrawdown: {
      ratePct: toD(account.plan.maxDrawdownPct).toString(),
      limit: r.drawdownLimit.toString(),
      floor: r.staticFloor.toString(),
      room: r.staticRoom.toString(),
      loss: r.drawdown.toString(),
    },
    // The account fails when the equity reaches the effective floor (the higher of the two floors)
    effectiveFloor: r.effectiveFloor.toString(),
    bindingRule: r.bindingRule,
    riskRoom: r.riskRoom.toString(),
    profitTarget: {
      enabled: r.targetEnabled,
      ratePct: toD(account.plan.profitTargetPct).toString(),
      targetProfit: r.profitTarget.toString(),
      targetBalance: r.targetBalance.toString(),
      profit: r.profit.toString(),
      estimatedExitFees: exitFees.toString(),
      netProjected: r.netProjected.toString(),
      progressPct: r.targetProgressPct.toFixed(2),
      remaining: Decimal.max(0, r.targetBalance.minus(r.netProjected)).toString(),
      minTradingDays: account.plan.minTradingDays,
      tradingDays,
    },
    exposure: {
      gross: snapshot.grossExposure.toString(),
      limit: snapshot.grossExposureLimit.toString(),
      multiple: snapshot.grossExposureMultiple,
      overCap: snapshot.overCap,
    },
    margin: {
      used: snapshot.marginUsed.toString(),
      reserved: snapshot.reservedMargin.toString(),
      free: snapshot.freeMargin.toString(),
      available: snapshot.availableMargin.toString(),
      maintenance: snapshot.maintenanceMargin.toString(),
    },
    // Performance counts fills: a "close" is a fill that realized a profit or a loss
    performance: {
      fills: totals._count._all,
      realizedPnl: realized.toString(),
      fees: fees.toString(),
      netRealizedPnl: realized.minus(fees).toString(),
      winningCloses: wins,
      losingCloses: losses,
      winRatePct: closes > 0 ? new Decimal(wins).div(closes).mul(100).toFixed(2) : null,
      tradingDays,
    },
  };
}