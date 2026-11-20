import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/prisma';
import { saveSetting } from '../../src/modules/settings/settings.service';
import { sweepSymbol } from '../../src/modules/trading/order-matcher';
import * as trading from '../../src/modules/trading/trading.service';
import { Decimal, toD } from '../../src/utils/decimal';
import { balanceOf, createAccount, createMarket, errorCode, expectLedgerBalanced, positionOf, resetSettings, setMarket, wipeDatabase } from './helpers';

const d = (v: Decimal.Value) => new Decimal(v);
const BIG_BOOK = { bids: [[89990, 10], [89980, 10]] as Array<[number, number]>, asks: [[90000, 10], [90010, 10]] as Array<[number, number]>, mark: 90000 };

let userId: string;
let accountId: string;

const buy = (size: string, extra: Record<string, unknown> = {}) =>
  trading.placeOrder(userId, { accountId, symbol: 'BTC', side: 'BUY', type: 'MARKET', size: d(size), leverage: 10, reduceOnly: false, ...extra });
const sell = (size: string, extra: Record<string, unknown> = {}) =>
  trading.placeOrder(userId, { accountId, symbol: 'BTC', side: 'SELL', type: 'MARKET', size: d(size), leverage: 10, reduceOnly: false, ...extra });
const limit = (side: 'BUY' | 'SELL', size: string, price: string, extra: Record<string, unknown> = {}) =>
  trading.placeOrder(userId, { accountId, symbol: 'BTC', side, type: 'LIMIT', size: d(size), limitPrice: d(price), leverage: 10, reduceOnly: false, ...extra });
const exit = (type: 'TAKE_PROFIT' | 'STOP_LOSS', side: 'BUY' | 'SELL', trigger: string, extra: Record<string, unknown> = {}) =>
  trading.placeOrder(userId, { accountId, symbol: 'BTC', side, type, triggerPrice: d(trigger), leverage: 10, reduceOnly: true, ...extra });

beforeAll(async () => {
  await wipeDatabase();
});

beforeEach(async () => {
  await prisma.order.updateMany({ where: { status: { in: ['NEW', 'PARTIALLY_FILLED'] } }, data: { status: 'CANCELED', reservedMargin: '0' } });
  await resetSettings();
  await createMarket({ maxNotionalUsd: 1_000_000, isHalted: false, isCloseOnly: false, isEnabled: true });
  setMarket('BTC', BIG_BOOK);
  ({ userId, accountId } = await createAccount());
});

