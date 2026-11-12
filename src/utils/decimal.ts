import Decimal from 'decimal.js';

// Money math must never use JavaScript floats.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

// Convert any Prisma Decimal / string / number into a decimal.js value.
export function toD(value: { toString(): string } | string | number): Decimal {
  return new Decimal(value.toString());
}

export const ZERO = new Decimal(0);
