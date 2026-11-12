# Perpetual Prop Firm - Backend

Node.js + TypeScript backend for the prop-firm platform: authentication, simulated
perpetual trading engine, risk/evaluation engine, Plisio payments, payouts, affiliates,
admin tools and background jobs. Hyperliquid is used for **market data only**.

Stack: Fastify, Prisma, PostgreSQL, Zod, Pino, Vitest, decimal.js, ws, node-cron, Resend.

## 1. Setup on Windows

Requirements: Node.js 20+, npm, PostgreSQL (local install, Docker Desktop, or a free Neon database).

```powershell
cd "D:\Perpetual Prop\backend"
`npm install`

# Create your environment file
copy .env.example .env
# Edit .env: set DATABASE_URL, JWT secrets, MFA_ENCRYPTION_KEY, SUPER_ADMIN_EMAIL/PASSWORD

# Generate secrets (run twice for the two JWT secrets, once for MFA_ENCRYPTION_KEY)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Optional local database with Docker
docker compose up -d

# Create tables and the first super admin
npm run prisma:migrate -- --name init
npm run db:seed

# Start the API with auto reload
npm run dev
```

Open http://localhost:4000/health - it should return `{"status":"ok",...}` once the database
and the Hyperliquid price feed are connected.

Useful commands: `npm test`, `npm run typecheck`, `npm run prisma:studio`, `npm run build`.

### Staging and production

Environment files are selected by `APP_ENV`. Create `.env.staging` and `.env.production`
from `.env.staging.example` / `.env.production.example` (separate database, secrets and keys).

```powershell
npm run dev:staging
npm run build ; npm run start:production
```

On the server run `npm run prisma:deploy` (applies migrations without prompts).
Render build command: `npm install && npm run build`. Start command: `npm run start:production`.

## 2. Folder structure

```
backend/
  prisma/
    schema.prisma          Step 2: all tables (decimal money, ledger, risk events, audit logs)
    seed.ts                Super admin, placeholder plans, empty FAQ/rules blocks
  src/
    server.ts              Boot: DB, market sync, price feed, jobs, graceful shutdown
    app.ts                 Fastify app, plugins, route registration
    config/                env validation (zod), logger, prisma client, constants
    middleware/            auth (JWT, roles, per-section permissions), error handler
    utils/                 decimal, tokens, password, encryption, validation helpers
    services/              email.service.ts (Resend)
    modules/
      auth/                Step 3: signup, verify email, login, refresh, reset, admin MFA
      markets/             Step 4: Hyperliquid client, live price feed, stale-price check, WS to frontend
      trading/             Step 5: engine/calculations.ts (pure math), trading.service.ts, routes
      risk/                Step 6: risk-rules.ts (pure), risk.service.ts (breach, pass, daily reset)
      ledger/              Only place allowed to change an account balance
      payments/            Step 7: Plisio invoices, signed webhook, one-time activation
      payouts/             Step 8: request, review, approve, tx hash proof, public feed
      affiliates/          Step 8: referral codes, commissions
      admin/               Step 8: staff, users, plans, markets, accounts, risk, payouts, CMS, settings, audit
      content/             Public FAQ / rules from the admin panel
      plans/               Public plan list
      settings/            Fees, spread, payout rules stored in DB (not hard coded)
      audit/               Audit log helper
      health/              /health and admin system health
    jobs/index.ts          Step 9: risk monitor, daily reset, payment checks, reconciliation, reports
  tests/                   Unit tests for formulas, risk rules, Plisio signature
```

## 3. The nine steps and where they live

| Step | Topic | Files |
|---|---|---|
| 1 | Project setup, env, logging, tests, staging/prod | `package.json`, `src/config/*`, `.env.*.example`, `vitest.config.ts`, `.github/workflows/ci.yml` |
| 2 | Database | `prisma/schema.prisma` |
| 3 | Auth and users | `src/modules/auth/*`, `src/middleware/auth.ts` |
| 4 | Market data | `src/modules/markets/*` (BTC and ETH first via `LAUNCH_SYMBOLS`) |
| 5 | Trading engine | `src/modules/trading/*`, `src/modules/ledger/*` |
| 6 | Risk and evaluation | `src/modules/risk/*` |
| 7 | Payments | `src/modules/payments/*` |
| 8 | Payouts, affiliates, admin | `src/modules/payouts`, `affiliates`, `admin` |
| 9 | Jobs and launch prep | `src/jobs/index.ts`, `/health` |

