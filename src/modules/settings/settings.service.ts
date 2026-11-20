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
