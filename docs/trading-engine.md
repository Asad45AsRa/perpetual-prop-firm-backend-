# Trading engine: market data, orders, fills, positions

Implements the Perpeye spec v1.0 (18 Nov 2026) for: Hyperliquid market data, live prices, stale-price
blocking, order management / execution / fills, positions, fees, margin, PnL and funding.
Hyperliquid is used for **market data only**, and only from this backend. Browsers talk to our REST
API and to `ws://host/ws/market`.

## 1. Market data

| What | Where |
|---|---|
| REST client (timeout, retry on 429/5xx) | `modules/markets/hyperliquid.client.ts` |
| Live feed: `l2Book` (depth) + `activeAssetCtx` (mark, oracle, funding) | `modules/markets/price-feed.ts` |
| Market registry sync (`meta`) | `modules/markets/market.service.ts`, `market.catalog.ts` |
| Push to browsers | `modules/markets/market.ws.ts` |

* Supported symbols come from `LAUNCH_SYMBOLS` (BTC, ETH). `syncMarkets()` runs at startup and from
  the admin panel (`POST /admin/markets/sync`). It stores exact exchange facts (size decimals,
  price tick, size step) and the reviewed limits from `market.catalog.ts`.
* A symbol without a reviewed catalog row is created **disabled**. A delisted contract becomes
  **close-only**. Admin edits are never overwritten by a sync; a lower Hyperliquid leverage limit always wins.
* **Stale prices block trading.** A market is tradable only when BOTH the order book (`STALE_BOOK_MS`,
  default `STALE_PRICE_MS` = 5 s) and the mark price (`STALE_MARK_MS`, default 10 s) are fresh.
  Orders get `MARKET_FEED_STALE`; the order matcher makes no fills and fires no triggers; cancels still work.
* Feed safety: REST snapshot on start and reconnect, exponential reconnect, ping, a watchdog that
  reconnects a silent socket, rejection of crossed / empty books, out-of-order updates are dropped,
  and a REST fallback for the mark price.

### WebSocket `/ws/market`

Server to client: `hello`, `price` (price, bid, ask, mark, oracle, fundingRate, bookFresh, markFresh, fresh, ts),
`book` (top 10 levels, only if subscribed), `feed` (sent when a symbol becomes stale or fresh again), `pong`.
Client to server: `{"op":"subscribe","symbols":["BTC"],"channels":["price","book"]}`, `unsubscribe`, `{"op":"ping"}`.
Updates are coalesced per symbol (`WS_PUSH_INTERVAL_MS`, default 250 ms).

## 2. Orders

`POST /api/v1/trading/accounts/:accountId/orders` (header `Idempotency-Key` or body `clientOrderId`).

| type | needs | behaviour |
|---|---|---|
| `MARKET` | size | Walks the real book (VWAP). Taker fee. Opening / adding / reversing needs the **full** size within the book and within `maxSlippagePct` (default 3 %, rejects only when strictly above). Closing orders may fill partly and have no slippage cap. |
| `LIMIT` | size, limitPrice | Crossing the book fills as taker, never above the limit. The rest rests (`GTC`) or is cancelled (`IOC`). Resting orders fill as **maker at the limit price** when the best opposite price touches it (markets with `requireMarkConfirm` also need the mark). `postOnly` rejects instead of taking. Reserves margin for the opening part. |
| `STOP_MARKET` | size, triggerPrice | Entry stop. Reserves nothing; margin and caps are re-checked when it fires. |
| `TAKE_PROFIT` / `STOP_LOSS` | triggerPrice + size or `closePosition` | Reduce-only exits. Fire when the **mark OR the executable side of the book** touches the level; fill from the live book as taker (no guaranteed price). A thin book fills what it can and the rest stays armed. |

Other rules: `reduceOnly`, `positionSide` (hedge mode), `leverage` (per order, max = min(market, plan)),
size must be a multiple of the step and above the minimum order value, prices must be on the tick grid
(max 5 significant figures). Modify (`PATCH`) validates the replacement first and cancels the old order in
the same transaction. Cancel is idempotent. Cancel-all also cancels exits.
A fully closed leg cancels its TP / SL / reduce-only orders. Locked accounts (breach, pass, admin lock) cancel all working orders.