describe('market orders (order book fills)', () => {
  it('fills across levels at the VWAP and charges the taker fee', async () => {
    setMarket('BTC', { asks: [[90000, 0.1], [90010, 0.2], [90020, 5]], bids: [[89990, 5]], mark: 90000 });
    const r = await buy('0.3');
    expect(r.order.status).toBe('FILLED');
    expect(r.fills).toHaveLength(1);
    const fill = r.fills[0];
    expect(toD(fill.size).toString()).toBe('0.3');
    expect(toD(fill.price).toFixed(6)).toBe('90006.666667');
    expect(toD(fill.fee).toString()).toBe('10.8008');
    expect(fill.liquidity).toBe('TAKER');
    expect(fill.bookLevels).toEqual([['90000', '0.1'], ['90010', '0.2']]);

    const [pos] = await positionOf(accountId);
    expect(pos.side).toBe('LONG');
    expect(toD(pos.size).toString()).toBe('0.3');
    expect(toD(pos.margin).toString()).toBe('2700.2'); // 27,002 / 10x
    expect((await balanceOf(accountId)).toString()).toBe('99989.1992');
    await expectLedgerBalanced(accountId);
  });

  it('rejects an opening order that the visible book cannot fill completely', async () => {
    setMarket('BTC', { asks: [[90000, 0.5]], bids: [[89990, 5]] });
    expect(await errorCode(buy('2'))).toBe('VISIBLE_BOOK_TOO_THIN');
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
    expect((await balanceOf(accountId)).toString()).toBe('100000');
  });

  it('rejects slippage above the limit, accepts exactly the limit', async () => {
    setMarket('BTC', { asks: [[90000, 0.1], [93100, 5]], bids: [[89990, 5]] });
    expect(await errorCode(buy('1'))).toBe('OPEN_SLIPPAGE_EXCEEDED'); // 3.1 percent

    setMarket('BTC', { asks: [[90000, 0.1], [93000, 5]], bids: [[89990, 5]] });
    expect((await buy('1')).order.status).toBe('FILLED'); // exactly 3.0 percent passes

    setMarket('BTC', { asks: [[90000, 0.1], [93000, 5]], bids: [[89990, 5]] });
    expect(await errorCode(buy('1', { maxSlippagePct: d('0.5') }))).toBe('OPEN_SLIPPAGE_EXCEEDED');
  });

  it('validates size, tick, leverage and minimum order value', async () => {
    expect(await errorCode(buy('0.000001'))).toBe('INVALID_LOT');
    expect(await errorCode(buy('0.0001'))).toBe('BELOW_MIN_NOTIONAL'); // 9 USD
    expect(await errorCode(buy('0.1', { leverage: 20 }))).toBe('LEVERAGE_CAP');
    expect(await errorCode(limit('BUY', '0.1', '89900.15'))).toBe('INVALID_TICK');
  });

  it('is idempotent: the same clientOrderId never creates a second order or fee', async () => {
    const a = await buy('0.1', { clientOrderId: 'abc-1' });
    const b = await buy('0.1', { clientOrderId: 'abc-1' });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.order.id).toBe(a.order.id);
    expect(await prisma.fill.count({ where: { accountId } })).toBe(1);

    const parallel = await Promise.all([1, 2, 3, 4, 5].map(() => buy('0.1', { clientOrderId: 'abc-2' })));
    expect(new Set(parallel.map((p) => p.order.id)).size).toBe(1);
    expect(await prisma.order.count({ where: { accountId } })).toBe(2);
    await expectLedgerBalanced(accountId);
  });

  it('lets only one of two parallel orders use the last margin', async () => {
    const small = await createAccount({ balance: 1000 });
    const place = () =>
      trading.placeOrder(small.userId, { accountId: small.accountId, symbol: 'BTC', side: 'BUY', type: 'MARKET', size: d('0.01'), leverage: 1, reduceOnly: false });
    const results = await Promise.allSettled([place(), place()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('INSUFFICIENT_MARGIN');
    await expectLedgerBalanced(small.accountId);
  });
});

describe('stale prices block trading', () => {
  it('blocks orders when the book is stale, even with a fresh mark', async () => {
    setMarket('BTC', { ...BIG_BOOK, bookAgeMs: 6000 });
    expect(await errorCode(buy('0.1'))).toBe('MARKET_FEED_STALE');
    expect(await errorCode(limit('BUY', '0.1', '89000'))).toBe('MARKET_FEED_STALE');
  });

  it('blocks orders when the mark price is stale, even with a fresh book', async () => {
    setMarket('BTC', { ...BIG_BOOK, markAgeMs: 11_000 });
    expect(await errorCode(buy('0.1'))).toBe('MARKET_FEED_STALE');
  });

  it('still lets a trader cancel an order while the feed is stale', async () => {
    const r = await limit('BUY', '0.1', '89000');
    setMarket('BTC', { ...BIG_BOOK, bookAgeMs: 6000 });
    expect((await trading.cancelOrder(userId, accountId, r.order.id)).status).toBe('CANCELED');
  });

  it('does not fill resting orders on stale data and fills them once data is fresh', async () => {
    const r = await limit('BUY', '0.1', '89900');
    setMarket('BTC', { asks: [[89900, 5]], bids: [[89890, 5]], mark: 89900, bookAgeMs: 6000 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } })).status).toBe('NEW');

    setMarket('BTC', { asks: [[89900, 5]], bids: [[89890, 5]], mark: 89900 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } })).status).toBe('FILLED');
  });
});

