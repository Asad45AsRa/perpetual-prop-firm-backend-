import type { BreachReviewStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { audit } from '../audit/audit.service';
import { reviewDeadlineOf } from './risk-rules';

// =====================================================================
// Technical breach review (Rulebook PE-1.1, Risk Engine specification 12.2).
// The trader has 72 hours after a breach to ask for a review (inaccurate market data, platform outage, duplicate fill,
// software fault, wrong risk calculation). A review is NOT a way to reverse a legitimate loss-limit violation.
// Resolving a review only records the decision. A correction, if approved, is a separate authorized compensating ledger
// action: the original breach event is never erased.
// =====================================================================

const BREACH_TYPES = ['DAILY_LOSS_BREACH', 'MAX_DRAWDOWN_BREACH'] as const;

export const latestBreachEvent = (accountId: string) =>
  prisma.riskEvent.findFirst({ where: { accountId, type: { in: [...BREACH_TYPES] } }, orderBy: { createdAt: 'desc' } });

async function ownedAccount(userId: string, accountId: string) {
  const account = await prisma.tradingAccount.findFirst({ where: { id: accountId, userId }, select: { id: true, status: true } });
  if (!account) throw ApiError.notFound('Account not found');
  return account;
}

export async function requestBreachReview(userId: string, accountId: string, reason: string) {
  const account = await ownedAccount(userId, accountId);
  const event = await latestBreachEvent(accountId);
  if (!event || (account.status !== 'BREACHED' && account.status !== 'DISABLED')) {
    throw ApiError.unprocessable('NO_BREACH', 'This account has no loss-limit breach that can be reviewed');
  }

  const existing = await prisma.breachReview.findUnique({ where: { riskEventId: event.id } });
  if (existing) throw ApiError.conflict('A review was already requested for this breach');

  const deadlineAt = reviewDeadlineOf(event.createdAt);
  if (Date.now() > deadlineAt.getTime()) {
    throw ApiError.unprocessable('REVIEW_WINDOW_CLOSED', `The 72 hour review window ended at ${deadlineAt.toISOString()}. Contact support for an exception.`, {
      breachedAt: event.createdAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    });
  }

  try {
    const review = await prisma.breachReview.create({
      data: { accountId, riskEventId: event.id, requestedById: userId, reason, evidence: event.details as Prisma.InputJsonValue, deadlineAt },
    });
    await audit({ actorId: userId, action: 'breach_review.requested', entity: 'BreachReview', entityId: review.id, metadata: { accountId, riskEventId: event.id } });
    return review;
  } catch (err) {
    // Two simultaneous requests: the unique riskEventId admits only one
    if ((err as { code?: string }).code === 'P2002') throw ApiError.conflict('A review was already requested for this breach');
    throw err;
  }
}

// Review state of the latest breach of the account (null = no breach or no review requested yet).
export async function getBreachReview(userId: string, accountId: string) {
  await ownedAccount(userId, accountId);
  const event = await latestBreachEvent(accountId);
  if (!event) return null;
  const review = await prisma.breachReview.findUnique({ where: { riskEventId: event.id } });
  return {
    breachEventId: event.id,
    breachedAt: event.createdAt.toISOString(),
    deadlineAt: reviewDeadlineOf(event.createdAt).toISOString(),
    review,
  };
}

export async function listBreachReviews(filter: { status?: BreachReviewStatus; page: number; pageSize: number }) {
  const where: Prisma.BreachReviewWhereInput = { status: filter.status };
  const [items, total] = await Promise.all([
    prisma.breachReview.findMany({ where, orderBy: { requestedAt: 'asc' }, skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize }),
    prisma.breachReview.count({ where }),
  ]);
  return { items, total, page: filter.page, pageSize: filter.pageSize };
}

export async function resolveBreachReview(id: string, actorId: string, decision: 'APPROVED' | 'REJECTED', note: string) {
  const review = await prisma.breachReview.findUnique({ where: { id } });
  if (!review) throw ApiError.notFound('Breach review not found');
  if (review.status !== 'OPEN') throw ApiError.conflict('This review was already resolved');

  const updated = await prisma.breachReview.update({
    where: { id },
    data: { status: decision, resolvedById: actorId, resolvedAt: new Date(), resolutionNote: note },
  });
  await audit({ actorId, action: `breach_review.${decision.toLowerCase()}`, entity: 'BreachReview', entityId: id, metadata: { accountId: review.accountId, note } });
  return updated;
}