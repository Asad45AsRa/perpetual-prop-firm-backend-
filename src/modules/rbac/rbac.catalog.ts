// =====================================================================
// RBAC catalog: the single source of truth for every role, admin section,
// special right and end-user (trader / affiliate) permission.
//
// It mirrors the frontend:
//   * admin sections  = admin sidebar pages  (frontend src/components/admin/pages/*  `key`)
//   * special rights  = frontend src/components/admin/permissions.ts  `RIGHTS`
//   * portals         = the trader dashboard (/dashboard) and affiliate dashboard (/affiliates/dashboard)
// To add a page or right: add one line here, then grant it on the Staff & Permissions page.
// =====================================================================

export const ACCESS_LEVELS = ['none', 'view', 'manage'] as const;
export type AccessLevelName = (typeof ACCESS_LEVELS)[number];

export const STAFF_ROLES = ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PORTALS = ['TRADER', 'AFFILIATE'] as const;
export type PortalName = (typeof PORTALS)[number];

// ----------------------------- Admin sections ------------------------------
export const ADMIN_SECTION_LIST = [
  // Workspace
  { key: 'overview', label: 'Overview', group: 'Workspace' },
  { key: 'operations', label: 'Operations & performance', group: 'Workspace' },
  { key: 'reports', label: 'Reports', group: 'Workspace' },
  { key: 'metrics', label: 'Metric definitions', group: 'Workspace' },
  // Traders & trading
  { key: 'traders', label: 'Trader management', group: 'Traders & trading' },
  { key: 'accounts', label: 'Trading accounts', group: 'Traders & trading' },
  { key: 'activity', label: 'Trading activity', group: 'Traders & trading' },
  { key: 'risk', label: 'Risk management', group: 'Traders & trading' },
  { key: 'markets', label: 'Market management', group: 'Traders & trading' },
  { key: 'issuance', label: 'Account issuance', group: 'Traders & trading' },
  { key: 'kyc', label: 'KYC review', group: 'Traders & trading' },
  { key: 'ledger', label: 'Ledger & reconciliation', group: 'Traders & trading' },
  { key: 'trader-view', label: 'Trader view', group: 'Traders & trading' },
  { key: 'demo', label: 'Demo accounts', group: 'Traders & trading' },
  { key: 'leaderboard', label: 'Leaderboard', group: 'Traders & trading' },
  // Finance & sales
  { key: 'plans', label: 'Challenge plans', group: 'Finance & sales' },
  { key: 'payments', label: 'Payment management', group: 'Finance & sales' },
  { key: 'payouts', label: 'Trader payouts', group: 'Finance & sales' },
  { key: 'approvals', label: 'Approvals', group: 'Finance & sales' },
  { key: 'affiliates', label: 'Affiliate management', group: 'Finance & sales' },
  { key: 'affiliate-payouts', label: 'Affiliate payouts', group: 'Finance & sales' },
  { key: 'coupons', label: 'Coupons', group: 'Finance & sales' },
  { key: 'reserves', label: 'Payout reserves', group: 'Finance & sales' },
  { key: 'public-payouts', label: 'Public payout feed', group: 'Finance & sales' },
  // Communication
  { key: 'tickets', label: 'Support tickets', group: 'Communication' },
  { key: 'announcements', label: 'Announcements', group: 'Communication' },
  { key: 'emails', label: 'Email management', group: 'Communication' },
  { key: 'cms', label: 'Website CMS', group: 'Communication' },
  { key: 'competitions', label: 'Competitions', group: 'Communication' },
  // Platform control
  { key: 'health', label: 'System health', group: 'Platform control' },
  { key: 'errors', label: 'Error events', group: 'Platform control' },
  { key: 'webhooks', label: 'Webhook logs', group: 'Platform control' },
  { key: 'jobs', label: 'Jobs', group: 'Platform control' },
  { key: 'alerts', label: 'Alerts', group: 'Platform control' },
  { key: 'audit-logs', label: 'Audit logs', group: 'Platform control' },
  { key: 'settings', label: 'Platform settings', group: 'Platform control' },
  // Only the super admin can open this page; it can never be granted.
  { key: 'staff', label: 'Staff & permissions', group: 'Platform control', superOnly: true },
] as const satisfies readonly { key: string; label: string; group: string; superOnly?: boolean }[];

export type AdminSection = (typeof ADMIN_SECTION_LIST)[number]['key'];
export const ADMIN_SECTIONS = ADMIN_SECTION_LIST.map((s) => s.key) as [AdminSection, ...AdminSection[]];
export const SUPER_ONLY_SECTIONS: AdminSection[] = ADMIN_SECTION_LIST.filter((s) => 'superOnly' in s && s.superOnly).map((s) => s.key);
export const GRANTABLE_SECTIONS = ADMIN_SECTIONS.filter((s) => !SUPER_ONLY_SECTIONS.includes(s)) as [AdminSection, ...AdminSection[]];

