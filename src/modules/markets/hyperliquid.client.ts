import { env } from '../../config/env';
import { logger } from '../../config/logger';

// =====================================================================
// Hyperliquid REST client (MARKET DATA ONLY).
// We never send orders or use private keys there. All fills are simulated
// by our own engine. Every request has a timeout and a small retry loop,
// so one slow response can never block the server.
// =====================================================================

export interface HlAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

// Per-asset live context. The order matches the "universe" array of the meta response.
export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
}

export interface HlLevel {
  px: string;
  sz: string;
  n: number;
}

export interface HlL2Book {
  coin: string;
  // Exchange timestamp in milliseconds
  time: number;
  // levels[0] = bids (best first), levels[1] = asks (best first)
  levels: [HlLevel[], HlLevel[]];
}

export interface HlFundingEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  // Exchange timestamp of the funding payment in milliseconds
  time: number;
}

// One OHLCV candle as sent by Hyperliquid (REST candleSnapshot and the WebSocket "candle" channel).
export interface HlCandle {
  // Open time and close time in milliseconds
  t: number;
  T: number;
  // Coin and interval
  s: string;
  i: string;
  // Open, close, high, low prices and volume (base asset), all strings
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  // Number of trades inside the candle
  n: number;
}

// One public trade as sent by the WebSocket "trades" channel.
// side "B" = the buyer was the aggressor (taker buy), "A" = the seller was the aggressor.
export interface HlTrade {
  coin: string;
  side: 'A' | 'B';
  px: string;
  sz: string;
  time: number;
  hash?: string;
  tid: number | string;
}

// Candle intervals supported by Hyperliquid.
export const CANDLE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export class HyperliquidError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HyperliquidError';
  }
}

const RETRIES = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryableStatus = (status?: number) => status === 429 || (status ?? 0) >= 500;

// POST /info with timeout, retry (network errors, 429 and 5xx) and exponential backoff.
async function info<T>(body: Record<string, unknown>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.HYPERLIQUID_TIMEOUT_MS);
    try {
      const res = await fetch(`${env.HYPERLIQUID_REST_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) return (await res.json()) as T;

      lastError = new HyperliquidError(`Hyperliquid "${String(body.type)}" request failed with status ${res.status}`, res.status);
      // A 4xx error (except 429) will not get better by retrying
      if (!isRetryableStatus(res.status)) throw lastError;
    } catch (err) {
      if (err instanceof HyperliquidError) {
        if (!isRetryableStatus(err.status)) throw err;
        lastError = err;
      } else {
        lastError = new HyperliquidError(`Hyperliquid "${String(body.type)}" request error: ${(err as Error).message}`);
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < RETRIES) {
      const delay = 300 * 2 ** attempt;
      logger.warn({ type: body.type, attempt: attempt + 1, delay }, 'Hyperliquid request failed, retrying');
      await sleep(delay);
    }
  }
  throw lastError;
}

// Market metadata: the list of perpetual contracts and their rules.
export async function fetchPerpMeta(): Promise<HlAsset[]> {
  const json = await info<{ universe?: HlAsset[] }>({ type: 'meta' });
  if (!Array.isArray(json?.universe)) throw new HyperliquidError('Hyperliquid meta response has no universe');
  return json.universe;
}

// Metadata plus the live context (mark, oracle, funding) of every contract in one request.
// Returns the contract list and a map of contexts keyed by coin name.
export async function fetchMetaAndAssetCtxs(): Promise<{ assets: HlAsset[]; ctxs: Map<string, HlAssetCtx> }> {
  const json = await info<[{ universe?: HlAsset[] }, HlAssetCtx[]]>({ type: 'metaAndAssetCtxs' });
  const universe = json?.[0]?.universe;
  const ctxList = json?.[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxList)) {
    throw new HyperliquidError('Hyperliquid metaAndAssetCtxs response is malformed');
  }
  const ctxs = new Map<string, HlAssetCtx>();
  universe.forEach((asset, i) => {
    if (ctxList[i]) ctxs.set(asset.name, ctxList[i]);
  });
  return { assets: universe, ctxs };
}

// Snapshot of mid prices for every symbol.
export async function fetchAllMids(): Promise<Record<string, string>> {
  return info<Record<string, string>>({ type: 'allMids' });
}

// Full order book snapshot (up to 20 levels per side).
export async function fetchL2Book(coin: string): Promise<HlL2Book> {
  const json = await info<HlL2Book>({ type: 'l2Book', coin });
  if (!json?.levels || json.levels.length !== 2) throw new HyperliquidError(`Hyperliquid l2Book response for ${coin} is malformed`);
  return json;
}

// Funding payments of one coin between two timestamps (milliseconds).
export async function fetchFundingHistory(coin: string, startTime: number, endTime?: number): Promise<HlFundingEntry[]> {
  const json = await info<HlFundingEntry[]>({ type: 'fundingHistory', coin, startTime, ...(endTime ? { endTime } : {}) });
  if (!Array.isArray(json)) throw new HyperliquidError(`Hyperliquid fundingHistory response for ${coin} is malformed`);
  return json;
}

// Historical candles of one coin. Hyperliquid returns at most the 5000 most recent candles of the range.
export async function fetchCandles(coin: string, interval: CandleInterval, startTime: number, endTime?: number): Promise<HlCandle[]> {
  const json = await info<HlCandle[]>({
    type: 'candleSnapshot',
    req: { coin, interval, startTime, ...(endTime ? { endTime } : {}) },
  });
  if (!Array.isArray(json)) throw new HyperliquidError(`Hyperliquid candleSnapshot response for ${coin} is malformed`);
  return json;
}