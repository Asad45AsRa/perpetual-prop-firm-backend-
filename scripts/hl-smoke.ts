import { fetchCandles, fetchFundingHistory, fetchL2Book, fetchMetaAndAssetCtxs, fetchPerpMeta } from '../src/modules/markets/hyperliquid.client';
import { priceFeed } from '../src/modules/markets/price-feed';
import { divergenceLimitPct, isDivergenceExceeded, maxNotionalByLiquidity } from '../src/modules/trading/engine/market-policy';

const SYMBOLS = ['BTC', 'ETH'];
const LISTEN_MS = 20_000;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
  }
  const last = results[results.length - 1];
  console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.name}  ${last.detail}`);
}

async function main() {
  console.log('--- REST ---');
  await check('meta: BTC and ETH are listed', async () => {
    const assets = await fetchPerpMeta();
    const found = SYMBOLS.map((s) => assets.find((a) => a.name === s));
    if (found.some((a) => !a)) throw new Error('a launch symbol is missing');
    return found.map((a) => `${a!.name} szDecimals=${a!.szDecimals} maxLeverage=${a!.maxLeverage}`).join(' | ');
  });
  await check('metaAndAssetCtxs: mark, oracle, funding, 24h volume, open interest', async () => {
    const { ctxs } = await fetchMetaAndAssetCtxs();
    return SYMBOLS.map((s) => {
      const c = ctxs.get(s);
      if (!c) throw new Error(`${s} context missing`);
      return `${s} mark=${c.markPx} oracle=${c.oraclePx} funding=${c.funding} prevDay=${c.prevDayPx} vol24h=${c.dayNtlVlm} oi=${c.openInterest}`;
    }).join(' | ');
  });
  await check('l2Book: BTC order book', async () => {
    const book = await fetchL2Book('BTC');
    return `bids=${book.levels[0].length} asks=${book.levels[1].length} bestBid=${book.levels[0][0]?.px} bestAsk=${book.levels[1][0]?.px}`;
  });
  await check('candleSnapshot: BTC 1m (last 10 minutes)', async () => {
    const rows = await fetchCandles('BTC', '1m', Date.now() - 10 * 60_000);
    if (rows.length === 0) throw new Error('no candles returned');
    const last = rows[rows.length - 1];
    return `${rows.length} candles, last t=${last.t} o=${last.o} h=${last.h} l=${last.l} c=${last.c} v=${last.v}`;
  });
  await check('candleSnapshot: BTC 1h (last 24 hours)', async () => {
    const rows = await fetchCandles('BTC', '1h', Date.now() - 24 * 3_600_000);
    if (rows.length === 0) throw new Error('no candles returned');
    return `${rows.length} candles`;
  });
  await check('fundingHistory: BTC (last 3 hours)', async () => {
    const rows = await fetchFundingHistory('BTC', Date.now() - 3 * 3_600_000);
    return `${rows.length} funding rows`;
  });

  console.log(`--- WebSocket (listening ${LISTEN_MS / 1000}s) ---`);
  let tradeBatches = 0;
  let candleUpdates = 0;
  priceFeed.on('trades', () => tradeBatches++);
  priceFeed.on('candle', () => candleUpdates++);
  priceFeed.start(SYMBOLS);
  priceFeed.subscribeCandle('BTC', '1m');
  await new Promise((r) => setTimeout(r, LISTEN_MS));

  const status = priceFeed.status();
  for (const s of SYMBOLS) {
    const sym = status.symbols.find((x) => x.symbol === s);
    await check(`feed ${s}: book + mark price are fresh`, async () => {
      if (!sym?.bookFresh || !sym?.markFresh) throw new Error(`bookAge=${sym?.bookAgeMs}ms markAge=${sym?.markAgeMs}ms`);
      return `bookAge=${sym.bookAgeMs}ms markAge=${sym.markAgeMs}ms`;
    });
    await check(`feed ${s}: 24h stats from activeAssetCtx`, async () => {
      const m = priceFeed.getMark(s);
      if (!m?.dayNtlVlm || !m.openInterest || !m.prevDayPx) throw new Error('volume / open interest / previous day price missing');
      return `vol24h=${m.dayNtlVlm} oi=${m.openInterest} prevDay=${m.prevDayPx}`;
    });
  }
  await check('feed BTC: public trades arrive', async () => {
    const n = priceFeed.getTrades('BTC', 1000).length;
    if (n === 0) throw new Error('no trades received');
    return `${n} trades buffered in ${tradeBatches} batches, newest price=${priceFeed.getTrades('BTC', 1)[0].price}`;
  });
  await check('feed BTC: live 1m candle updates arrive', async () => {
    if (candleUpdates === 0) throw new Error('no candle updates received');
    const c = priceFeed.getLatestCandle('BTC', '1m')!;
    return `${candleUpdates} updates, latest close=${c.close} volume=${c.volume}`;
  });
  // Inputs of the trading engine rules (spec): freshness status, mark / book agreement, liquidity guard depth
  for (const s of SYMBOLS) {
    await check(`engine ${s}: feed status is LIVE (not DELAYED / PAUSED)`, async () => {
      const st = priceFeed.feedStatus(s);
      if (st !== 'LIVE') throw new Error(`status=${st} markAge=${priceFeed.markAgeMs(s)}ms`);
      return `status=${st} markAge=${priceFeed.markAgeMs(s)}ms`;
    });
    await check(`engine ${s}: book mid and mark agree (below the pause limit)`, async () => {
      const pct = priceFeed.divergencePct(s);
      if (!pct) throw new Error('divergence cannot be computed (book or mark missing)');
      const limit = divergenceLimitPct(s);
      if (isDivergenceExceeded(s, pct)) throw new Error(`divergence ${pct.toFixed(4)}% is above ${limit}%`);
      return `divergence=${pct.toFixed(4)}% limit=${limit}%`;
    });
    await check(`engine ${s}: liquidity guard has depth samples`, async () => {
      const buy = priceFeed.robustDepthUsd(s, 'BUY');
      const sell = priceFeed.robustDepthUsd(s, 'SELL');
      if (!buy || !sell) throw new Error('no depth samples yet');
      return `askDepth1pct=${buy.toFixed(0)} USD bidDepth1pct=${sell.toFixed(0)} USD -> max single entry ${maxNotionalByLiquidity(buy).toFixed(0)} / ${maxNotionalByLiquidity(sell).toFixed(0)} USD`;
    });
  }
  console.log(`connected=${status.connected} reconnects=${status.reconnects} droppedOutOfOrder=${status.droppedOutOfOrder}`);

  priceFeed.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});