Limits (editable in the `trading` setting): 50 open orders, 20 open position legs, 10 exit orders per position,
gross exposure <= 10x equity for new exposure (`OVER_CAP` allows reducing only).

## 3. Positions, margin, PnL, fees

* **Cross margin.** `IM = notional / leverage` per opening fill (a position keeps the sum, so adding at another
  leverage never re-margins the old part). `MMR reference = IM / 2` (display only, never liquidates; there is no
  liquidation price). `equity = balance + floating PnL (mark)`;
  `available = equity - IM - margin reserved by working orders`.
* **Modes.** `ONE_WAY` (default): opposite orders reduce, close or reverse. `HEDGE`: independent long and short per market,
  `positionSide` required. Change the mode with `PUT .../position-mode` only when flat and with no working orders.
* **PnL.** Realized PnL and fee are posted per fill through the ledger (`REALIZED_PNL`, `FEE`). Fees are rounded up,
  signed amounts down (never in the trader's favour), 8 decimals.
* **Fees** (notional x rate, on entries and exits): crypto maker 0.01 % / taker 0.04 %; equity 0 / 0.03 %;
  commodity, index, FX 0 / 0.005 %. Overrides: `trading` setting `fees`, or per market (`makerFeeRate`, `takerFeeRate`).
* **Funding** (`modules/markets/funding.service.ts`): every UTC hour the open positions are snapshotted; when the
  official rate is published the cash flow `-(signed size) x oracle x rate` is posted once (unique key per position
  and hour). A missing rate is never replaced by zero: the row stays pending and is retried every minute.
* Every fill stores: liquidity (maker / taker), fee rate, the book levels consumed, book time and the rules version.

## 4. Error codes (HTTP 422 unless noted)

`MARKET_FEED_STALE`, `MARKET_DISABLED`, `MARKET_CLOSE_ONLY`, `TRADING_PAUSED`, `ACCOUNT_NOT_ACTIVE`, `INVALID_ORDER`,
`INVALID_LOT`, `INVALID_TICK`, `BELOW_MIN_NOTIONAL`, `LEVERAGE_CAP`, `INVALID_SLIPPAGE`, `VISIBLE_BOOK_TOO_THIN`,
`OPEN_SLIPPAGE_EXCEEDED`, `POST_ONLY_WOULD_TAKE`, `TRIGGER_WOULD_FIRE`, `POSITION_SIDE_REQUIRED`, `INVALID_POSITION_SIDE`,
`NO_POSITION`, `REDUCE_ONLY`, `REDUCE_ONLY_EXCESS`, `EXIT_LEG_LIMIT`, `EXIT_SIZE_EXCEEDS_POSITION`, `OPEN_ORDER_LIMIT`,
`OPEN_POSITION_LIMIT`, `POSITION_CAP`, `GROSS_EXPOSURE_CAP`, `INSUFFICIENT_MARGIN`, `POSITION_MODE_LOCKED`,
`ORDER_ALREADY_FILLED`, `ORDER_NOT_ACTIVE`. Stable codes: the frontend can map each one to a message.

## 5. Assumptions to confirm with the owner

* BTC / ETH leverage 10x and `maxNotionalUsd` 1,000,000 are the spec's "possible" values, not a verified market row.
  Confirm them, or change them in the admin panel (Markets).
* Resting limit fills at the limit price, from visible liquidity, once per sweep and shared between orders (FIFO).
  The real queue position is not simulated.
* The mark-price staleness limit (10 s) and the matcher interval (500 ms) are engineering choices, not spec values.
* Funding is snapshotted by a job within a few seconds after the UTC hour.
* Spec items not built here (phase 2): Scale, TWAP, Chase Limit, Pair Trading, Reverse; hotkeys / one-click; FOK.
