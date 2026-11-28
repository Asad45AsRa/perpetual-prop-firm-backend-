import type { Tx } from '../../config/prisma';
import { ApiError } from '../../utils/api-error';
import { getSetting } from '../settings/settings.service';

// Pre-trade guard used by the order engine for every order that OPENS or INCREASES exposure.
// A trader must not hold the opposite side of the same market in another account of his own: such a pair is risk free for the
// trader and a certain loss for the firm. Hedging inside one account is already impossible (one-way mode, opposite orders net).
// It can be switched off in the admin settings ("risk.blockCrossAccountHedge").
export async function assertNoCrossAccountHedge(
  tx: Tx,
  p: { userId: string; accountId: string; marketId: string; symbol: string; openSide: 'LONG' | 'SHORT' },
): Promise<void> {
  const settings = await getSetting('risk');
  if (!settings.blockCrossAccountHedge) return;

  const opposite = p.openSide === 'LONG' ? 'SHORT' : 'LONG';
  const conflict = await tx.position.findFirst({
    where: {
      marketId: p.marketId,
      side: opposite,
      size: { gt: 0 },
      accountId: { not: p.accountId },
      account: { userId: p.userId, status: 'ACTIVE' },
    },
    select: { accountId: true },
  });
  if (conflict) {
    throw ApiError.unprocessable(
      'CROSS_ACCOUNT_HEDGE',
      `Another account of yours holds a ${opposite} position in ${p.symbol}. Opening the opposite side in a second account (hedging) is not allowed.`,
      { symbol: p.symbol, openSide: p.openSide, otherAccountId: conflict.accountId },
    );
  }
}