// ----------------------------- Special rights ------------------------------
export const SPECIAL_RIGHT_LIST = [
  { key: 'finance.view', label: 'See revenue figures', hint: 'Revenue cards on the overview and reports' },
  { key: 'traders.suspend', label: 'Suspend traders', hint: 'Suspend, restore, archive and force sign-out' },
  { key: 'risk.review', label: 'Review risk events', hint: 'Resolve and escalate risk events' },
  { key: 'tickets.reply', label: 'Reply to tickets', hint: 'Answer and close support tickets' },
  { key: 'kyc.review', label: 'Review KYC cases', hint: 'Approve or reject identity checks' },
  { key: 'payout.approve', label: 'Approve payouts', hint: 'First approval, reject and mark paid' },
  { key: 'approvals.decide', label: 'Decide approvals', hint: 'Second approver for large payouts, refunds and overrides' },
  { key: 'account.override', label: 'Override accounts', hint: 'Pass, fail, lock or reset an account by hand' },
  { key: 'refund.issue', label: 'Request refunds', hint: 'Start a refund (a second person must approve)' },
  { key: 'market.sync', label: 'Sync markets', hint: 'Import market changes from Hyperliquid' },
  { key: 'settings.edit', label: 'Edit settings', hint: 'Change risk, trading, payout and compliance rules' },
  { key: 'settings.kill_switch', label: 'Use kill switches', hint: 'Pause trading, purchases or payouts' },
  { key: 'audit.export', label: 'Export audit logs', hint: 'Download the full audit trail' },
] as const;

export type SpecialRight = (typeof SPECIAL_RIGHT_LIST)[number]['key'];
export const SPECIAL_RIGHTS = SPECIAL_RIGHT_LIST.map((r) => r.key) as [SpecialRight, ...SpecialRight[]];

// ------------------------ End-user portal permissions -----------------------
// What a USER may do in each dashboard. Ownership (only YOUR accounts, YOUR payouts) is
// still enforced in the services; these say which features the portal unlocks.
export const PORTAL_PERMISSIONS = {
  TRADER: [
    'trader.dashboard.view', //       Home: profile, sub accounts, PnL, lifetime stats
    'trader.accounts.view', //        Account dashboard, trade log, stats & discipline
    'trader.trade', //                Place / close orders in the terminal
    'trader.challenges.purchase', //  Challenges checkout
    'trader.demo.start', //           Free demo account
    'trader.payouts.request', //      Request a payout from a funded account
    'trader.payouts.view', //         Payout history
    'trader.purchases.view', //       Purchase history
    'trader.leaderboard.view', //     Top performers
    'trader.profile.manage', //       Settings: username, avatar, visibility, devices
  ],
  AFFILIATE: [
    'affiliate.dashboard.view', //    Overview: stats, level progress, earnings, leaderboard
    'affiliate.referrals.view', //    Referrals table + referral link
    'affiliate.referral_link.manage', // Edit the referral code / link
    'affiliate.commissions.view', //  Commission levels and history
    'affiliate.payouts.request', //   Withdraw commission
    'affiliate.payouts.view', //      Payout history
    'affiliate.giveaways.view', //    Giveaways + submit request
    'affiliate.certificates.view', // Download / share certificates
    'affiliate.profile.manage', //    My profile
  ],
} as const satisfies Record<PortalName, readonly string[]>;

export type PortalPermission = (typeof PORTAL_PERMISSIONS)[PortalName][number];

// ------------------------------ Role presets -------------------------------
// Starting access when a staff member is created without explicit grants. The super admin can
// change every line afterwards; presets are only defaults.
type Grants = Partial<Record<AdminSection, Exclude<AccessLevelName, 'none'>>>;

const viewAll = (keys: AdminSection[]): Grants => Object.fromEntries(keys.map((k) => [k, 'view']));

export const ROLE_PRESETS: Record<Exclude<StaffRole, 'SUPER_ADMIN'>, { grants: Grants; rights: SpecialRight[] }> = {
  // Runs the business day to day: manages most pages, but money and kill switches stay explicit.
  ADMIN: {
    grants: {
      ...viewAll(GRANTABLE_SECTIONS),
      overview: 'view',
      traders: 'manage',
      accounts: 'manage',
      risk: 'manage',
      markets: 'manage',
      plans: 'manage',
      coupons: 'manage',
      affiliates: 'manage',
      tickets: 'manage',
      announcements: 'manage',
      emails: 'manage',
      cms: 'manage',
      competitions: 'manage',
      leaderboard: 'manage',
      demo: 'manage',
    },
    rights: ['finance.view', 'traders.suspend', 'risk.review', 'tickets.reply', 'kyc.review', 'market.sync'],
  },
  // Support / community: reads trader data, handles tickets and content, no money or settings.
  MODERATOR: {
    grants: {
      overview: 'view',
      traders: 'view',
      accounts: 'view',
      activity: 'view',
      risk: 'view',
      kyc: 'view',
      leaderboard: 'view',
      'trader-view': 'view',
      tickets: 'manage',
      announcements: 'view',
      cms: 'view',
      competitions: 'view',
    },
    rights: ['tickets.reply'],
  },
};
