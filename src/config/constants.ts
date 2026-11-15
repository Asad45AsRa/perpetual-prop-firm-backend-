// Roles, admin sections and rights now live in src/modules/rbac/rbac.catalog.ts.
export { STAFF_ROLES } from '../modules/rbac/rbac.catalog';

// Block explorer links used for payout proof
export const EXPLORER_TX_URL: Record<string, string> = {
  BTC: 'https://mempool.space/tx/',
  ETH: 'https://etherscan.io/tx/',
  ERC20: 'https://etherscan.io/tx/',
  TRC20: 'https://tronscan.org/#/transaction/',
  BEP20: 'https://bscscan.com/tx/',
  SOL: 'https://solscan.io/tx/',
};

//Asad Ul Islam 