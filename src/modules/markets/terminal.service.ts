import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { Decimal } from '../../utils/decimal';
import { getSetting } from '../settings/settings.service';
import { resolveFeeRate } from '../trading/engine/fees';
import { bestAsk, bestBid, midPrice } from '../trading/engine/orderbook';
import { groupOptions, presentBook, resolveGroup } from './book-grouping';
import { CANDLE_INTERVALS } from './hyperliquid.client';
import { getMarketOrThrow, presentMarket } from './market.service';
import { priceFeed, type TradeTick } from './price-feed';

// =====================================================================
// Data for the trading terminal. Everything is built from the live Hyperliquid feed that the
// backend already keeps in memory (see price-feed.ts), so the terminal and the trading engine
// always look at the same numbers. No calculation of accounts or positions happens here.
// =====================================================================

export const DEFAULT_BOOK_DEPTH = 15;
export const MAX_BOOK_DEPTH = 20;
export const DEFAULT_TRADES_LIMIT = 50;
export const MAX_TRADES_LIMIT = 200;
export const DEFAULT_CHART_INTERVAL = '1h';

type MarketRow = Awaited<ReturnType<typeof prisma.market.findFirstOrThrow>>;

const HOUR_MS = 3_600_000;

// Hyperliquid pays funding every hour: the next payment is the next full UTC hour.
export const nextFundingAt = (now = Date.now()) => (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;

// 24h statistics shown in the market bar. Every value is null until Hyperliquid has sent it.
export function marketStats(symbol: string, now = Date.now()) {
  const mark = priceFeed.getMark(symbol);
  const tick = priceFeed.getPrice(symbol);
  const reference = mark?.mark ?? tick?.mid ?? null;
  const prev = mark?.prevDayPx ?? null;

  let change24h: Decimal | null = null;
  let change24hPct: Decimal | null = null;
  if (reference && prev && prev.gt(0)) {
    change24h = reference.minus(prev);
    change24hPct = change24h.div(prev).mul(100);
  }

  const openInterest = mark?.openInterest ?? null;
  return {
    prevDayPx: prev?.toFixed() ?? null,
    change24h: change24h?.toFixed() ?? null,
    change24hPct: change24hPct?.toFixed(4) ?? null,
    volume24hUsd: mark?.dayNtlVlm?.toFixed() ?? null,
    openInterest: openInterest?.toFixed() ?? null,
    openInterestUsd: openInterest && reference ? openInterest.mul(reference).toFixed() : null,
    premium: mark?.premium?.toFixed() ?? null,
    // Hourly funding rate as published by Hyperliquid, plus the next payment time
    fundingRate: mark?.funding?.toFixed() ?? null,
    nextFundingAt: nextFundingAt(now),
  };
}

// One market for the terminal: registry limits + live prices + 24h statistics + fee rates.
export function presentTerminalMarket(m: MarketRow, fees: Awaited<ReturnType<typeof getSetting<'trading'>>>['fees']) {
  const base = presentMarket(m);
  const rate = (liquidity: 'MAKER' | 'TAKER') =>
    resolveFeeRate({ marketType: m.marketType, liquidity, schedule: fees, makerOverride: m.makerFeeRate, takerOverride: m.takerFeeRate }).toFixed();
  const mid = priceFeed.getPrice(m.symbol)?.mid ?? null;
  return {
    ...base,
    // Position cap shown in the market bar (max open notional per symbol and side)
    positionCapUsd: base.maxNotionalUsd,
    makerFeeRate: rate('MAKER'),
    takerFeeRate: rate('TAKER'),
    bookGroups: mid ? groupOptions(mid, new Decimal(m.priceTick.toString())) : [],
    // LIVE / DELAYED / PAUSED (spec: delayed at 2 s, trading blocked at 5 s)
    feedStatus: priceFeed.feedStatus(m.symbol),
    ...marketStats(m.symbol),
  };
}

export async function listTerminalMarkets() {
  const [rows, trading] = await Promise.all([
    prisma.market.findMany({ where: { isEnabled: true }, orderBy: { symbol: 'asc' } }),
    getSetting('trading'),
  ]);
  return rows.map((m) => presentTerminalMarket(m, trading.fees));
}

export async function getTerminalMarket(symbol: string) {
  const [row, trading] = await Promise.all([getMarketOrThrow(symbol), getSetting('trading')]);
  return presentTerminalMarket(row, trading.fees);
}

// Order book in the terminal format. "group" is the price step (null / empty = raw levels).
export async function getTerminalBook(symbol: string, opts: { depth?: number; group?: string | null } = {}) {
  const market = await getMarketOrThrow(symbol);
  const book = priceFeed.getBook(market.symbol);
  if (!book) throw ApiError.unprocessable('NO_PRICE', 'No order book available yet');

  const depth = Math.min(Math.max(opts.depth ?? DEFAULT_BOOK_DEPTH, 1), MAX_BOOK_DEPTH);
  const tick = new Decimal(market.priceTick.toString());
  const step = resolveGroup(opts.group, tick);
  const { bids, asks } = presentBook(book, step, depth);

  const bid = bestBid(book);
  const ask = bestAsk(book);
  const mid = midPrice(book);
  const spread = bid && ask ? ask.minus(bid) : null;
  return {
    symbol: market.symbol,
    group: step?.toFixed() ?? null,
    groups: mid ? groupOptions(mid, tick) : [],
    bids,
    asks,
    // Spread of the REAL book (not the grouped one)
    spread: spread?.toFixed() ?? null,
    spreadPct: spread && mid && mid.gt(0) ? spread.div(mid).mul(100).toFixed(4) : null,
    fresh: priceFeed.isBookFresh(market.symbol),
    seq: book.seq,
    ts: book.receivedAt,
  };
}

export const presentTrade = (t: TradeTick) => ({ price: t.price.toFixed(), size: t.size.toFixed(), side: t.side, time: t.time, tid: t.tid });

// Latest public trades, newest first.
export async function getTerminalTrades(symbol: string, limit = DEFAULT_TRADES_LIMIT) {
  const market = await getMarketOrThrow(symbol);
  const rows = priceFeed.getTrades(market.symbol, Math.min(Math.max(limit, 1), MAX_TRADES_LIMIT));
  return { symbol: market.symbol, trades: rows.map(presentTrade), ts: Date.now() };
}

// Everything the terminal needs for its first paint in ONE request.
export async function getTerminalBootstrap(symbol?: string) {
  const markets = await listTerminalMarkets();
  if (markets.length === 0) throw ApiError.notFound('No markets are enabled');

  const wanted = symbol?.toUpperCase();
  const selected = markets.find((m) => m.symbol === wanted) ?? markets[0];
  // A feed that has not delivered a book yet must not make the whole page fail
  const [book, trades] = await Promise.all([
    getTerminalBook(selected.symbol).catch(() => null),
    getTerminalTrades(selected.symbol).catch(() => null),
  ]);

  return {
    serverTime: Date.now(),
    selectedSymbol: selected.symbol,
    markets,
    book,
    trades: trades?.trades ?? [],
    chart: { intervals: CANDLE_INTERVALS, defaultInterval: DEFAULT_CHART_INTERVAL },
    ws: { path: '/ws/market', channels: ['price', 'book', 'trades', 'candles'] },
  };
}