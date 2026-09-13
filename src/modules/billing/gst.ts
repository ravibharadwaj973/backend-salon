import type { Prisma } from '@prisma/client';
import { add, d, div, mul, round2, splitGst, sub, taxableFromInclusive } from '../../core/money';

export interface TaxableLine {
  /** Net value of the line after item-level and apportioned bill discounts. */
  net: Prisma.Decimal;
  taxRatePct: Prisma.Decimal;
}

export interface LineTax {
  taxableValue: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  totalTax: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

/**
 * Indian salon menus quote tax-inclusive prices, so by default the net amount is
 * treated as gross-of-GST and the tax is backed out of it. When a tenant prices
 * exclusive of tax, the tax is added on top instead.
 */
export function computeLineTax(line: TaxableLine, options: { inclusive: boolean; interState: boolean; gstEnabled: boolean }): LineTax {
  if (!options.gstEnabled) {
    return {
      taxableValue: round2(line.net),
      cgstAmount: round2(0),
      sgstAmount: round2(0),
      igstAmount: round2(0),
      totalTax: round2(0),
      lineTotal: round2(line.net),
    };
  }

  const taxable = options.inclusive ? taxableFromInclusive(line.net, line.taxRatePct) : round2(line.net);
  const parts = splitGst(taxable, line.taxRatePct, options.interState);

  return {
    taxableValue: taxable,
    cgstAmount: parts.cgst,
    sgstAmount: parts.sgst,
    igstAmount: parts.igst,
    totalTax: parts.total,
    lineTotal: options.inclusive ? round2(line.net) : round2(add(taxable, parts.total)),
  };
}

/**
 * Spreads a bill-level discount across lines in proportion to their value, so
 * that each line's tax is computed on what the customer actually paid for it.
 * The last line absorbs any rounding remainder.
 */
export function apportionDiscount(lineNets: Prisma.Decimal[], billDiscount: Prisma.Decimal): Prisma.Decimal[] {
  const total = lineNets.reduce<Prisma.Decimal>((acc, n) => add(acc, n), d(0));
  if (total.lessThanOrEqualTo(0) || billDiscount.lessThanOrEqualTo(0)) return lineNets.map(() => d(0));

  const shares = lineNets.map((net) => round2(mul(billDiscount, div(net, total))));
  const allocated = shares.reduce<Prisma.Decimal>((acc, s) => add(acc, s), d(0));
  const remainder = sub(billDiscount, allocated);

  if (!remainder.isZero() && shares.length) {
    shares[shares.length - 1] = round2(add(shares[shares.length - 1]!, remainder));
  }
  return shares;
}

/** GSTIN state code (first two digits) — used to decide CGST/SGST vs IGST. */
export function stateCodeFromGstin(gstin?: string | null): string | null {
  if (!gstin || gstin.length < 2) return null;
  return gstin.slice(0, 2);
}

export function isInterStateSupply(branchStateCode?: string | null, placeOfSupply?: string | null): boolean {
  if (!branchStateCode || !placeOfSupply) return false;
  return branchStateCode !== placeOfSupply;
}

/** Indian financial year label for an invoice date: 2026-06-01 -> "26-27". */
export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() + 1 >= 4 ? year : year - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

/** HSN/SAC-wise tax summary for the GSTR-style report on an invoice. */
export function taxSummary(
  lines: { hsnSac: string | null; taxRatePct: Prisma.Decimal; taxableValue: Prisma.Decimal; cgstAmount: Prisma.Decimal; sgstAmount: Prisma.Decimal; igstAmount: Prisma.Decimal }[],
) {
  const map = new Map<string, { hsnSac: string; taxRatePct: number; taxableValue: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal }>();

  for (const line of lines) {
    const key = `${line.hsnSac ?? '-'}:${line.taxRatePct.toString()}`;
    const entry = map.get(key) ?? {
      hsnSac: line.hsnSac ?? '-',
      taxRatePct: Number(line.taxRatePct),
      taxableValue: d(0),
      cgst: d(0),
      sgst: d(0),
      igst: d(0),
    };
    entry.taxableValue = add(entry.taxableValue, line.taxableValue);
    entry.cgst = add(entry.cgst, line.cgstAmount);
    entry.sgst = add(entry.sgst, line.sgstAmount);
    entry.igst = add(entry.igst, line.igstAmount);
    map.set(key, entry);
  }

  return [...map.values()];
}
