import Decimal from 'decimal.js';
import type { PositionSide, Side } from './calculations';

// =====================================================================
// Pure position-mode rules: which part of an order closes an existing position
// and which part opens (or adds to) one.
//   ONE_WAY: one net position per market. An opposite order reduces, closes or reverses it.
//   HEDGE  : independent LONG and SHORT legs. The order names the leg (positionSide):
//            BUY+LONG / SELL+SHORT open or add, SELL+LONG / BUY+SHORT reduce that leg only.
// =====================================================================

export type Mode = 'ONE_WAY' | 'HEDGE';

export interface LegState {
  side: PositionSide;
  size: Decimal;
}

export interface Classification {
  // Leg that is reduced by this order (null = nothing is closed)
  closeSide: PositionSide | null;
  closeSize: Decimal;
  // Leg that is opened or increased (null = nothing is opened)
  openSide: PositionSide | null;
  openSize: Decimal;
  // Hedge mode: the order wants to reduce more than the leg holds
  exceedsLeg: boolean;
}

// Direction of the exposure an order creates when it opens: BUY = LONG, SELL = SHORT.
export const openingSideOf = (side: Side): PositionSide => (side === 'BUY' ? 'LONG' : 'SHORT');

// The leg an order closes: SELL closes a LONG, BUY closes a SHORT.
export const closingLegOf = (side: Side): PositionSide => (side === 'SELL' ? 'LONG' : 'SHORT');

export function classifyOrder(
  mode: Mode,
  side: Side,
  positionSide: PositionSide | null,
  long: LegState | null,
  short: LegState | null,
  size: Decimal,
): Classification {
  const zero = new Decimal(0);

  if (mode === 'HEDGE') {
    const leg = positionSide ?? closingLegOf(side);
    const opening = openingSideOf(side) === leg;
    if (opening) return { closeSide: null, closeSize: zero, openSide: leg, openSize: size, exceedsLeg: false };
    const held = (leg === 'LONG' ? long : short)?.size ?? zero;
    return { closeSide: leg, closeSize: Decimal.min(size, held), openSide: null, openSize: zero, exceedsLeg: size.gt(held) };
  }

  // ONE_WAY: the opposing leg (if any) is closed first, the rest opens the order's own direction
  const opposing = closingLegOf(side) === 'LONG' ? long : short;
  const held = opposing && opposing.size.gt(0) ? opposing.size : zero;
  const closeSize = Decimal.min(size, held);
  const openSize = size.minus(closeSize);
  return {
    closeSide: closeSize.gt(0) ? closingLegOf(side) : null,
    closeSize,
    openSide: openSize.gt(0) ? openingSideOf(side) : null,
    openSize,
    exceedsLeg: false,
  };
}
