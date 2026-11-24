import { EventEmitter } from 'node:events';

// =====================================================================
// In-process notifications about trading state changes.
// The engine, the order matcher and the risk engine announce that an account changed AFTER the database
// transaction committed. The /ws/account stream listens and pushes fresh orders / fills / positions to the terminal.
// Only account ids travel here, never balances or prices.
// =====================================================================

export type AccountChangeReason = 'order' | 'fill' | 'cancel' | 'risk';

export interface AccountChange {
  accountId: string;
  reason: AccountChangeReason;
}

class TradingEvents extends EventEmitter {
  accountChanged(accountId: string, reason: AccountChangeReason) {
    this.emit('account', { accountId, reason } satisfies AccountChange);
  }

  onAccountChanged(listener: (change: AccountChange) => void) {
    this.on('account', listener);
    return () => void this.off('account', listener);
  }
}

export const tradingEvents = new TradingEvents();
// One listener per connected terminal session
tradingEvents.setMaxListeners(0);