import { Prisma } from '@prisma/client';

export type Numeric = Prisma.Decimal | number | string | null | undefined;

export const ZERO = new Prisma.Decimal(0);

/** Coerce anything money-shaped into a Decimal. Null/undefined become 0. */
export function d(value: Numeric): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

/** Round to 2 dp using half-up, which is what Indian invoicing expects. */
export function round2(value: Numeric): Prisma.Decimal {
  return d(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function round3(value: Numeric): Prisma.Decimal {
  return d(value).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
}

export function add(...values: Numeric[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(d(v)), new Prisma.Decimal(0));
}

export function sub(a: Numeric, b: Numeric): Prisma.Decimal {
  return d(a).minus(d(b));
}

export function mul(a: Numeric, b: Numeric): Prisma.Decimal {
  return d(a).times(d(b));
}

export function div(a: Numeric, b: Numeric): Prisma.Decimal {
  const divisor = d(b);
  if (divisor.isZero()) return new Prisma.Decimal(0);
  return d(a).dividedBy(divisor);
}

export function pct(value: Numeric, percent: Numeric): Prisma.Decimal {
  return round2(mul(d(value), div(d(percent), 100)));
}

/** Safe percentage change: returns 0 when the base is 0 rather than Infinity. */
export function pctChange(current: Numeric, previous: Numeric): number {
  const prev = d(previous);
  if (prev.isZero()) return d(current).isZero() ? 0 : 100;
  return Number(div(sub(current, prev), prev).times(100).toDecimalPlaces(2));
}

export function ratio(numerator: Numeric, denominator: Numeric): number {
  const den = d(denominator);
  if (den.isZero()) return 0;
  return Number(div(numerator, den).toDecimalPlaces(4));
}

export function pctOf(numerator: Numeric, denominator: Numeric): number {
  return Number((ratio(numerator, denominator) * 100).toFixed(2));
}

export function max(a: Numeric, b: Numeric): Prisma.Decimal {
  const x = d(a);
  const y = d(b);
  return x.greaterThan(y) ? x : y;
}

export function min(a: Numeric, b: Numeric): Prisma.Decimal {
  const x = d(a);
  const y = d(b);
  return x.lessThan(y) ? x : y;
}

export function clampNonNegative(value: Numeric): Prisma.Decimal {
  const v = d(value);
  return v.isNegative() ? new Prisma.Decimal(0) : v;
}

export function isZero(value: Numeric): boolean {
  return d(value).isZero();
}

export function gt(a: Numeric, b: Numeric): boolean {
  return d(a).greaterThan(d(b));
}

export function gte(a: Numeric, b: Numeric): boolean {
  return d(a).greaterThanOrEqualTo(d(b));
}

export function lt(a: Numeric, b: Numeric): boolean {
  return d(a).lessThan(d(b));
}

export function toNumber(value: Numeric): number {
  return Number(d(value).toDecimalPlaces(2));
}

/** ₹1,23,456.78 — Indian digit grouping. */
export function formatINR(value: Numeric): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(toNumber(value));
}

/**
 * Indian GST split. Intra-state bills split evenly into CGST + SGST;
 * inter-state bills carry a single IGST line.
 */
export function splitGst(taxableValue: Numeric, ratePct: Numeric, isInterState: boolean) {
  const totalTax = pct(taxableValue, ratePct);
  if (isInterState) {
    return { cgst: ZERO, sgst: ZERO, igst: totalTax, total: totalTax };
  }
  const half = round2(div(totalTax, 2));
  const other = round2(sub(totalTax, half));
  return { cgst: half, sgst: other, igst: ZERO, total: add(half, other) };
}

/**
 * Prices in Indian salons are usually quoted tax-inclusive. Given a gross
 * amount, work back to the taxable value.
 */
export function taxableFromInclusive(grossAmount: Numeric, ratePct: Numeric): Prisma.Decimal {
  const rate = d(ratePct);
  return round2(div(mul(grossAmount, 100), add(100, rate)));
}

/** Round the invoice total to the nearest rupee and report the adjustment. */
export function roundOffTotal(total: Numeric) {
  const exact = round2(total);
  const rounded = exact.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return { grandTotal: rounded, roundOff: round2(sub(rounded, exact)) };
}
