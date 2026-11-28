import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { toD } from '../../utils/decimal';

// Rule columns of a plan. An account (or an unpaid purchase) keeps the rules of the plan row it was bought with, so a change of
// one of these values on a plan that is already in use creates a NEW plan version instead of editing the row in place.
const DECIMAL_RULES = ['accountSize', 'profitTargetPct', 'dailyLossPct', 'maxDrawdownPct', 'maxLeverage'] as const;
const OTHER_RULES = ['grossExposureMultiple', 'minTradingDays', 'dailyLossMethod', 'drawdownType'] as const;

export interface PlanUpdateResult {
  plan: Awaited<ReturnType<typeof prisma.plan.update>>;
  // True when a new rule version was created (the old row is deactivated and keeps serving its existing accounts)
  versioned: boolean;
  previousPlanId?: string;
}

export async function updatePlanVersioned(planId: string, patch: Record<string, unknown>): Promise<PlanUpdateResult> {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    const current = plan as unknown as Record<string, unknown>;

    const changesRules =
      DECIMAL_RULES.some((f) => patch[f] !== undefined && !toD(patch[f] as string | number).eq(toD(current[f] as string | number))) ||
      OTHER_RULES.some((f) => patch[f] !== undefined && patch[f] !== current[f]);

    const inUse = changesRules && ((await tx.tradingAccount.count({ where: { planId } })) > 0 || (await tx.purchase.count({ where: { planId } })) > 0);

    // Price, name, description and the active flag, or a plan nobody has used yet: edited in place as before
    if (!inUse) return { plan: await tx.plan.update({ where: { id: planId }, data: patch as Prisma.PlanUpdateInput }), versioned: false };

    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = plan;
    const next = await tx.plan.create({
      data: {
        ...(rest as Prisma.PlanUncheckedCreateInput),
        ...(patch as Prisma.PlanUncheckedCreateInput),
        ruleVersion: plan.ruleVersion + 1,
        supersedesId: plan.id,
      },
    });
    // The old version stays in the database for its accounts but can no longer be bought
    await tx.plan.update({ where: { id: planId }, data: { isActive: false } });
    return { plan: next, versioned: true, previousPlanId: planId };
  });
}