describe('limit orders', () => {
  it('rests with a margin reservation and releases it on cancel', async () => {
    const r = await limit('BUY', '0.1', '89900');
    expect(r.order.status).toBe('NEW');
    expect(r.fills).toHaveLength(0);
    // 8,990 / 10x = 899 margin + 3.596 fee buffer
    expect(toD(r.order.reservedMargin).toString()).toBe('902.596');

    const overview = await trading.getAccountOverview(userId, accountId);
    expect(overview.reservedMargin).toBe('902.596');
    expect(overview.availableMargin).toBe('99097.404');

    await trading.cancelOrder(userId, accountId, r.order.id);
    expect((await trading.getAccountOverview(userId, accountId)).reservedMargin).toBe('0');
    expect(toD((await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } })).reservedMargin).toString()).toBe('0');
    // cancelling again is harmless
    expect((await trading.cancelOrder(userId, accountId, r.order.id)).status).toBe('CANCELED');
  });

  it('fills as maker at the limit price when the ask touches it, in parts', async () => {
    const r = await limit('BUY', '0.1', '89900');
    setMarket('BTC', { asks: [[89900, 0.05]], bids: [[89890, 5]], mark: 89900 });
    await sweepSymbol('BTC');

    let order = await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(toD(order.filledSize).toString()).toBe('0.05');
    // reservation follows the remaining 0.05: 4,495 / 10 + 4,495 x 0.0004
    expect(toD(order.reservedMargin).toString()).toBe('451.298');
    const first = await prisma.fill.findFirstOrThrow({ where: { orderId: order.id } });
    expect(toD(first.price).toString()).toBe('89900');
    expect(first.liquidity).toBe('MAKER');
    expect(toD(first.fee).toString()).toBe('0.4495'); // 4,495 x 0.01 percent

    setMarket('BTC', { asks: [[89900, 5]], bids: [[89890, 5]], mark: 89900 });
    await sweepSymbol('BTC');
    order = await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } });
    expect(order.status).toBe('FILLED');
    expect(toD(order.reservedMargin).toString()).toBe('0');
    const [pos] = await positionOf(accountId);
    expect(toD(pos.size).toString()).toBe('0.1');
    expect(toD(pos.margin).toString()).toBe('899');
    expect((await balanceOf(accountId)).toString()).toBe('99999.101'); // 100000 - 0.899 maker fees
    await expectLedgerBalanced(accountId);
  });

  it('does not fill on the mark price alone', async () => {
    const r = await limit('BUY', '0.1', '89900');
    setMarket('BTC', { asks: [[89905, 5]], bids: [[89895, 5]], mark: 89850 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } })).status).toBe('NEW');
  });

  it('rejects post-only orders that would take liquidity', async () => {
    expect(await errorCode(limit('BUY', '0.1', '90010', { postOnly: true }))).toBe('POST_ONLY_WOULD_TAKE');
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
    expect((await limit('BUY', '0.1', '89990', { postOnly: true })).order.status).toBe('NEW');
  });

  it('executes a marketable limit as taker and never above its price', async () => {
    setMarket('BTC', { asks: [[90000, 0.1], [90010, 0.2], [90030, 5]], bids: [[89990, 5]], mark: 90000 });
    const r = await limit('BUY', '0.25', '90020');
    expect(r.order.status).toBe('FILLED');
    expect(toD(r.fills[0].price).toFixed(6)).toBe('90006.000000'); // (9000 + 0.15 x 90010) / 0.25
    expect(r.fills[0].liquidity).toBe('TAKER');
    expect(toD(r.fills[0].fee).toString()).toBe('9.0006');
  });

  it('rests the unfilled rest of a marketable limit and cancels it for IOC', async () => {
    setMarket('BTC', { asks: [[90000, 0.1], [90010, 0.2], [90030, 5]], bids: [[89990, 5]], mark: 90000 });
    const gtc = await limit('BUY', '1', '90010');
    expect(gtc.order.status).toBe('PARTIALLY_FILLED');
    expect(toD(gtc.order.filledSize).toString()).toBe('0.3');
    expect(toD(gtc.order.reservedMargin).gt(0)).toBe(true);

    const ioc = await limit('BUY', '1', '90010', { timeInForce: 'IOC' });
    expect(ioc.order.status).toBe('CANCELED');
    expect(ioc.order.cancelReason).toBe('IOC_REMAINDER');

    const none = await limit('BUY', '1', '80000', { timeInForce: 'IOC' });
    expect(none.order.status).toBe('CANCELED');
    expect(none.order.cancelReason).toBe('NO_LIQUIDITY');
  });

  it('modifies by validating the replacement first, then cancelling the old order', async () => {
    const r = await limit('BUY', '0.1', '89900');
    expect(await errorCode(trading.modifyOrder(userId, accountId, r.order.id, { limitPrice: d('89900.15') }))).toBe('INVALID_TICK');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } })).status).toBe('NEW');

    const m = await trading.modifyOrder(userId, accountId, r.order.id, { limitPrice: d('89800') });
    expect(m.order.id).not.toBe(r.order.id);
    const old = await prisma.order.findUniqueOrThrow({ where: { id: r.order.id } });
    expect(old.status).toBe('CANCELED');
    expect(old.cancelReason).toBe(`REPLACED_BY:${m.order.id}`);
    // only the replacement holds margin: 8,980 / 10 + 8,980 x 0.0004
    expect((await trading.getAccountOverview(userId, accountId)).reservedMargin).toBe('901.592');
  });

  it('enforces the open order limit and cancel-all', async () => {
    await saveSetting('trading', { maxOpenOrders: 2 });
    await limit('BUY', '0.01', '89000');
    await limit('SELL', '0.01', '91000');
    expect(await errorCode(limit('BUY', '0.01', '88000'))).toBe('OPEN_ORDER_LIMIT');
    expect((await trading.cancelAllOrders(userId, accountId, { side: 'SELL' })).canceled).toBe(1);
    expect((await trading.cancelAllOrders(userId, accountId)).canceled).toBe(1);
    expect(await trading.listOrders(userId, accountId, { active: true })).toHaveLength(0);
  });

  it('reports ORDER_ALREADY_FILLED when cancelling a filled order', async () => {
    const r = await buy('0.1');
    expect(await errorCode(trading.cancelOrder(userId, accountId, r.order.id))).toBe('ORDER_ALREADY_FILLED');
  });
});

