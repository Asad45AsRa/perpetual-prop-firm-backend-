import type { LedgerType } from '@prisma/client';
import type { Tx } from '../../config/prisma';
import { Decimal, toD } from '../../utils/decimal';

export interface LedgerInput {
  accountId: string;
  type: LedgerType;
  // Signed amount: positive credits the account, negative debits it
  amount: Decimal;
  refType?: string;
  refId?: string;
  // Same key twice = second call is ignored (safe retries)
  idempotencyKey?: string;
  description?: string;
}

// THE ONLY place that changes TradingAccount.balance.
// Every call writes an append-only LedgerEntry with the balance after the
// change, so the balance can always be rebuilt and reconciled from the ledger.
// Must be called inside a transaction (pass the tx client).
export async function postLedgerEntry(tx: Tx, input: LedgerInput) {
  if (input.idempotencyKey) {
    const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
  }

  const account = await tx.tradingAccount.update({
    where: { id: input.accountId },
    data: { balance: { increment: input.amount.toFixed() } },
    select: { balance: true },
  });

  return tx.ledgerEntry.create({
    data: {
      accountId: input.accountId,
      type: input.type,
      amount: input.amount.toFixed(),
      balanceAfter: toD(account.balance).toFixed(),
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      description: input.description,
    },
  });
}
