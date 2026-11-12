import type { Tx } from '../../config/prisma';
import { Decimal, toD, ZERO } from '../../utils/decimal';
import { unrealizedPnl } from './engine/calculations';
import { priceFeed } from '../markets/price-feed';

export interface PositionView {
  marketId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  leverage: number;
  margin: Decimal;
  unrealizedPnl: Decimal;
  liquidationPrice: Decimal | null;
}

export interface AccountSnapshot {
  balance: Decimal;
  unrealizedPnl: Decimal;
  equity: Decimal;
  marginUsed: Decimal;
  freeMargin: Decimal;
  positions: PositionView[];
}

// Builds a live view of an account: balance + floating PnL = equity.
// Uses the live price when it is fresh, otherwise the last stored mark price.
export async function computeAccountSnapshot(tx: Tx, accountId: string): Promise<AccountSnapshot> {
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { balance: true },
  });
  const rows = await tx.position.findMany({
    where: { accountId, size: { gt: 0 } },
    include: { market: { select: { symbol: true } } },
  });

  const positions: PositionView[] = rows.map((p) => {
    const live = priceFeed.isFresh(p.market.symbol) ? priceFeed.getPrice(p.market.symbol) : undefined;
    const mark = live ? live.mid : toD(p.markPrice);
    const size = toD(p.size);
    const entry = toD(p.entryPrice);
    return {
      marketId: p.marketId,
      symbol: p.market.symbol,
      side: p.side,
      size,
      entryPrice: entry,
      markPrice: mark,
      leverage: p.leverage,
      margin: toD(p.margin),
      unrealizedPnl: unrealizedPnl(p.side, size, entry, mark),
      liquidationPrice: p.liquidationPrice ? toD(p.liquidationPrice) : null,
    };
  });

  const balance = toD(account.balance);
  const floating = positions.reduce((sum, p) => sum.plus(p.unrealizedPnl), ZERO);
  const marginUsed = positions.reduce((sum, p) => sum.plus(p.margin), ZERO);
  const equity = balance.plus(floating);

  return { balance, unrealizedPnl: floating, equity, marginUsed, freeMargin: equity.minus(marginUsed), positions };
}
