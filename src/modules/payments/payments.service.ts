import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/api-error';
import { toD } from '../../utils/decimal';
import { emailTemplates, sendEmail } from '../../services/email.service';
import { audit } from '../audit/audit.service';
import { createCommissionForPurchase } from '../affiliates/affiliates.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { createInvoice, fetchInvoiceStatus } from './plisio.client';

// Step 1: the customer chooses a plan and gets a Plisio invoice link.
export async function createCheckout(userId: string, planId: string) {
  const [user, plan] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.plan.findUnique({ where: { id: planId } }),
  ]);
  if (!plan || !plan.isActive) throw ApiError.notFound('Plan not available');
  if (!user.emailVerified) throw ApiError.forbidden('Please verify your email before buying');

  const purchase = await prisma.purchase.create({
    data: { userId, planId, amount: plan.price, currency: 'USD' },
  });

  const invoice = await createInvoice({
    orderNumber: purchase.id,
    orderName: `${plan.name} challenge`,
    amountUsd: plan.price.toString(),
    email: user.email,
  });

  await prisma.purchase.update({
    where: { id: purchase.id },
    data: { plisioTxnId: invoice.txnId, plisioInvoiceUrl: invoice.invoiceUrl },
  });

  return { purchaseId: purchase.id, invoiceUrl: invoice.invoiceUrl };
}

// Called by the Plisio webhook AND by the stale-payment job.
// Safe to call many times: one purchase can create only one account.
export async function syncPurchaseWithPlisio(purchaseId: string) {
  const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId } });
  if (!purchase || !purchase.plisioTxnId) return;
  if (purchase.status === 'PAID') return;

  const status = await fetchInvoiceStatus(purchase.plisioTxnId);
  logger.info({ purchaseId, status }, 'Plisio status checked');

  if (status === 'completed') {
    await activatePurchase(purchaseId);
  } else if (status === 'expired') {
    await prisma.purchase.update({ where: { id: purchaseId }, data: { status: 'EXPIRED' } });
  } else if (status === 'mismatch') {
    // Wrong amount paid: a human must decide
    await prisma.purchase.update({ where: { id: purchaseId }, data: { status: 'NEEDS_REVIEW' } });
  } else if (status === 'error' || status === 'cancelled') {
    await prisma.purchase.update({ where: { id: purchaseId }, data: { status: 'FAILED' } });
  }
}

// Marks the purchase paid and creates the trading account, exactly once.
async function activatePurchase(purchaseId: string) {
  const created = await prisma.$transaction(async (tx) => {
    // Lock the purchase row so two simultaneous callbacks cannot both pass
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${purchaseId}::uuid FOR UPDATE`;
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { plan: true } });
    if (purchase.status === 'PAID') return null; // already activated

    await tx.purchase.update({ where: { id: purchaseId }, data: { status: 'PAID', paidAt: new Date() } });

    // purchaseId is UNIQUE on TradingAccount: a second account is impossible
    const account = await tx.tradingAccount.create({
      data: {
        userId: purchase.userId,
        planId: purchase.planId,
        purchaseId: purchase.id,
        stage: 'CHALLENGE',
        startingBalance: purchase.plan.accountSize,
        highWaterMark: purchase.plan.accountSize,
        dayStartBalance: purchase.plan.accountSize,
        dayStartEquity: purchase.plan.accountSize,
      },
    });
    await postLedgerEntry(tx, {
      accountId: account.id,
      type: 'DEPOSIT',
      amount: toD(purchase.plan.accountSize),
      refType: 'purchase',
      refId: purchase.id,
      idempotencyKey: `purchase:${purchase.id}:deposit`,
      description: 'Challenge account activation',
    });
    await createCommissionForPurchase(tx, purchase.id);
    await audit({ action: 'payment.activated', entity: 'Purchase', entityId: purchase.id, metadata: { accountId: account.id } }, tx);

    return { userId: purchase.userId, planName: purchase.plan.name };
  });

  if (created) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.userId } });
    await sendEmail({ to: user.email, ...emailTemplates.challengeActivated(created.planName) });
  }
}

export async function listMyPurchases(userId: string) {
  return prisma.purchase.findMany({
    where: { userId },
    include: { plan: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}
