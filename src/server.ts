import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { startJobs, stopJobs } from './jobs';
import { getEnabledSymbols, syncMarkets } from './modules/markets/market.service';
import { priceFeed } from './modules/markets/price-feed';

async function main() {
  await prisma.$connect();

  // Step 4: load market details and start live prices (BTC and ETH first)
  try {
    await syncMarkets();
  } catch (err) {
    logger.error({ err }, 'Market sync failed, continuing with markets already in the database');
  }
  priceFeed.start(await getEnabledSymbols());

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  if (env.ENABLE_JOBS) startJobs();

  // Graceful shutdown so in-flight requests and transactions can finish
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopJobs();
    priceFeed.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
