import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/config/prisma';
import { applyPendingFunding, captureFundingBoundary } from '../../src/modules/markets/funding.service';
import { syncMarkets } from '../../src/modules/markets/market.service';
import { lockAccount } from '../../src/modules/risk/risk.service';
import { sweepSymbol } from '../../src/modules/trading/order-matcher';
import * as trading from '../../src/modules/trading/trading.service';
import { Decimal, toD } from '../../src/utils/decimal';
import { balanceOf, createAccount, createMarket, expectLedgerBalanced, positionOf, resetSettings, setMarket, wipeDatabase } from './helpers';

const d = (v: Decimal.Value) => new Decimal(v);
const HOUR = new Date('2026-11-20T11:00:00.000Z');

let userId: string;
let accountId: string;
const buy = (size: string, uid = userId, acc = accountId) =>
  trading.placeOrder(uid, { accountId: acc, symbol: 'BTC', side: 'BUY', type: 'MARKET', size: d(size), leverage: 10, reduceOnly: false });
const sell = (size: string, uid = userId, acc = accountId) =>
  trading.placeOrder(uid, { accountId: acc, symbol: 'BTC', side: 'SELL', type: 'MARKET', size: d(size), leverage: 10, reduceOnly: false });

beforeAll(async () => {
  await wipeDatabase();
});

beforeEach(async () => {
  await wipeDatabase();
  await resetSettings();
  await createMarket({ maxNotionalUsd: 1_000_000, isEnabled: true, isCloseOnly: false });
  setMarket('BTC', { bids: [[89990, 10]], asks: [[90000, 10]], mark: 90000, oracle: 90000 });
  ({ userId, accountId } = await createAccount());
});

afterEach(() => vi.unstubAllGlobals());

describe('funding', () => {
  const setRate = async (rate: string) => {
    const market = await prisma.market.findUniqueOrThrow({ where: { symbol: 'BTC' } });
    await prisma.fundingRate.create({ data: { marketId: market.id, hourStart: HOUR, rate } });
  };

  it('charges a long and pays a short the FULL hourly amount, once', async () => {
    const other = await createAccount();
    await buy('1');
    await sell('1', other.userId, other.accountId);
    const longBefore = await balanceOf(accountId);
    const shortBefore = await balanceOf(other.accountId);

    expect(await captureFundingBoundary(HOUR)).toBe(2);
    expect(await captureFundingBoundary(HOUR)).toBe(0); // replay creates nothing
    await setRate('0.0001');

    expect(await applyPendingFunding(HOUR.getTime() + 60_000)).toBe(2);
    expect(await applyPendingFunding(HOUR.getTime() + 120_000)).toBe(0); // nothing posted twice

    expect((await balanceOf(accountId)).toString()).toBe(longBefore.minus(9).toString());
    expect((await balanceOf(other.accountId)).toString()).toBe(shortBefore.plus(9).toString());
    const entries = await prisma.ledgerEntry.findMany({ where: { accountId, type: 'FUNDING' } });
    expect(entries).toHaveLength(1);
    expect(toD(entries[0].amount).toString()).toBe('-9');
    await expectLedgerBalanced(accountId);
    await expectLedgerBalanced(other.accountId);
  });

  it('reverses on a negative rate and uses the size open at the boundary', async () => {
    await buy('1');
    await sell('0.6'); // 0.4 left at the boundary
    await captureFundingBoundary(HOUR);
    await setRate('-0.0001');
    await applyPendingFunding(HOUR.getTime() + 60_000);
    const e = await prisma.ledgerEntry.findFirstOrThrow({ where: { accountId, type: 'FUNDING' } });
    expect(toD(e.amount).toString()).toBe('3.6'); // 0.4 x 90,000 x 0.0001, received
  });

  it('pays nothing for a position that was closed before the boundary', async () => {
    await buy('1');
    await sell('1');
    expect(await captureFundingBoundary(HOUR)).toBe(0);
  });

  it('never invents a zero rate: the payment stays pending until the rate is published', async () => {
    await buy('1');
    await captureFundingBoundary(HOUR);
    // Hyperliquid has no rate for this hour (404 = no retry)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await applyPendingFunding(HOUR.getTime() + 60_000)).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { accountId, type: 'FUNDING' } })).toBe(0);
    expect((await prisma.fundingPayment.findFirstOrThrow({ where: { accountId } })).appliedAt).toBeNull();

    // The official rate arrives from the funding history endpoint
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ coin: 'BTC', fundingRate: '0.0002', premium: '0', time: HOUR.getTime() + 15 }] })));
    expect(await applyPendingFunding(HOUR.getTime() + 120_000)).toBe(1);
    const e = await prisma.ledgerEntry.findFirstOrThrow({ where: { accountId, type: 'FUNDING' } });
    expect(toD(e.amount).toString()).toBe('-18');
    expect((await prisma.fundingRate.count())).toBe(1);
  });

  it('posts the funding when it pushes equity onto a floor, and the risk engine reacts', async () => {
    const tiny = await createAccount({ balance: 10_000 });
    await prisma.plan.updateMany({ data: { dailyLossPct: 0.5 } }); // 0.5 percent of 10,000 = 50 USD per day
    await buy('1', tiny.userId, tiny.accountId);
    await captureFundingBoundary(HOUR);
    await setRate('0.0002'); // -18 USD for the long
    await applyPendingFunding(HOUR.getTime() + 60_000);
    const account = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: tiny.accountId } });
    expect(account.status).toBe('BREACHED');
  });
});

