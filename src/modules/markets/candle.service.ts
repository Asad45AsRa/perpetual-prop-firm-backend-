import { logger } from '../../config/logger';
import { ApiError } from '../../utils/api-error';
import { CANDLE_INTERVALS, fetchCandles, HyperliquidError, type CandleInterval, type HlCandle } from './hyperliquid.client';

// =====================================================================
// Historical candles for the terminal chart (REST). The forming candle keeps moving through
// the WebSocket "candles" channel (see market.ws.ts). Browsers never call Hyperliquid directly.
// Many users opening the same chart share ONE Hyperliquid request:
//   * identical requests that run at the same time are merged (in-flight sharing)
//   * results are cached for a short time (longer for finished history)
// =====================================================================

export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  // Calendar month, only used to size the default time window
  '1M': 2_592_000_000,
};

export const DEFAULT_CANDLE_LIMIT = 500;
// Hyperliquid itself never returns more than 5000 candles per request
export const MAX_CANDLE_LIMIT = 5000;

const LIVE_TTL_MS = 2_000;
const HISTORY_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 300;

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value);
}

// Candle as sent to the browser. Keys are short on purpose (a chart loads thousands of rows).
export interface CandleRow {
  // Open time and close time in milliseconds
  t: number;
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  // Number of trades
  n: number;
}

export interface CandleRequest {
  symbol: string;
  // Exact Hyperliquid coin key of the symbol
  coin: string;
  interval: CandleInterval;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

const cache = new Map<string, { expiresAt: number; rows: CandleRow[] }>();
const inFlight = new Map<string, Promise<CandleRow[]>>();

const toRow = (c: HlCandle): CandleRow => ({ t: c.t, T: c.T, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n });

function remember(key: string, rows: CandleRow[], ttl: number, now: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop expired rows first, then the oldest entry
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, { expiresAt: now + ttl, rows });
}

// Returns candles sorted by open time (oldest first), at most "limit" rows (the newest ones).
export async function loadCandles(req: CandleRequest, now = Date.now()): Promise<CandleRow[]> {
  const limit = Math.min(Math.max(req.limit ?? DEFAULT_CANDLE_LIMIT, 1), MAX_CANDLE_LIMIT);
  const step = INTERVAL_MS[req.interval];
  const endTime = req.endTime ?? now;
  const startTime = req.startTime ?? endTime - limit * step;
  if (startTime >= endTime) throw ApiError.badRequest('startTime must be before endTime');

  // The open-ended "latest candles" request moves every millisecond, so it is cached by its shape
  const open = req.endTime == null && req.startTime == null;
  const key = open ? `${req.coin}|${req.interval}|latest|${limit}` : `${req.coin}|${req.interval}|${startTime}|${endTime}|${limit}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.rows;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const job = (async () => {
    try {
      const raw = await fetchCandles(req.coin, req.interval, startTime, req.endTime ?? undefined);
      const rows = raw
        .filter((c) => c && typeof c.t === 'number')
        .sort((a, b) => a.t - b.t)
        .slice(-limit)
        .map(toRow);
      // Finished history does not change: keep it longer than a window that still contains "now"
      const finished = endTime < now - 2 * step;
      remember(key, rows, finished ? HISTORY_TTL_MS : LIVE_TTL_MS, now);
      return rows;
    } catch (err) {
      logger.warn({ err, coin: req.coin, interval: req.interval }, 'Could not load candles from Hyperliquid');
      if (err instanceof HyperliquidError) throw new ApiError(502, 'MARKET_DATA_UNAVAILABLE', 'Candle data is temporarily unavailable');
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

// Test helper: forget everything that was cached.
export function clearCandleCache() {
  cache.clear();
  inFlight.clear();
}