import { describe, expect, it } from 'vitest';
import { add, d, pct, roundOffTotal, splitGst, taxableFromInclusive, pctChange, pctOf } from '../src/core/money';
import { apportionDiscount, computeLineTax, financialYear, isInterStateSupply } from '../src/modules/billing/gst';

describe('money', () => {
  it('adds decimals without floating point drift', () => {
    expect(add(0.1, 0.2).toString()).toBe('0.3');
    expect(add(1650.55, 349.45).toString()).toBe('2000');
  });

  it('computes percentages to 2dp', () => {
    expect(pct(1500, 18).toString()).toBe('270');
    expect(pct(999, 12.5).toString()).toBe('124.88');
  });

  it('reports percentage change safely when the base is zero', () => {
    expect(pctChange(500, 0)).toBe(100);
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(120, 100)).toBe(20);
  });

  it('reports share of a total', () => {
    expect(pctOf(25, 200)).toBe(12.5);
    expect(pctOf(0, 0)).toBe(0);
  });

  it('rounds the invoice total to the nearest rupee and reports the adjustment', () => {
    const { grandTotal, roundOff } = roundOffTotal(1650.4);
    expect(grandTotal.toString()).toBe('1650');
    expect(roundOff.toString()).toBe('-0.4');

    const up = roundOffTotal(1650.6);
    expect(up.grandTotal.toString()).toBe('1651');
    expect(up.roundOff.toString()).toBe('0.4');
  });
});

describe('GST', () => {
  it('splits intra-state tax evenly into CGST and SGST', () => {
    const result = splitGst(1000, 18, false);
    expect(result.cgst.toString()).toBe('90');
    expect(result.sgst.toString()).toBe('90');
    expect(result.igst.toString()).toBe('0');
    expect(result.total.toString()).toBe('180');
  });

  it('uses a single IGST line for inter-state supply', () => {
    const result = splitGst(1000, 18, true);
    expect(result.igst.toString()).toBe('180');
    expect(result.cgst.toString()).toBe('0');
  });

  it('backs tax out of an inclusive price', () => {
    // ₹1,180 inclusive of 18% == ₹1,000 taxable
    expect(taxableFromInclusive(1180, 18).toString()).toBe('1000');
  });

  it('keeps an inclusive line total equal to the price charged', () => {
    const line = computeLineTax({ net: d(1180), taxRatePct: d(18) }, { inclusive: true, interState: false, gstEnabled: true });
    expect(line.lineTotal.toString()).toBe('1180');
    expect(line.taxableValue.toString()).toBe('1000');
    expect(add(line.cgstAmount, line.sgstAmount).toString()).toBe('180');
  });

  it('adds tax on top when prices are exclusive', () => {
    const line = computeLineTax({ net: d(1000), taxRatePct: d(18) }, { inclusive: false, interState: false, gstEnabled: true });
    expect(line.lineTotal.toString()).toBe('1180');
  });

  it('charges nothing when GST is switched off for the tenant', () => {
    const line = computeLineTax({ net: d(1000), taxRatePct: d(18) }, { inclusive: true, interState: false, gstEnabled: false });
    expect(line.totalTax.toString()).toBe('0');
    expect(line.lineTotal.toString()).toBe('1000');
  });

  /**
   * The whole point of the with/without switch at the counter, on one line.
   * A service carries a price and nothing else; the bill decides whether the
   * rate is applied to it. Same ₹800 haircut, same salon rate, two totals.
   */
  it('turns the counter switch into a different total, not a different price', () => {
    const service = { net: d(800), taxRatePct: d(18) };
    const options = { inclusive: false, interState: false };

    const withGst = computeLineTax(service, { ...options, gstEnabled: true });
    const withoutGst = computeLineTax(service, { ...options, gstEnabled: false });

    expect(withGst.lineTotal.toString()).toBe('944');
    expect(withGst.totalTax.toString()).toBe('144');

    expect(withoutGst.lineTotal.toString()).toBe('800');
    expect(withoutGst.totalTax.toString()).toBe('0');

    // The taxable value is the menu price either way — the price the salon set
    // is never altered by the switch.
    expect(withGst.taxableValue.toString()).toBe('800');
    expect(withoutGst.taxableValue.toString()).toBe('800');
  });

  it('apportions a bill discount across lines and absorbs the remainder', () => {
    const shares = apportionDiscount([d(100), d(200), d(700)], d(100));
    const total = shares.reduce((acc, s) => add(acc, s), d(0));
    expect(total.toString()).toBe('100');
    expect(shares[0]!.toString()).toBe('10');
    expect(shares[1]!.toString()).toBe('20');
  });

  it('gives back nothing when there is no discount', () => {
    const shares = apportionDiscount([d(100), d(200)], d(0));
    expect(shares.every((s) => s.isZero())).toBe(true);
  });

  it('detects inter-state supply from state codes', () => {
    expect(isInterStateSupply('09', '09')).toBe(false);
    expect(isInterStateSupply('09', '27')).toBe(true);
    expect(isInterStateSupply(null, '27')).toBe(false);
  });

  it('labels the Indian financial year', () => {
    expect(financialYear(new Date('2026-06-01'))).toBe('26-27');
    expect(financialYear(new Date('2026-03-31'))).toBe('25-26');
  });
});
