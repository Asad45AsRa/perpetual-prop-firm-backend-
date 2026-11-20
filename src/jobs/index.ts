import cron from 'node-cron';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { toD, ZERO } from '../utils/decimal';
import { audit } from '../modules/audit/audit.service';
import { syncPurchaseWithPlisio } from '../modules/payments/payments.service';
import { applyPendingFunding, captureFundingBoundary, hourStartOf } from '../modules/markets/funding.service';
import { runDailyReset, runRiskMonitor } from '../modules/risk/risk.service';
import { startOrderMatcher, stopOrderMatcher } from '../modules/trading/order-matcher';

// Runs a job and logs failures instead of crashing the process.
function safe(name: string, fn: () => Promise<void>) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, 'Background job failed');
    }
  };
}

// Compares every account balance with the sum of its ledger entries.
// A mismatch means something changed a balance outside the ledger.
async function reconcileLedger() {
  const sums = await prisma.ledgerEntry.groupBy({ by: ['accountId'], _sum: { amount: true } });
  const accounts = await prisma.tradingAccount.findMany({ select: { id: true, balance: true } });
  const sumByAccount = new Map(sums.map((s) => [s.accountId, toD(s._sum.amount ?? 0)]));

  let mismatches = 0;
  for (const a of accounts) {
    const ledgerTotal = sumByAccount.get(a.id) ?? ZERO;
    if (!toD(a.balance).eq(ledgerTotal)) {
      mismatches++;
      logger.error({ accountId: a.id, balance: a.balance.toString(), ledgerTotal: ledgerTotal.toString() }, 'LEDGER MISMATCH');
      await audit({ action: 'ledger.mismatch', entity: 'TradingAccount', entityId: a.id, metadata: { balance: a.balance.toString(), ledgerTotal: ledgerTotal.toString() } });
    }
  }
  logger.info({ accounts: accounts.length, mismatches }, 'Ledger reconciliation finished');
}

// Re-checks payments that stayed pending (missed or delayed callbacks).
async function checkStalePayments() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const pending = await prisma.purchase.findMany({
    where: { status: 'PENDING', plisioTxnId: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of pending) {
    await syncPurchaseWithPlisio(id).catch((err) => logger.warn({ err, purchaseId: id }, 'Payment re-check failed'));
  }
}

// Daily summary written to the log (extend later: email, dashboard, CSV).
async function dailyReport() {
  const since = new Date(Date.now() - 86_400_000);
  const [signups, paid, breaches, payoutRequests] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.purchase.count({ where: { status: 'PAID', paidAt: { gte: since } } }),
    prisma.riskEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.payout.count({ where: { createdAt: { gte: since } } }),
  ]);
  logger.info({ signups, paid, breaches, payoutRequests }, 'Daily report');
}

async function cleanupTokens() {
  const { count } = await prisma.emailToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const refresh = await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  logger.info({ emailTokens: count, refreshTokens: refresh.count }, 'Expired tokens removed');
}

let monitorRunning = false;
let monitorTimer: NodeJS.Timeout | null = null;
const tasks: cron.ScheduledTask[] = [];

export function startJobs() {
  // Risk monitor: every 2 seconds, never overlapping with itself
  monitorTimer = setInterval(async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      await runRiskMonitor();
    } catch (err) {
      logger.error({ err }, 'Risk monitor failed');
    } finally {
      monitorRunning = false;
    }
  }, 2000);

  // Resting limit / stop / TP / SL orders against the live order book
  startOrderMatcher();

  const utc = { timezone: 'UTC' };
  tasks.push(
    // Funding: snapshot of the open positions exactly on every UTC hour (6-field cron: second 0)
    cron.schedule('0 0 * * * *', safe('funding-capture', async () => void (await captureFundingBoundary(hourStartOf(Date.now())))), utc),
    // Post the funding of closed hours as soon as the official rate is published (retries until it is)
    cron.schedule('20 * * * * *', safe('funding-apply', async () => void (await applyPendingFunding())), utc),
    cron.schedule(`0 ${env.DAILY_RESET_UTC_HOUR} * * *`, safe('daily-reset', runDailyReset), utc),
    cron.schedule('*/5 * * * *', safe('stale-payments', checkStalePayments), utc),
    cron.schedule('15 * * * *', safe('ledger-reconciliation', reconcileLedger), utc),
    cron.schedule('30 0 * * *', safe('daily-report', dailyReport), utc),
    cron.schedule('0 3 * * *', safe('token-cleanup', cleanupTokens), utc),
  );
  logger.info('Background jobs started');
}

export function stopJobs() {
  stopOrderMatcher();
  if (monitorTimer) clearInterval(monitorTimer);
  tasks.forEach((t) => t.stop());
}
