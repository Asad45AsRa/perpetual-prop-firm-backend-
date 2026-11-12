import { env } from '../../config/env';

// Hyperliquid is used for MARKET DATA ONLY. We never send orders or use
// private keys there. All fills are simulated by our own engine.

export interface HlAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

// Market metadata: the list of perpetual contracts and their rules.
export async function fetchPerpMeta(): Promise<HlAsset[]> {
  const res = await fetch(`${env.HYPERLIQUID_REST_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  if (!res.ok) throw new Error(`Hyperliquid meta request failed with status ${res.status}`);
  const json = (await res.json()) as { universe: HlAsset[] };
  return json.universe;
}

// Snapshot of mid prices for every symbol (used for startup and recovery).
export async function fetchAllMids(): Promise<Record<string, string>> {
  const res = await fetch(`${env.HYPERLIQUID_REST_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  if (!res.ok) throw new Error(`Hyperliquid allMids request failed with status ${res.status}`);
  return (await res.json()) as Record<string, string>;
}