describe('forced close by the risk engine', () => {
  it('cancels working orders and closes positions with the last price when the feed is stale', async () => {
    await buy('1');
    const resting = await trading.placeOrder(userId, { accountId, symbol: 'BTC', side: 'BUY', type: 'LIMIT', size: d('0.1'), limitPrice: d('89000'), leverage: 10, reduceOnly: false });
    setMarket('BTC', { bids: [[89990, 10]], asks: [[90000, 10]], mark: 90000, bookAgeMs: 60_000, markAgeMs: 60_000 });

    await lockAccount(accountId, 'DISABLED', 'MANUAL_LOCK', 'test lock');
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: resting.order.id } });
    expect(order.status).toBe('CANCELED');
    expect(order.cancelReason).toBe('RISK_MANUAL_LOCK');
    expect((await prisma.tradingAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe('DISABLED');
    expect((await prisma.fill.findMany({ where: { accountId } })).some((f) => f.rulesVersion?.includes('forced-close'))).toBe(true);
    await expectLedgerBalanced(accountId);

    // a locked account cannot trade and its orders never fill
    setMarket('BTC', { bids: [[89990, 10]], asks: [[90000, 10]], mark: 90000 });
    await expect(buy('0.1')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
    await sweepSymbol('BTC');
  });
});

describe('market sync (Hyperliquid metadata)', () => {
  const meta = (extra: Record<string, unknown>[] = []) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        universe: [
          { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
          { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
          ...extra,
        ],
      }),
    }));

  beforeEach(async () => {
    // These tests create the market rows themselves
    await wipeDatabase();
  });

  it('creates BTC and ETH with the reviewed limits and exact exchange precision', async () => {
    vi.stubGlobal('fetch', meta());
    expect(await syncMarkets()).toBe(2);
    const btc = await prisma.market.findUniqueOrThrow({ where: { symbol: 'BTC' } });
    expect(btc.hlKey).toBe('BTC');
    expect(btc.isEnabled).toBe(true);
    expect(btc.maxLeverage).toBe(10); // min(Hyperliquid 40, reviewed 10)
    expect(btc.maxNotionalUsd?.toString()).toBe('1000000');
    expect(btc.pricePrecision).toBe(1);
    expect(btc.sizeStep.toString()).toBe('0.00001');
    expect(btc.priceTick.toString()).toBe('0.1');
    const eth = await prisma.market.findUniqueOrThrow({ where: { symbol: 'ETH' } });
    expect(eth.pricePrecision).toBe(2);
    expect(eth.sizeStep.toString()).toBe('0.0001');
  });

  it('keeps admin edits, lowers leverage when Hyperliquid lowers it, and handles delisting', async () => {
    vi.stubGlobal('fetch', meta());
    await syncMarkets();
    await prisma.market.update({ where: { symbol: 'BTC' }, data: { maxNotionalUsd: 5000, isHalted: true, riskTierVersion: 'admin-1' } });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 5 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25, isDelisted: true }] }) })));
    await syncMarkets();
    const btc = await prisma.market.findUniqueOrThrow({ where: { symbol: 'BTC' } });
    expect(btc.maxNotionalUsd?.toString()).toBe('5000'); // admin value kept
    expect(btc.isHalted).toBe(true);
    expect(btc.maxLeverage).toBe(5); // a lower exchange limit always wins
    const eth = await prisma.market.findUniqueOrThrow({ where: { symbol: 'ETH' } });
    expect(eth.isCloseOnly).toBe(true);
    expect(eth.delistedAt).not.toBeNull();
  });

  it('applies the reviewed limits once to rows made by an older version', async () => {
    await prisma.market.create({
      data: { symbol: 'BTC', baseAsset: 'BTC', hlKey: 'BTC', szDecimals: 5, pricePrecision: 1, minSize: '0.00001', maxLeverage: 40, isEnabled: true },
    });
    vi.stubGlobal('fetch', meta());
    await syncMarkets();
    const btc = await prisma.market.findUniqueOrThrow({ where: { symbol: 'BTC' } });
    expect(btc.maxLeverage).toBe(10);
    expect(btc.maxNotionalUsd?.toString()).toBe('1000000');
    expect(btc.riskTierVersion).toBe('catalog-1');
  });
});