describe('positions: one-way mode', () => {
  it('reduces, then reverses, and books realized PnL and fees', async () => {
    await buy('1'); // 1 BTC at 90,000, fee 36
    const r1 = await sell('0.4'); // 0.4 at 89,990
    expect(toD(r1.fills[0].realizedPnl).toString()).toBe('-4');
    expect(toD(r1.fills[0].fee).toString()).toBe('14.3984');

    let [pos] = await positionOf(accountId, 'LONG');
    expect(toD(pos.size).toString()).toBe('0.6');
    expect(toD(pos.margin).toString()).toBe('5400'); // margin shrinks with the position

    const r2 = await sell('1.4'); // closes 0.6 and opens a 0.8 short
    expect(toD(r2.fills[0].realizedPnl).toString()).toBe('-6');
    expect(toD(r2.fills[0].fee).toString()).toBe('50.3944'); // 1.4 x 89,990 x 0.04 percent
    [pos] = await positionOf(accountId, 'LONG');
    expect(toD(pos.size).toString()).toBe('0');
    expect(pos.status).toBe('CLOSED');
    const [short] = await positionOf(accountId, 'SHORT');
    expect(toD(short.size).toString()).toBe('0.8');
    expect(toD(short.margin).toString()).toBe('7199.2');
    // 100000 - 36 - 4 - 14.3984 - 6 - 50.3944
    expect((await balanceOf(accountId)).toString()).toBe('99889.2072');
    await expectLedgerBalanced(accountId);
  });

  it('averages the entry price when adding and keeps both margins', async () => {
    await buy('1');
    setMarket('BTC', { asks: [[92000, 10]], bids: [[91990, 10]], mark: 92000 });
    await buy('1', { leverage: 5 });
    const [pos] = await positionOf(accountId);
    expect(toD(pos.size).toString()).toBe('2');
    expect(toD(pos.entryPrice).toString()).toBe('91000');
    expect(toD(pos.margin).toString()).toBe('27400'); // 9,000 (10x) + 18,400 (5x)
  });

  it('only allows reduce-only orders that reduce an existing position', async () => {
    expect(await errorCode(sell('1', { reduceOnly: true }))).toBe('NO_POSITION');
    await buy('1');
    expect(await errorCode(sell('2', { reduceOnly: true }))).toBe('REDUCE_ONLY_EXCESS');
    expect((await sell('1', { reduceOnly: true })).order.status).toBe('FILLED');
  });

  it('closes a position partially and fully, with a partial fill on a thin book', async () => {
    await buy('1');
    const half = await trading.closePosition(userId, accountId, 'BTC', { size: d('0.25') });
    expect(toD(half.fills[0].size).toString()).toBe('0.25');
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0.75');

    setMarket('BTC', { bids: [[89990, 0.2]], asks: [[90000, 10]], mark: 90000 });
    const thin = await trading.closePosition(userId, accountId, 'BTC');
    expect(thin.order.status).toBe('CANCELED');
    expect(thin.order.cancelReason).toBe('PARTIAL_DEPTH');
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0.55'); // 0.75 - 0.2 still open
    await expectLedgerBalanced(accountId);
  });

  it('close-all reports each market and never fakes a closed position', async () => {
    await buy('0.5');
    setMarket('BTC', { bids: [[89990, 0.2]], asks: [[90000, 10]] });
    const r = await trading.closeAllPositions(userId, accountId);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].closed).toBe('0.2');
    expect(r.results[0].remaining).toBe('0.3');
  });
});

