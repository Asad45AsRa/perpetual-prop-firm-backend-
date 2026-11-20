# Database tests

These tests run the real order engine against a real PostgreSQL database (fills, ledger, margin,
funding, market sync, WebSocket push, routes). Hyperliquid is never called: prices are fed into the
price feed by the tests, and `hyperliquid-feed.test.ts` runs a small fake Hyperliquid on localhost.

They **wipe the trading tables**, so they only run on a database whose name contains `test`.

```powershell
# 1. Create an empty database, for example "perpetual_prop_test", and point DATABASE_URL at it
#    (use a .env.test file or set the variable in the shell)
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/perpetual_prop_test"

# 2. Create the tables
npx prisma migrate deploy

# 3. Run everything (unit tests + database tests)
$env:RUN_DB_TESTS = "1"
npm test
```

Without `RUN_DB_TESTS=1`, `npm test` runs only the fast unit tests (no database needed).
