import type { OrderSide, OrderType } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { priceFeed } from '../markets/price-feed';
import { computeMetrics, symbolSideNotional } from './engine/exposure';
import { feeAmount, resolveFeeRate } from './engine/fees';
import { isMarketable, marketableLimitFillPrice } from './engine/matching';
import { isDivergenceExceeded } from './engine/market-policy';
import { bestAsk, bestBid } from './engine/orderbook';
import { classifyOrder, openingSideOf } from './engine/positions';
import { checkPrice, checkSize } from './engine/validation';
import { legsFromRows, liquidityLimitUsd, liveQuote, loadState, reservationFor } from './order-engine';

// =====================================================================
// Trade preview for the order ticket (spec section 3 "Trade preview").
// A READ-ONLY calculation on the account state and the LIVE mark / book. It writes nothing, reserves nothing and
// reports exactly what the order engine would decide, including the FIRST binding limit and the maximum valid notional.
// =====================================================================

export interface PreviewInput {
  accountId: string;
  symbol: string;
  side: OrderSide;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET';
  // Exactly one way to give the quantity: coin size, USD value, or margin (value = margin x leverage)
  size?: Decimal | null;
  notionalUsd?: Decimal | null;
  marginUsd?: Decimal | null;
  leverage: number;
  limitPrice?: Decimal | null;
  triggerPrice?: Decimal | null;
  reduceOnly: boolean;
  postOnly: boolean;
}

interface Limit {
  code: string;
  message: string;
  maxNotionalUsd: Decimal;
}