describe('positions: hedge mode', () => {
  it('keeps an independent long and short and charges margin on both', async () => {
    expect((await trading.setPositionMode(userId, accountId, 'HEDGE')).positionMode).toBe('HEDGE');
    expect(await errorCode(buy('1'))).toBe('POSITION_SIDE_REQUIRED');

    await buy('1', { positionSide: 'LONG' });
    await sell('0.4', { positionSide: 'SHORT' });
    const rows = await prisma.position.findMany({ where: { accountId, size: { gt: 0 } } });
    expect(rows.map((r) => r.side).sort()).toEqual(['LONG', 'SHORT']);
    const overview = await trading.getAccountOverview(userId, accountId);
    expect(overview.marginUsed).toBe('12599.6'); // 9,000 + 3,599.6
    expect(overview.grossExposure).toBe('126000'); // both legs count: 1.4 x 90,000
  });

  it('SELL on the long leg only reduces it and never opens a short', async () => {
    await trading.setPositionMode(userId, accountId, 'HEDGE');
    await buy('1', { positionSide: 'LONG' });
    expect(await errorCode(sell('1.2', { positionSide: 'LONG' }))).toBe('REDUCE_ONLY_EXCESS');
    await sell('0.5', { positionSide: 'LONG' });
    expect((await positionOf(accountId, 'SHORT')).filter((r) => toD(r.size).gt(0))).toHaveLength(0);
  });

  it('can only change the position mode on a flat account without working orders', async () => {
    await limit('BUY', '0.1', '89000');
    expect(await errorCode(trading.setPositionMode(userId, accountId, 'HEDGE'))).toBe('POSITION_MODE_LOCKED');
    await trading.cancelAllOrders(userId, accountId);
    await buy('0.1');
    expect(await errorCode(trading.setPositionMode(userId, accountId, 'HEDGE'))).toBe('POSITION_MODE_LOCKED');
  });
});

