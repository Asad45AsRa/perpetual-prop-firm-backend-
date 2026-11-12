// Admin sections. SUPER_ADMIN can open all of them; ADMIN and MODERATOR
// users only see the sections granted to them one by one.
export const ADMIN_SECTIONS = [
  'users',
  'plans',
  'accounts',
  'markets',
  'orders',
  'risk',
  'payouts',
  'affiliates',
  'content',
  'email',
  'competitions',
  'audit',
  'staff',
  'settings',
  'system-health',
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export const STAFF_ROLES = ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;

// Block explorer links used for payout proof
export const EXPLORER_TX_URL: Record<string, string> = {
  BTC: 'https://mempool.space/tx/',
  ETH: 'https://etherscan.io/tx/',
  ERC20: 'https://etherscan.io/tx/',
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  SOL: 'https://solscan.io/tx/',
};