export async function previewOrder(tx: Tx, input: PreviewInput) {
  const market = await tx.market.findUnique({ where: { symbol: input.symbol.toUpperCase() } });
  if (!market || !market.isEnabled) throw ApiError.unprocessable('MARKET_DISABLED', 'Market is not available');
  const account = await tx.tradingAccount.findUniqueOrThrow({ where: { id: input.accountId }, include: { plan: true } });

  const base = {
    symbol: market.symbol,
    side: input.side,
    type: input.type as OrderType,
    feedStatus: priceFeed.feedStatus(market.symbol),
  };

  // Stale data blocks the ticket, the same way it blocks the order
  if (!priceFeed.isFresh(market.symbol)) {
    return {
      ...base,
      status: 'BLOCKED' as const,
      rejection: { code: 'MARKET_FEED_STALE', message: 'Price is outdated, trading is temporarily blocked' },
    };
  }
  const quote = liveQuote(market.symbol, false);
  const q = { bid: bestBid(quote.book), ask: bestAsk(quote.book), mark: quote.mark };
  const state = await loadState(tx, input.accountId, new Set());

  // ---- price, liquidity class and quantity ----
  const limit = input.limitPrice ?? null;
  const marketable = input.type === 'LIMIT' && limit ? isMarketable(input.side, limit, q) : false;
  const liquidity: 'MAKER' | 'TAKER' = input.type === 'LIMIT' && !marketable ? 'MAKER' : 'TAKER';
  const referencePrice =
    input.type === 'LIMIT' && limit
      ? marketable
        ? marketableLimitFillPrice(input.side, limit, quote.mark)
        : limit
      : input.type === 'STOP_MARKET' && input.triggerPrice
        ? input.triggerPrice
        : quote.mark;

  const leverageCap = Math.min(market.maxLeverage, account.plan.maxLeverage);
  const leverage = input.leverage;
  const step = toD(market.sizeStep);
  const floorToStep = (v: Decimal) => (step.gt(0) ? v.div(step).floor().mul(step) : v);
  let size: Decimal;
  if (input.size) size = input.size;
  else if (input.notionalUsd) size = floorToStep(input.notionalUsd.div(referencePrice));
  else if (input.marginUsd) size = floorToStep(input.marginUsd.mul(leverage).div(referencePrice));
  else throw ApiError.badRequest('Send size, notionalUsd or marginUsd');

  const notional = size.mul(referencePrice);

  // ---- what the order does to the position (one-way) ----
  const symbolRows = state.rows.filter((r) => r.symbol === market.symbol);
  const legOf = (side: 'LONG' | 'SHORT') => {
    const r = symbolRows.find((x) => x.side === side);
    return r ? { side, size: r.size } : null;
  };
  const cls = classifyOrder(state.mode, input.side, null, legOf('LONG'), legOf('SHORT'), size);
  const reduceOnly = input.reduceOnly;
  const openSize = reduceOnly ? ZERO : cls.openSize;
  const openNotional = openSize.mul(referencePrice);
  const closeNotional = notional.minus(openNotional);

  // ---- fees and margin of THIS order ----
  const feeRate = resolveFeeRate({
    marketType: market.marketType,
    liquidity,
    schedule: state.settings.fees,
    makerOverride: market.makerFeeRate,
    takerOverride: market.takerFeeRate,
  });
  const takerRate = resolveFeeRate({ marketType: market.marketType, liquidity: 'TAKER', schedule: state.settings.fees, makerOverride: market.makerFeeRate, takerOverride: market.takerFeeRate });
  const fee = feeAmount(notional, feeRate);
  const initialMargin = openNotional.div(leverage);
  // A resting order reserves margin + a taker fee buffer until it fills or is cancelled
  const pendingMargin = liquidity === 'MAKER' && openSize.gt(0) ? reservationFor(openSize, referencePrice, leverage, takerRate) : ZERO;

  // ---- account metrics before / after ----
  const legsBefore = legsFromRows(state.rows, market.symbol, quote.mark);
  const before = computeMetrics(state.balance, legsBefore, state.working);
  const grossCapUsd = before.equity.mul(state.grossMultiple);

  const symbolSideBefore = symbolSideNotional(legsBefore, state.working, market.symbol, openingSideOf(input.side));
  const symbolCap = market.maxNotionalUsd ? toD(market.maxNotionalUsd) : null;
  const newLeg = openSize.gt(0) && !symbolRows.some((r) => r.side === openingSideOf(input.side));

  // ---- the limits that can bind a NEW entry, each as a maximum notional ----
  const limits: Limit[] = [];
  const nonNegative = (v: Decimal) => Decimal.max(v, ZERO);
  // margin: capacity before the order, each notional dollar costs 1/leverage margin plus its fee
  limits.push({
    code: 'INSUFFICIENT_MARGIN',
    message: 'Not enough margin capacity',
    maxNotionalUsd: nonNegative(before.marginCapacityRaw).div(new Decimal(1).div(leverage).plus(feeRate)),
  });
  // gross exposure: current equity x cap >= gross + notional
  limits.push({
    code: 'GROSS_EXPOSURE_CAP',
    message: `Total exposure is limited to ${state.grossMultiple}x equity`,
    maxNotionalUsd: nonNegative(grossCapUsd.minus(before.grossWithOrders)),
  });
  if (symbolCap) {
    limits.push({ code: 'POSITION_CAP', message: `${market.symbol} position limit`, maxNotionalUsd: nonNegative(symbolCap.minus(symbolSideBefore)) });
  }
  const liquidityCap = liquidityLimitUsd(market.symbol, input.side);
  if (liquidityCap) limits.push({ code: 'LIQUIDITY_GUARD', message: 'Visible liquidity limit (10 percent of the 30 second median depth)', maxNotionalUsd: liquidityCap });
  if (newLeg && state.rows.length >= state.settings.maxPositionLegs) {
    limits.push({ code: 'OPEN_POSITION_LIMIT', message: `At most ${state.settings.maxPositionLegs} open positions`, maxNotionalUsd: ZERO });
  }
  const binding = [...limits].sort((a, b) => a.maxNotionalUsd.cmp(b.maxNotionalUsd))[0] ?? null;

  // ---- the first rule that rejects THIS order (same order as the engine) ----
  let rejection: { code: string; message: string } | null = null;
  const fail = (code: string, message: string) => {
    if (!rejection) rejection = { code, message };
  };
  if (checkSize(size, { sizeStep: market.sizeStep, minSize: market.minSize }) !== 'OK') fail('INVALID_LOT', `Size must be a multiple of ${market.sizeStep.toString()} (minimum ${market.minSize.toString()})`);
  if (limit && !checkPrice(limit, { pricePrecision: market.pricePrecision, priceTick: market.priceTick })) fail('INVALID_TICK', `Price must be a multiple of ${market.priceTick.toString()}`);
  if (input.postOnly && marketable) fail('POST_ONLY_WOULD_TAKE', 'A post-only order would execute immediately');
  if (openSize.gt(0)) {
    if (market.isCloseOnly) fail('MARKET_CLOSE_ONLY', `${market.symbol} only accepts orders that reduce a position`);
    if (leverage < 1 || leverage > leverageCap) fail('LEVERAGE_CAP', `Leverage must be between 1 and ${leverageCap}`);
    if (isDivergenceExceeded(market.symbol, priceFeed.divergencePct(market.symbol))) fail('MARKET_PRICE_DIVERGENCE', 'New positions are paused: book and mark disagree');
    if (notional.lt(toD(market.minNotionalUsd))) fail('BELOW_MIN_NOTIONAL', `Minimum order value is ${market.minNotionalUsd.toString()} USD`);
    if (!liquidityCap) fail('LIQUIDITY_UNAVAILABLE', 'Order book depth is not available yet');
    for (const l of limits) if (openNotional.gt(l.maxNotionalUsd)) fail(l.code, l.message);
  }

  const balanceAfter = state.balance.minus(liquidity === 'TAKER' || closeNotional.gt(0) ? fee : ZERO);
  return {
    ...base,
    status: rejection ? ('BLOCKED' as const) : ('READY' as const),
    markPrice: quote.mark.toFixed(),
    referencePrice: referencePrice.toFixed(),
    liquidity,
    size: size.toFixed(),
    notionalUsd: notional.toFixed(2),
    openNotionalUsd: openNotional.toFixed(2),
    closeNotionalUsd: closeNotional.toFixed(2),
    leverage,
    maxLeverage: leverageCap,
    initialMargin: initialMargin.toFixed(6),
    pendingMargin: pendingMargin.toFixed(6),
    feeRate: feeRate.toFixed(),
    estimatedFee: fee.toFixed(6),
    balanceAfterFee: balanceAfter.toFixed(6),
    marginCapacity: before.availableMargin.toFixed(6),
    grossExposure: before.grossWithOrders.toFixed(2),
    grossExposureLimit: grossCapUsd.toFixed(2),
    // Largest valid notional of a NEW entry right now and the rule that sets it
    maxNotionalUsd: binding ? binding.maxNotionalUsd.toFixed(2) : null,
    binding: binding ? { code: binding.code, message: binding.message } : null,
    rejection,
    note: 'Reference liquidity only. Fills are simulated at the server mark price.',
  };
}