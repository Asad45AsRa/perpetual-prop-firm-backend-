import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { requirePortal } from '../../middleware/auth';
import { priceFeed } from '../markets/price-feed';
import { computeSnapshot, loadAccountInputs, presentAccountOverview, type AccountInputs } from './account-snapshot';
import { tradingEvents } from './trading-events';

// =====================================================================
// Real-time account stream for the trading terminal: ws://host/ws/account
// Authentication: the same httpOnly session cookie as the REST API (portal TRADER). The connection can only watch
// accounts that belong to the signed-in user.
//
// Client -> server
//   {"op":"subscribe","accountId":"<uuid>"}   watch one account (a new subscribe replaces the previous one and sends a fresh snapshot)
//   {"op":"unsubscribe"}
//   {"op":"ping"}
// Server -> client
//   {type:"account", accountId, ts, account:{...same shape as GET /trading/accounts/:id}, feed:{BTC:{status,markAgeMs}}}
//        every second: balance, equity, open PnL, margin capacity, exposure and every position with its LIVE mark.
//        Recomputed from the stored account state and the live Hyperliquid mark prices, WITHOUT a database read.
//   {type:"orders", accountId, orders:[...]}   working orders, after every order / fill / cancel / expiry
//   {type:"fills",  accountId, fills:[...]}    the latest fills, after every fill (the client de-duplicates by id)
//   {type:"error", code}  ACCOUNT_REQUIRED | ACCOUNT_NOT_FOUND | INVALID_JSON
//   {type:"pong"}
// =====================================================================

const PUSH_EVERY_MS = 1_000;
const SAFETY_REFRESH_MS = 15_000;
const MAX_BUFFERED_BYTES = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Session {
  socket: WebSocket;
  userId: string;
  accountId: string | null;
  inputs: AccountInputs | null;
  loadedAt: number;
  // Reload bookkeeping: one reload at a time per session, a change during a reload triggers one more
  loading: boolean;
  reloadAgain: boolean;
}

export async function accountWebSocket(app: FastifyInstance) {
  const sessions = new Set<Session>();

  const send = (s: Session, payload: unknown) => {
    // A slow client is skipped instead of growing the server memory
    if (s.socket.readyState !== s.socket.OPEN || s.socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    s.socket.send(JSON.stringify(payload));
  };

  // Feed health of every tracked market: the terminal shows Live / Delayed / Paused from this
  const feedStatus = () =>
    Object.fromEntries(priceFeed.trackedSymbols().map((symbol) => [symbol, { status: priceFeed.feedStatus(symbol), markAgeMs: priceFeed.markAgeMs(symbol) }]));

  const pushAccount = (s: Session) => {
    if (!s.accountId || !s.inputs) return;
    const snapshot = computeSnapshot(s.inputs);
    send(s, {
      type: 'account',
      accountId: s.accountId,
      ts: Date.now(),
      account: presentAccountOverview({ id: s.accountId, stage: s.inputs.stage, status: s.inputs.status, startingBalance: s.inputs.startingBalance }, snapshot),
      feed: feedStatus(),
    });
  };

  // Reads the stored state of the account (positions, balance, reservations) plus its orders and latest fills.
  const reload = async (s: Session) => {
    if (!s.accountId) return;
    if (s.loading) {
      s.reloadAgain = true;
      return;
    }
    s.loading = true;
    const accountId = s.accountId;
    try {
      const [inputs, orders, fills] = await Promise.all([
        prisma.$transaction((tx) => loadAccountInputs(tx, accountId)),
        prisma.order.findMany({
          where: { accountId, status: { in: ['NEW', 'PARTIALLY_FILLED'] } },
          include: { market: { select: { symbol: true } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.fill.findMany({ where: { accountId }, include: { market: { select: { symbol: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      ]);
      // The user may have switched account while the queries ran
      if (s.accountId !== accountId) return;
      s.inputs = inputs;
      s.loadedAt = Date.now();
      pushAccount(s);
      send(s, {
        type: 'orders',
        accountId,
        orders: orders.map((o) => ({
          id: o.id,
          symbol: o.market.symbol,
          side: o.side,
          type: o.type,
          status: o.status,
          size: o.size.toString(),
          filledSize: o.filledSize.toString(),
          limitPrice: o.limitPrice?.toString() ?? null,
          triggerPrice: o.triggerPrice?.toString() ?? null,
          leverage: o.leverage,
          reduceOnly: o.reduceOnly,
          postOnly: o.postOnly,
          closePosition: o.closePosition,
          reservedMargin: o.reservedMargin.toString(),
          expiresAt: o.expiresAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
        })),
      });
      send(s, {
        type: 'fills',
        accountId,
        fills: fills.map((f) => ({
          id: f.id,
          orderId: f.orderId,
          symbol: f.market.symbol,
          side: f.side,
          price: f.price.toString(),
          size: f.size.toString(),
          fee: f.fee.toString(),
          feeRate: f.feeRate.toString(),
          liquidity: f.liquidity,
          realizedPnl: f.realizedPnl.toString(),
          createdAt: f.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error({ err, accountId }, 'Account stream reload failed');
    } finally {
      s.loading = false;
      if (s.reloadAgain) {
        s.reloadAgain = false;
        void reload(s);
      }
    }
  };

  // Every second: live marks into the cached account state. No database access.
  const pushTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions) {
      pushAccount(s);
      // Safety net in case a change notification was missed (for example a change made by another instance)
      if (now - s.loadedAt >= SAFETY_REFRESH_MS) void reload(s);
    }
  }, PUSH_EVERY_MS);

  // An order, fill, cancel or risk action changed an account: refresh its watchers at once
  const stopListening = tradingEvents.onAccountChanged(({ accountId }) => {
    for (const s of sessions) if (s.accountId === accountId) void reload(s);
  });

  app.addHook('onClose', async () => {
    clearInterval(pushTimer);
    stopListening();
    for (const s of sessions) s.socket.terminate();
    sessions.clear();
  });

  app.get('/ws/account', { websocket: true, preHandler: requirePortal('TRADER') }, (socket, req) => {
    const session: Session = {
      socket,
      userId: req.user!.id,
      accountId: null,
      inputs: null,
      loadedAt: 0,
      loading: false,
      reloadAgain: false,
    };
    sessions.add(session);

    socket.on('message', async (raw) => {
      let msg: { op?: string; accountId?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(session, { type: 'error', code: 'INVALID_JSON' });
      }

      if (msg.op === 'ping') return send(session, { type: 'pong' });

      if (msg.op === 'unsubscribe') {
        session.accountId = null;
        session.inputs = null;
        return;
      }

      if (msg.op === 'subscribe') {
        if (typeof msg.accountId !== 'string' || !UUID.test(msg.accountId)) return send(session, { type: 'error', code: 'ACCOUNT_REQUIRED' });
        // Ownership: only the signed-in user's own accounts can be watched
        const owned = await prisma.tradingAccount.findFirst({ where: { id: msg.accountId, userId: session.userId }, select: { id: true } });
        if (!owned) return send(session, { type: 'error', code: 'ACCOUNT_NOT_FOUND' });
        // An account switch always starts from a fresh server snapshot (nothing of the previous account is kept)
        session.accountId = owned.id;
        session.inputs = null;
        session.reloadAgain = false;
        await reload(session);
      }
    });

    const drop = () => void sessions.delete(session);
    socket.on('close', drop);
    socket.on('error', drop);
  });
}