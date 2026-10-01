import { describe, expect, it } from 'vitest';
import { d } from '../src/core/money';
import { computeLineTax } from '../src/modules/billing/gst';

/**
 * THE FOUR ANSWERS, AND WHY EACH ONE IS WHAT IT IS.
 *
 * Two questions, asked independently, and the salon gets to answer both:
 *
 *   Does this price already contain the GST?   — per SERVICE, now
 *   Is GST being charged on this bill?         — per BILL, at the till
 *
 *   price includes tax · bill with GST     ₹800 stays ₹800, ₹122.03 of it declared
 *   price includes tax · bill without GST  the tax comes OUT, ₹800 becomes ₹677.97
 *   price excludes tax · bill with GST     ₹800 becomes ₹944, ₹144 added on top
 *   price excludes tax · bill without GST  ₹800 stays ₹800, nothing to do
 *
 * The third row is what this change is for. Until the flag existed, a salon
 * whose treatments are quoted tax-inclusive and whose premium services are
 * quoted plus-tax had one switch for both, so one group was billed wrong by the
 * tax amount on every single sale — ₹144 a time, on every bill, invisibly.
 *
 * The second row is the one people get wrong by reflex. "No GST" feels like it
 * should leave the price alone. It must not: ₹800 tax-inclusive is ₹677.97 of
 * service and ₹122.03 of tax, so charging ₹800 with no GST on the bill does not
 * remove the tax — it keeps it and stops declaring it. The customer pays a
 * tax-inclusive price for a document that cannot support a claim, and the salon
 * is holding ₹122.03 it has not accounted for.
 */

const line = (net: number, rate = 18) => ({ net: d(net), taxRatePct: d(rate) });
const opts = (inclusive: boolean, gstEnabled: boolean) => ({ inclusive, interState: false, gstEnabled });

describe('a price that already contains the GST', () => {
  it('bills at the menu price and declares the tax inside it', () => {
    const tax = computeLineTax(line(800), opts(true, true));
    expect(tax.lineTotal.toString()).toBe('800');
    expect(tax.taxableValue.toString()).toBe('677.97');
    expect(tax.totalTax.toString()).toBe('122.03');
    // Same state, so it splits in half rather than going out as IGST.
    expect(tax.cgstAmount.toString()).toBe('61.02');
    expect(tax.sgstAmount.toString()).toBe('61.01');
    expect(tax.igstAmount.toString()).toBe('0');
  });

  it('takes the tax back out when the bill carries no GST', () => {
    const tax = computeLineTax(line(800), opts(true, false));
    expect(tax.lineTotal.toString()).toBe('677.97');
    expect(tax.totalTax.toString()).toBe('0');
  });

  it('never leaves the customer paying a tax-inclusive price on a no-GST bill', () => {
    // Said twice on purpose. This is the one somebody will "fix" one day
    // because the total dropping looks like a bug.
    const withGst = computeLineTax(line(2800), opts(true, true));
    const without = computeLineTax(line(2800), opts(true, false));
    expect(withGst.lineTotal.toString()).toBe('2800');
    expect(without.lineTotal.toString()).toBe('2372.88');
    expect(Number(without.lineTotal)).toBeLessThan(Number(withGst.lineTotal));
  });
});

describe('a price with the GST still to be added', () => {
  it('adds the tax on top when the bill carries GST', () => {
    const tax = computeLineTax(line(800), opts(false, true));
    expect(tax.taxableValue.toString()).toBe('800');
    expect(tax.totalTax.toString()).toBe('144');
    expect(tax.lineTotal.toString()).toBe('944');
  });

  it('leaves the price exactly as it is when the bill carries no GST', () => {
    // Nothing was added, so there is nothing to take off. Subtracting a tax that
    // was never there would be a discount nobody asked for.
    const tax = computeLineTax(line(800), opts(false, false));
    expect(tax.lineTotal.toString()).toBe('800');
    expect(tax.taxableValue.toString()).toBe('800');
    expect(tax.totalTax.toString()).toBe('0');
  });
});

describe('the two settings are independent', () => {
  it('gives four different answers to the same ₹800', () => {
    const totals = [
      computeLineTax(line(800), opts(true, true)).lineTotal.toString(),
      computeLineTax(line(800), opts(true, false)).lineTotal.toString(),
      computeLineTax(line(800), opts(false, true)).lineTotal.toString(),
      computeLineTax(line(800), opts(false, false)).lineTotal.toString(),
    ];
    expect(totals).toEqual(['800', '677.97', '944', '800']);
  });

  it('lets two lines on one bill answer differently', () => {
    // The whole point: these two are on the same invoice, under one GST choice,
    // and they are priced on different conventions.
    const inclusive = computeLineTax(line(800), opts(true, true));
    const exclusive = computeLineTax(line(800), opts(false, true));
    expect(inclusive.lineTotal.toString()).toBe('800');
    expect(exclusive.lineTotal.toString()).toBe('944');
  });

  it('holds at a rate other than 18%', () => {
    // 5% is the rate on some salon services; the arithmetic must not be tuned
    // to the common case.
    expect(computeLineTax(line(1050, 5), opts(true, true)).taxableValue.toString()).toBe('1000');
    expect(computeLineTax(line(1000, 5), opts(false, true)).lineTotal.toString()).toBe('1050');
  });

  it('does nothing at all to a zero-value line', () => {
    // A service redeemed from a package is billed at zero. It must stay zero
    // under every combination rather than acquiring tax from somewhere.
    for (const inclusive of [true, false]) {
      for (const gstEnabled of [true, false]) {
        const tax = computeLineTax(line(0), opts(inclusive, gstEnabled));
        expect(tax.lineTotal.toString()).toBe('0');
        expect(tax.totalTax.toString()).toBe('0');
      }
    }
  });
});
