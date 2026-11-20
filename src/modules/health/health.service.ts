import { prisma } from '../../config/prisma';
import { priceFeed } from '../markets/price-feed';

// Used by the public /health endpoint (load balancer) and by the admin
// "System Health" page, so every server problem is visible in one place.
export async function getHealth(detailed = false) {
  let database = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'down';
  }
  const feed = priceFeed.status();
  const status = database === 'ok' && feed.connected ? 'ok' : 'degraded';

  if (!detailed) return { status, database, priceFeed: feed.connected ? 'ok' : 'down' };

  const [pendingPayouts, needsReview, breached24h] = await Promise.all([
    prisma.payout.count({ where: { status: 'REQUESTED' } }),
    prisma.purchase.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.riskEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
  ]);

  return {
    status,
    database,
    priceFeed: feed,
    prices: priceFeed.allPrices().map((p) => ({
      symbol: p.symbol,
      ageMs: Date.now() - p.ts,
      fresh: priceFeed.isFresh(p.symbol),
      bookFresh: priceFeed.isBookFresh(p.symbol),
      markFresh: priceFeed.isMarkFresh(p.symbol),
    })),
    queues: { pendingPayouts, purchasesNeedingReview: needsReview, riskEventsLast24h: breached24h },
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