## 4. Key design rules

- **Decimals only.** Money, prices and sizes are `Decimal` in the database and `decimal.js` in code.
- **Ledger first.** `TradingAccount.balance` is changed only by `ledger.service.ts`, which writes an append-only
  `LedgerEntry`. The hourly job compares balances with ledger sums and logs any mismatch.
- **One order at a time per account.** Orders lock the account row (`SELECT ... FOR UPDATE`), and `clientOrderId`
  prevents duplicate orders on retry.
- **Stale prices block trading.** If no fresh price exists (`STALE_PRICE_MS`), orders are rejected.
  Risk closing still works with the last known price.
- **One payment, one account.** `TradingAccount.purchaseId` is unique, the purchase row is locked on activation,
  and the webhook is verified by signature plus a server-to-server status check.
- **Configurable business rules.** Fees, spread, payout split, minimum payout and affiliate commission are in
  `PlatformSetting` (admin endpoint `/api/v1/admin/settings`). Plans store the daily-loss and drawdown method.
- **Admin security.** Staff must pass MFA (TOTP). The first super admin is protected and cannot be deleted; it creates
  admins/moderators and grants sections one by one. Deleted staff cannot log in and their sessions are revoked.

## 5. API overview (prefix `/api/v1`)

Public: `GET /plans`, `GET /markets`, `GET /markets/:symbol/price`, `GET /payouts/public`, `GET /content/faq`,
`GET /content/rules`, `POST /auth/signup|verify-email|login|refresh|logout|forgot-password|reset-password`,
`POST /auth/mfa/verify`. WebSocket: `ws://host/ws/market` (live prices).

Logged in: `GET /auth/me`, `POST /auth/mfa/setup|enable`, `POST /payments/checkout`, `GET /payments/purchases`,
`GET /trading/accounts`, `GET /trading/accounts/:id`, `POST /trading/accounts/:id/orders`,
`POST /trading/accounts/:id/positions/:symbol/close`, `GET /trading/accounts/:id/orders|fills|ledger`,
`POST /payouts`, `GET /payouts`, `GET /payouts/eligibility/:accountId`, `GET /affiliates/me`.

Webhook: `POST /payments/plisio/callback`.

Admin (`/admin/...`, staff + MFA + section permission): `dashboard`, `users`, `staff` (super admin), `plans`, `markets`,
`accounts`, `risk-events`, `payouts`, `commissions`, `content`, `settings`, `audit-logs`, `system-health`.

Order example:

```json
POST /api/v1/trading/accounts/<accountId>/orders
{ "symbol": "BTC", "side": "BUY", "size": "0.01", "leverage": 5, "clientOrderId": "abc-123" }
```

Errors always look like `{ "error": { "code": "...", "message": "...", "details": ... } }`.

## 6. First-run flow

1. `npm run db:seed` creates the super admin from `.env` (and placeholder plans).
2. Log in with `POST /auth/login`. The response has `mfaSetupRequired: true`.
3. Call `POST /auth/mfa/setup`, scan `otpauthUrl` in an authenticator app, then `POST /auth/mfa/enable` with a code.
4. Use the returned access token for `/admin/...` routes. Future logins return `mfaRequired` + `mfaToken`; send them
   with the 6-digit code to `POST /auth/mfa/verify`.

## 7. Not finished yet (next steps)

- LIMIT orders, TP/SL, cancel/replace (engine currently supports MARKET orders, including reduce-only and close).
- Funding rate simulation (the `FUNDING` ledger type exists, formula needs client approval).
- Order-book based fills when depth data is tracked (currently best bid/ask plus configurable spread/slippage).
- On-chain verification of payout transaction hashes.
- KYC / restricted jurisdictions, refund policy, competitions, email management, and richer email templates.
- Database integration tests, load tests for 106 symbols, backups and recovery runbook, Redis queue if needed.
- Marking each market's trading hours and non-crypto symbols (current sync only reads `LAUNCH_SYMBOLS`).

## 8. Decisions to confirm with the client

Account sizes and prices, profit target, daily-loss method (`BALANCE_BASED` or `EQUITY_BASED`), drawdown type
(`STATIC` or `TRAILING`), daily reset hour (`DAILY_RESET_UTC_HOUR`), leverage caps, fees/funding, payout minimum and
split, supported Plisio coins/networks, challenge-to-funded transition. All of these are configuration, not code.
#   p e r p e t u a l - p r o p - f i r m - b a c k e n d -  
 