import type { AccountStatus, Prisma, RiskEventType } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import { logger } from '../../config/logger';
import { toD } from '../../utils/decimal';
import { audit } from '../audit/audit.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { priceFeed } from '../markets/price-feed';
import { computeAccountSnapshot } from '../trading/account-snapshot';
import { executeMarketOrder } from '../trading/trading.service';
import { cancelActiveOrders } from '../trading/order-engine';
import { isLiquidated } from '../trading/engine/calculations';
import { evaluateRisk } from './risk-rules';

// Closes every open position of the account using the last known prices.
// A stale feed must not stop a breach from being enforced, so the stored
// mark price is the fallback.
async function closeAllPositions(tx: Tx, accountId: string) {
  const positions = await tx.position.findMany({
    where: { accountId, size: { gt: 0 } },
    include: { market: true },
  });

  for (const p of positions) {
    const live = priceFeed.getPrice(p.market.symbol);
    const mid = live ? live.mid : toD(p.markPrice);
    await executeMarketOrder(tx, {
      accountId,
      symbol: p.market.symbol,
      side: p.side === 'LONG' ? 'SELL' : 'BUY',
      size: toD(p.size),
      leverage: p.leverage,
      reduceOnly: true,
      force: true,
      priceOverride: { mid, bid: live?.bid ?? null, ask: live?.ask ?? null },
    });
  }
}

async function recordEvent(tx: Tx, accountId: string, type: RiskEventType, details: Prisma.InputJsonValue) {
  await tx.riskEvent.create({ data: { accountId, type, details } });
}

// Close positions, lock the account and write the risk event.
export async function lockAccount(
  accountId: string,
  status: AccountStatus,
  eventType: RiskEventType,
  reason: string,
  details: Prisma.InputJsonValue = {},
  actorId?: string,
) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
      // Working orders (limits, stops, TP / SL) must not fire after the account is locked
      await cancelActiveOrders(tx, accountId, `RISK_${eventType}`);
      await closeAllPositions(tx, accountId);
      await tx.tradingAccount.update({ where: { id: accountId }, data: { status, statusReason: reason } });
      await recordEvent(tx, accountId, eventType, details);
      await audit({ actorId, action: `risk.${eventType.toLowerCase()}`, entity: 'TradingAccount', entityId: accountId, metadata: details }, tx);
    },
    { timeout: 15_000 },
  );
}

// Challenge passed: close positions, mark PASSED and create the funded account.
async function passChallenge(accountId: string, details: Prisma.InputJsonValue) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "TradingAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
      await cancelActiveOrders(tx, accountId, 'CHALLENGE_PASSED');
      await closeAllPositions(tx, accountId);

      const account = await tx.tradingAccount.update({
        where: { id: accountId },
        data: { status: 'PASSED', statusReason: 'Profit target reached' },
        include: { plan: true },
      });
      await recordEvent(tx, accountId, 'PROFIT_TARGET_REACHED', details);

      // Challenge to funded transition (rules must be confirmed with the client)
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
      await audit({ action: 'risk.challenge_passed', entity: 'TradingAccount', entityId: accountId, metadata: { fundedAccountId: funded.id } }, tx);
    },
    { timeout: 15_000 },
  );
}

// Checks one account against all rules and enforces the result.
export async function evaluateAccount(accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId }, include: { plan: true } });
  if (!account || account.status !== 'ACTIVE') return;

  const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, accountId));

  // 1) Liquidation of single positions (mark price crossed the liquidation price)
  for (const p of snapshot.positions) {
    if (p.liquidationPrice && isLiquidated(p.side, p.markPrice, p.liquidationPrice)) {
      await lockAccount(accountId, account.stage === 'CHALLENGE' ? 'BREACHED' : 'DISABLED', 'LIQUIDATION', `Liquidated on ${p.symbol}`, { symbol: p.symbol, markPrice: p.markPrice.toString() });
      return;
    }
  }

  // 2) Peak equity for trailing drawdown
  let highWaterMark = toD(account.highWaterMark);
  if (snapshot.equity.gt(highWaterMark)) {
    highWaterMark = snapshot.equity;
    await prisma.tradingAccount.update({ where: { id: accountId }, data: { highWaterMark: highWaterMark.toFixed() } });
  }

  // 3) Daily loss, drawdown and profit target
  const result = evaluateRisk({
    stage: account.stage,
    startingBalance: toD(account.startingBalance),
    equity: snapshot.equity,
    highWaterMark,
    dayStartBalance: toD(account.dayStartBalance),
    dayStartEquity: toD(account.dayStartEquity),
    dailyLossPct: toD(account.plan.dailyLossPct),
    maxDrawdownPct: toD(account.plan.maxDrawdownPct),
    profitTargetPct: toD(account.plan.profitTargetPct),
    dailyLossMethod: account.plan.dailyLossMethod,
    drawdownType: account.plan.drawdownType,
  });

  const details = {
    equity: snapshot.equity.toString(),
    dailyLoss: result.dailyLoss.toString(),
    dailyLossLimit: result.dailyLossLimit.toString(),
    drawdown: result.drawdown.toString(),
    drawdownLimit: result.drawdownLimit.toString(),
  };

  if (result.breach) {
    const type: RiskEventType = result.breach === 'DAILY_LOSS' ? 'DAILY_LOSS_BREACH' : 'MAX_DRAWDOWN_BREACH';
    await lockAccount(accountId, account.stage === 'CHALLENGE' ? 'BREACHED' : 'DISABLED', type, `Rule breached: ${result.breach}`, details);
    logger.warn({ accountId, breach: result.breach }, 'Account breached and locked');
    return;
  }

  if (result.targetReached && (await hasMinTradingDays(accountId, account.plan.minTradingDays))) {
    await passChallenge(accountId, { ...details, profit: result.profit.toString() });
    logger.info({ accountId }, 'Challenge passed');
  }
}

// Minimum number of distinct days with at least one fill.
async function hasMinTradingDays(accountId: string, minDays: number): Promise<boolean> {
  if (minDays <= 0) return true;
  const fills = await prisma.fill.findMany({ where: { accountId }, select: { createdAt: true } });
  const days = new Set(fills.map((f) => f.createdAt.toISOString().slice(0, 10)));
  return days.size >= minDays;
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

// Resets the "start of day" reference values (daily reset job).
export async function runDailyReset() {
  const accounts = await prisma.tradingAccount.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  for (const { id } of accounts) {
    const snapshot = await prisma.$transaction((tx) => computeAccountSnapshot(tx, id));
    await prisma.tradingAccount.update({
      where: { id },
      data: {
        dayStartBalance: snapshot.balance.toFixed(),
        dayStartEquity: snapshot.equity.toFixed(),
        lastDailyResetAt: new Date(),
      },
    });
  }
  logger.info({ accounts: accounts.length }, 'Daily reset completed');
}

