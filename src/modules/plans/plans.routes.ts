import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma';

// Public list of challenge plans for the pricing page.
export async function planRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { accountSize: 'asc' } });
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      accountSize: p.accountSize.toString(),
      price: p.price.toString(),
      profitTargetPct: p.profitTargetPct.toString(),
      dailyLossPct: p.dailyLossPct.toString(),
      maxDrawdownPct: p.maxDrawdownPct.toString(),
      maxLeverage: p.maxLeverage,
      minTradingDays: p.minTradingDays,
    }));
  });
}
