import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

// Business values live in the database so admins can change them without
// a deploy. Each key has a typed default used until an admin saves a value.
export const SETTING_DEFAULTS = {
  trading: {
    takerFeeRate: '0.00045', // 0.045 percent of notional
    spreadBps: '2', // simulated spread in basis points (used without order book)
    slippageBps: '1', // simulated slippage in basis points
    maintenanceMarginRate: '0.005', // 0.5 percent
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
