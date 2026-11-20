import { randomBytes } from 'node:crypto';
import type { PositionMode } from '@prisma/client';
import { prisma } from '../../src/config/prisma';
import { priceFeed } from '../../src/modules/markets/price-feed';
import { postLedgerEntry } from '../../src/modules/ledger/ledger.service';
import { saveSetting } from '../../src/modules/settings/settings.service';
import { Decimal, toD } from '../../src/utils/decimal';

// Shared helpers for the database tests. They WIPE the trading tables, so they refuse to run
// against a database whose name does not contain "test".

export function assertTestDatabase() {
  const name = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname;
  if (!/test/i.test(name)) throw new Error(`Refusing to run database tests on "${name}". Use a database with "test" in its name.`);
}

export async function wipeDatabase() {
  assertTestDatabase();
  await prisma.$executeRawUnsafe(
    'TRUNCATE "FundingPayment","FundingRate","Fill","Order","Position","LedgerEntry","RiskEvent","AuditLog","TradingAccount","Plan","Market","PlatformSetting","User" CASCADE',
  );
}

export const lv = (px: string | number, sz: string | number) => ({ px: String(px), sz: String(sz), n: 1 });

let exchangeClock = 1_000;

// Replaces the live feed of a symbol (book + mark). "age" makes the data look older.
export function setMarket(
  symbol: string,
  data: { bids?: Array<[number, number]>; asks?: Array<[number, number]>; mark?: number; oracle?: number; funding?: string; bookAgeMs?: number; markAgeMs?: number },
) {
  const now = Date.now();
  const bids = data.bids ?? [[89990, 10], [89980, 10]];
  const asks = data.asks ?? [[90000, 10], [90010, 10]];
  priceFeed.ingestBook(symbol, bids.map(([p, s]) => lv(p, s)), asks.map(([p, s]) => lv(p, s)), ++exchangeClock, now - (data.bookAgeMs ?? 0));
  const mark = data.mark ?? 90000;
  priceFeed.ingestMark(symbol, { markPx: String(mark), oraclePx: String(data.oracle ?? mark), funding: data.funding ?? '0.0000125' }, now - (data.markAgeMs ?? 0));
}

export async function createMarket(overrides: Record<string, unknown> = {}) {
  return prisma.market.upsert({
    where: { symbol: 'BTC' },
    create: {
      symbol: 'BTC',
      baseAsset: 'BTC',
      hlKey: 'BTC',
      marketType: 'CRYPTO',
      szDecimals: 5,
      pricePrecision: 1,
      priceTick: '0.1',
      sizeStep: '0.00001',
      minSize: '0.00001',
      minNotionalUsd: 10,
      maxNotionalUsd: 1_000_000,
      maxLeverage: 10,
      isEnabled: true,
      ...overrides,
    },
    update: overrides,
  });
}

export async function createAccount(options: { balance?: number; mode?: PositionMode } = {}) {
  const balance = options.balance ?? 100_000;
  const user = await prisma.user.create({
    data: { email: `t-${randomBytes(6).toString('hex')}@test.local`, referralCode: randomBytes(5).toString('hex').toUpperCase() },
  });
  // Generous rules: the tests are about the trading engine, not about breaches
  const plan = await prisma.plan.create({
    data: { name: 'Test', accountSize: balance, price: 100, profitTargetPct: 1000, dailyLossPct: 90, maxDrawdownPct: 95, maxLeverage: 20 },
  });
  const account = await prisma.tradingAccount.create({
    data: {
      userId: user.id,
      planId: plan.id,
      startingBalance: balance,
      highWaterMark: balance,
      dayStartBalance: balance,
      dayStartEquity: balance,
      positionMode: options.mode ?? 'ONE_WAY',
    },
  });
  await prisma.$transaction((tx) =>
    postLedgerEntry(tx, { accountId: account.id, type: 'DEPOSIT', amount: new Decimal(balance), idempotencyKey: `test:${account.id}:deposit` }),
  );
  return { userId: user.id, accountId: account.id };
}

export async function balanceOf(accountId: string): Promise<Decimal> {
  return toD((await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } })).balance);
}

// The cached balance must always equal the sum of the ledger.
export async function expectLedgerBalanced(accountId: string) {
  const sum = await prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amount: true } });
  const balance = await balanceOf(accountId);
  const ledger = toD(sum._sum.amount ?? 0);
  if (!balance.eq(ledger)) throw new Error(`Ledger mismatch: balance ${balance.toString()} vs ledger ${ledger.toString()}`);
}

export async function resetSettings() {
  await saveSetting('trading', {});
}

export async function positionOf(accountId: string, side?: 'LONG' | 'SHORT') {
  const rows = await prisma.position.findMany({ where: { accountId, ...(side ? { side } : {}) } });
  return rows;
}

// Runs a promise and returns the ApiError code it was rejected with
export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return 'NO_ERROR';
}