describe('stop-loss, take-profit and stop entries', () => {
  it('arms a stop-loss, rejects triggers on the wrong side, and fills from the book (not at the trigger)', async () => {
    await buy('1');
    expect(await errorCode(exit('STOP_LOSS', 'SELL', '90500', { closePosition: true }))).toBe('TRIGGER_WOULD_FIRE');
    const sl = await exit('STOP_LOSS', 'SELL', '89000', { closePosition: true });
    expect(sl.order.status).toBe('NEW');

    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: sl.order.id } })).status).toBe('NEW'); // armed, not executed

    setMarket('BTC', { bids: [[89000, 0.5], [88900, 5]], asks: [[89010, 5]], mark: 89500 });
    await sweepSymbol('BTC');
    const done = await prisma.order.findUniqueOrThrow({ where: { id: sl.order.id } });
    expect(done.status).toBe('FILLED');
    expect(toD(done.avgFillPrice!).toString()).toBe('88950'); // slipped below the 89,000 trigger
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0');
    // realized -1,050; fees 36 (entry) + 35.58 (exit at the FILL price)
    expect((await balanceOf(accountId)).toString()).toBe('98878.42');
    await expectLedgerBalanced(accountId);
  });

  it('fires a take-profit when the BID touches the level even if the mark is lower', async () => {
    await buy('1');
    const tp = await exit('TAKE_PROFIT', 'SELL', '91000', { closePosition: true });
    setMarket('BTC', { bids: [[91000, 5]], asks: [[91010, 5]], mark: 90990 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: tp.order.id } })).status).toBe('FILLED');
  });

  it('a full close cancels the opposite exit order', async () => {
    await buy('1');
    const tp = await exit('TAKE_PROFIT', 'SELL', '91000', { closePosition: true });
    const sl = await exit('STOP_LOSS', 'SELL', '89000', { closePosition: true });
    setMarket('BTC', { bids: [[91000, 5]], asks: [[91010, 5]], mark: 91000 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: tp.order.id } })).status).toBe('FILLED');
    const other = await prisma.order.findUniqueOrThrow({ where: { id: sl.order.id } });
    expect(other.status).toBe('CANCELED');
    expect(other.cancelReason).toBe('POSITION_CLOSED');
  });

  it('keeps the unfilled rest of a partial stop armed when the book is thin', async () => {
    await buy('0.5');
    const sl = await exit('STOP_LOSS', 'SELL', '89000', { size: d('0.4') });
    setMarket('BTC', { bids: [[89000, 0.2]], asks: [[89010, 5]], mark: 89000 });
    await sweepSymbol('BTC');

    let order = await prisma.order.findUniqueOrThrow({ where: { id: sl.order.id } });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(toD(order.filledSize).toString()).toBe('0.2');
    expect(order.triggeredAt).not.toBeNull();
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0.3');

    // Liquidity returns far from the trigger: the already fired order keeps working
    setMarket('BTC', { bids: [[88800, 5]], asks: [[88810, 5]], mark: 88805 });
    await sweepSymbol('BTC');
    order = await prisma.order.findUniqueOrThrow({ where: { id: sl.order.id } });
    expect(order.status).toBe('FILLED');
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0.1');
  });

  it('validates exit sizes and counts', async () => {
    await buy('1');
    await exit('TAKE_PROFIT', 'SELL', '91000', { size: d('0.6') });
    expect(await errorCode(exit('TAKE_PROFIT', 'SELL', '92000', { size: d('0.5') }))).toBe('EXIT_SIZE_EXCEEDS_POSITION');
    expect(await errorCode(exit('TAKE_PROFIT', 'SELL', '92000', { closePosition: true }))).toBe('EXIT_SIZE_EXCEEDS_POSITION');
    expect(await errorCode(exit('STOP_LOSS', 'SELL', '89000', { size: d('1.5') }))).toBe('REDUCE_ONLY_EXCESS');
  });

  it('limits the number of exit orders per position', async () => {
    await buy('1');
    for (let i = 0; i < 10; i++) await exit('TAKE_PROFIT', 'SELL', String(91000 + i * 10), { size: d('0.1') });
    expect(await errorCode(exit('STOP_LOSS', 'SELL', '89000', { size: d('0.1') }))).toBe('EXIT_LEG_LIMIT');
  });

  it('opens a position from a stop entry and rechecks the margin at trigger time', async () => {
    const stop = await trading.placeOrder(userId, {
      accountId, symbol: 'BTC', side: 'BUY', type: 'STOP_MARKET', size: d('0.1'), triggerPrice: d('91000'), leverage: 10, reduceOnly: false,
    });
    expect(toD(stop.order.reservedMargin).toString()).toBe('0'); // nothing reserved before it fires
    setMarket('BTC', { asks: [[91000, 5]], bids: [[90990, 5]], mark: 90995 });
    await sweepSymbol('BTC');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: stop.order.id } })).status).toBe('FILLED');
    expect(toD((await positionOf(accountId))[0].size).toString()).toBe('0.1');
  });

  it('rejects the activation of a stop entry when the margin is gone', async () => {
    setMarket('BTC', BIG_BOOK);
    const small = await createAccount({ balance: 1000 });
    const stop = await trading.placeOrder(small.userId, {
      accountId: small.accountId, symbol: 'BTC', side: 'BUY', type: 'STOP_MARKET', size: d('0.1'), triggerPrice: d('91000'), leverage: 1, reduceOnly: false,
    });
    setMarket('BTC', { asks: [[91000, 5]], bids: [[90990, 5]], mark: 90995 });
    await sweepSymbol('BTC');
    const done = await prisma.order.findUniqueOrThrow({ where: { id: stop.order.id } });
    expect(done.status).toBe('REJECTED');
    expect(done.rejectReason).toBe('INSUFFICIENT_MARGIN');
    expect(await prisma.fill.count({ where: { accountId: small.accountId } })).toBe(0);
  });
});

