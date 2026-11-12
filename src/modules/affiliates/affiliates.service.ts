import { prisma, type Tx } from '../../config/prisma';
import { toD } from '../../utils/decimal';
import { getSetting } from '../settings/settings.service';

// Creates the referral commission when a referred user's purchase is paid.
// The unique purchaseId column guarantees one commission per purchase.
export async function createCommissionForPurchase(tx: Tx, purchaseId: string) {
  const purchase = await tx.purchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: { user: { select: { referredById: true } } },
  });
  const affiliateId = purchase.user.referredById;
  if (!affiliateId || affiliateId === purchase.userId) return; // basic fraud check

  const existing = await tx.commission.findUnique({ where: { purchaseId } });
  if (existing) return;

  const { commissionPct } = await getSetting('affiliate');
  const amount = toD(purchase.amount).mul(commissionPct).div(100);
  await tx.commission.create({
    data: { affiliateUserId: affiliateId, purchaseId, amount: amount.toFixed() },
  });
}

export async function getAffiliateSummary(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
  const [referrals, commissions] = await Promise.all([
    prisma.user.count({ where: { referredById: userId } }),
    prisma.commission.findMany({ where: { affiliateUserId: userId }, orderBy: { createdAt: 'desc' } }),
  ]);

  const sum = (status: string) =>
    commissions.filter((c) => c.status === status).reduce((s, c) => s.plus(toD(c.amount)), toD(0)).toString();

  return {
    referralCode: user.referralCode,
    referrals,
    pending: sum('PENDING'),
    approved: sum('APPROVED'),
    paid: sum('PAID'),
    commissions,
  };
}
