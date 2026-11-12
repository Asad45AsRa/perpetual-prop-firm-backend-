import type { Payout } from '@prisma/client';
import { EXPLORER_TX_URL } from '../../config/constants';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { sha256 } from '../../utils/crypto';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { emailTemplates, sendEmail } from '../../services/email.service';
import { audit } from '../audit/audit.service';
import { postLedgerEntry } from '../ledger/ledger.service';
import { getSetting } from '../settings/settings.service';

// Profit the trader may still request = profit * split - open requests.
export async function getPayoutEligibility(userId: string, accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw ApiError.notFound('Account not found');

  const config = await getSetting('payout');
  const profit = Decimal.max(ZERO, toD(account.balance).minus(toD(account.startingBalance)));
  const openRequests = await prisma.payout.findMany({
    where: { accountId, status: { in: ['REQUESTED', 'APPROVED', 'SENT'] } },
  });
  const locked = openRequests.reduce((s, p) => s.plus(toD(p.amount)), ZERO);
  const available = Decimal.max(ZERO, profit.mul(config.profitSplitPct).div(100).minus(locked));

  const eligible = account.stage === 'FUNDED' && account.status === 'ACTIVE';
  return { eligible, available, minPayout: toD(config.minPayoutUsd), networks: config.supportedNetworks, account };
}

export async function requestPayout(
  userId: string,
  input: { accountId: string; amount: Decimal; asset: string; network: string; walletAddress: string },
) {
  const info = await getPayoutEligibility(userId, input.accountId);
  if (!info.eligible) throw ApiError.unprocessable('NOT_ELIGIBLE', 'Only active funded accounts can request payouts');
  if (!(info.networks as readonly string[]).includes(input.network)) {
    throw ApiError.unprocessable('NETWORK_NOT_SUPPORTED', 'This network is not supported');
  }
  if (input.amount.lt(info.minPayout)) {
    throw ApiError.unprocessable('BELOW_MINIMUM', `Minimum payout is ${info.minPayout.toString()}`);
  }
  if (input.amount.gt(info.available)) {
    throw ApiError.unprocessable('EXCEEDS_AVAILABLE', `Available for payout: ${info.available.toString()}`);
  }

  return prisma.payout.create({
    data: {
      userId,
      accountId: input.accountId,
      amount: input.amount.toFixed(),
      asset: input.asset,
      network: input.network,
      walletAddress: input.walletAddress,
    },
  });
}

export const listMyPayouts = (userId: string) =>
  prisma.payout.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

// Public payout feed: confirmed payouts only, with a privacy-safe trader id.
export async function listPublicPayouts(limit = 50) {
  const rows = await prisma.payout.findMany({
    where: { status: 'CONFIRMED' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return rows.map((p) => ({
    trader: `TR-${sha256(p.userId).slice(0, 6).toUpperCase()}`,
    date: p.updatedAt,
    asset: p.asset,
    network: p.network,
    amount: p.amount.toString(),
    status: p.status,
    explorerUrl: p.explorerUrl,
  }));
}

// ------------------------------ Admin ---------------------------------

export const listPayoutsForAdmin = (status?: Payout['status']) =>
  prisma.payout.findMany({
    where: status ? { status } : undefined,
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

async function loadPayout(id: string) {
  const payout = await prisma.payout.findUnique({ where: { id }, include: { user: true } });
  if (!payout) throw ApiError.notFound('Payout not found');
  return payout;
}

// Approving removes the amount from the trading account balance (via ledger).
export async function approvePayout(id: string, adminId: string) {
  const payout = await loadPayout(id);
  if (payout.status !== 'REQUESTED') throw ApiError.conflict('Only requested payouts can be approved');

  await prisma.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id },
      data: { status: 'APPROVED', reviewedById: adminId, reviewedAt: new Date() },
    });
    await postLedgerEntry(tx, {
      accountId: payout.accountId,
      type: 'PAYOUT',
      amount: toD(payout.amount).negated(),
      refType: 'payout',
      refId: id,
      idempotencyKey: `payout:${id}:debit`,
    });
    await audit({ actorId: adminId, action: 'payout.approved', entity: 'Payout', entityId: id }, tx);
  });
  await sendEmail({ to: payout.user.email, ...emailTemplates.payoutUpdate('APPROVED', payout.amount.toString()) });
}

export async function rejectPayout(id: string, adminId: string, reason: string) {
  const payout = await loadPayout(id);
  if (payout.status !== 'REQUESTED') throw ApiError.conflict('Only requested payouts can be rejected');

  await prisma.payout.update({
    where: { id },
    data: { status: 'REJECTED', rejectReason: reason, reviewedById: adminId, reviewedAt: new Date() },
  });
  await audit({ actorId: adminId, action: 'payout.rejected', entity: 'Payout', entityId: id, metadata: { reason } });
  await sendEmail({ to: payout.user.email, ...emailTemplates.payoutUpdate('REJECTED', payout.amount.toString()) });
}

// The real crypto transfer is done outside (manual / Plisio payout / wallet).
// The admin saves the transaction hash here as proof.
export async function markPayoutSent(id: string, adminId: string, txHash: string) {
  const payout = await loadPayout(id);
  if (payout.status !== 'APPROVED') throw ApiError.conflict('Only approved payouts can be marked as sent');

  const explorerBase = EXPLORER_TX_URL[payout.network];
  await prisma.payout.update({
    where: { id },
    data: { status: 'SENT', txHash, explorerUrl: explorerBase ? `${explorerBase}${txHash}` : null },
  });
  await audit({ actorId: adminId, action: 'payout.sent', entity: 'Payout', entityId: id, metadata: { txHash } });
}

// TODO: verify the transaction hash and confirmations on-chain before this step.
export async function confirmPayout(id: string, adminId: string) {
  const payout = await loadPayout(id);
  if (payout.status !== 'SENT') throw ApiError.conflict('Only sent payouts can be confirmed');

  await prisma.payout.update({ where: { id }, data: { status: 'CONFIRMED' } });
  await audit({ actorId: adminId, action: 'payout.confirmed', entity: 'Payout', entityId: id });
  await sendEmail({ to: payout.user.email, ...emailTemplates.payoutUpdate('CONFIRMED', payout.amount.toString()) });
}