describe('margin, caps and exposure', () => {
  it('rejects above the per-symbol notional cap', async () => {
    await createMarket({ maxNotionalUsd: 100_000 });
    expect(await errorCode(buy('1.2'))).toBe('POSITION_CAP');
  });

  it('rejects when total exposure would exceed 10x equity', async () => {
    const small = await createAccount({ balance: 10_000 });
    const r = trading.placeOrder(small.userId, { accountId: small.accountId, symbol: 'BTC', side: 'BUY', type: 'MARKET', size: d('1.2'), leverage: 10, reduceOnly: false });
    expect(await errorCode(r)).toBe('GROSS_EXPOSURE_CAP');
  });

  it('rejects when free margin is not enough', async () => {
    const small = await createAccount({ balance: 10_000 });
    const r = trading.placeOrder(small.userId, { accountId: small.accountId, symbol: 'BTC', side: 'BUY', type: 'MARKET', size: d('0.5'), leverage: 1, reduceOnly: false });
    expect(await errorCode(r)).toBe('INSUFFICIENT_MARGIN');
  });

  it('flags OVER_CAP after a price move, blocks new exposure but still allows closing', async () => {
    const small = await createAccount({ balance: 10_000 });
    const open = (side: 'BUY' | 'SELL', size: string, reduceOnly = false) =>
      trading.placeOrder(small.userId, { accountId: small.accountId, symbol: 'BTC', side, type: 'MARKET', size: d(size), leverage: 10, reduceOnly });
    await open('BUY', '1'); // 90k notional on 10k equity = 9x
    setMarket('BTC', { bids: [[84990, 10]], asks: [[85000, 10]], mark: 85000 });

    const view = await trading.getAccountOverview(small.userId, small.accountId);
    expect(view.overCap).toBe(true);
    expect(await errorCode(open('BUY', '0.1'))).toBe('GROSS_EXPOSURE_CAP');
    expect((await open('SELL', '0.5', true)).order.status).toBe('FILLED');
    expect((await trading.getAccountOverview(small.userId, small.accountId)).positions).toHaveLength(1);
  });

  it('reports cross margin: equity, maintenance reference and no liquidation price', async () => {
    await buy('0.5'); // 45,000 notional, 4,500 margin
    setMarket('BTC', { bids: [[90990, 10]], asks: [[91000, 10]], mark: 91000 });
    const v = await trading.getAccountOverview(userId, accountId);
    expect(v.marginUsed).toBe('4500');
    expect(v.maintenanceMarginRef).toBe('2250');
    expect(v.unrealizedPnl).toBe('500');
    expect(v.positions[0].liquidationPrice).toBeNull();
    expect(toD(v.equity).toString()).toBe(toD(v.balance).plus(500).toString());
  });

  it('blocks new exposure on a close-only market but allows reducing', async () => {
    await buy('0.1');
    await createMarket({ isCloseOnly: true });
    expect(await errorCode(buy('0.1'))).toBe('MARKET_CLOSE_ONLY');
    expect((await sell('0.1', { reduceOnly: true })).order.status).toBe('FILLED');
  });

  it('blocks new exposure when trading is paused by the kill switch', async () => {
    await saveSetting('killSwitches', { pauseTrading: true });
    expect(await errorCode(buy('0.1'))).toBe('TRADING_PAUSED');
    await saveSetting('killSwitches', {});
  });
});
