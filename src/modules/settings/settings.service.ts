import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

// Business values live in the database so admins can change them without
// a deploy. Each key has a typed default used until an admin saves a value.
export const SETTING_DEFAULTS = {
  trading: {
    // Legacy keys (kept so the admin settings page keeps working). The order book engine does not use them.
    takerFeeRate: '0.00045',
    spreadBps: '2',
    slippageBps: '1',
    maintenanceMarginRate: '0.005',
    // Maker / taker fee per market group (rate of notional: 0.0004 = 0.04 percent)
    fees: {
      CRYPTO: { maker: '0.0001', taker: '0.0004' },
      EQUITY: { maker: '0', taker: '0.0003' },
      COMMODITY: { maker: '0', taker: '0.00005' },
      INDEX: { maker: '0', taker: '0.00005' },
      FX: { maker: '0', taker: '0.00005' },
    },
    // Opening market orders are rejected above this slippage (percent). Traders may choose a lower value.
    defaultOpenSlippagePct: '3',
    maxOpenSlippagePct: '10',
    // Account-wide gross exposure must stay within this multiple of equity (new exposure only)
    grossExposureMultiple: '10',
    // Maintenance margin REFERENCE = this fraction of initial margin (display only, never liquidates)
    mmrFractionOfImr: '0.5',
    // Order count limits
    maxOpenOrders: 50,
    openOrderWarnAt: 40,
    maxPositionLegs: 20,
    maxExitLegsPerPosition: 10,
    // Version string stored on every fill
    rulesVersion: 'engine-1.0',
  },
  // Protection of the firm against harmful trading behaviour (Risk Engine specification v1.1)
  risk: {
    // Reject an order that opens the opposite side of a market that another account of the same trader already holds
    blockCrossAccountHedge: true,
    // Background scan for cross-account hedging, copy trading and latency abuse (findings are flags for staff review)
    abuseScanEnabled: true,
    // Copy trading: this many accounts opening the same trade within this window, repeated this many times
    copyTradingWindowSeconds: 5,
    copyTradingMinAccounts: 3,
    copyTradingMinRepeats: 3,
    // Latency abuse: average hold below this, win rate above this, with at least this many closed trades in 7 days
    latencyMaxAvgHoldSeconds: 30,
    latencyMinWinRatePct: 80,
    latencyMinCloses: 20,
  },
  payout: {
    profitSplitPct: '80',
    minPayoutUsd: '50',
    supportedNetworks: ['TRC20', 'ERC20', 'BEP20'],
  },
  affiliate: {
    commissionPct: '10',
  },
  // Admin console kill switches (frontend Platform settings). Shown to every staff member via /admin/auth/me.
  killSwitches: {
    pauseTrading: false,
    pausePurchases: false,
    pausePayouts: false,
    maintenanceMode: false,
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

// Tiny in-memory cache so the trading path does not hit the DB every order.
const cache = new Map<string, { value: unknown; expires: number }>();
const TTL_MS = 30_000;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as SettingValue<K>;

  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const value = { ...SETTING_DEFAULTS[key], ...((row?.value as object) ?? {}) } as SettingValue<K>;
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export async function saveSetting(key: SettingKey, value: Prisma.InputJsonValue) {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cache.delete(key);
}