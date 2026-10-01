import { describe, expect, it } from 'vitest';
import { commissionAmount, commissionTerms } from '../src/modules/billing/commission';

/**
 * These are the arithmetic a stylist's payslip is made of, which is why they are
 * tested directly rather than through the till.
 *
 * The rule used to live inline in createInvoice and had exactly one caller. It
 * now has two — the till, and the correction on a saved bill — and the failure
 * mode of a second copy would have been silent: the two would agree on a plain
 * percentage and part company on the flat rate and on the precedence below.
 * Nobody finds that by reading; they find it when somebody is short at the end of
 * the month. So the shared rule is pinned here.
 */

const percent = (rate: number) => ({ commissionType: 'PERCENT_OF_SERVICE' as const, commissionRate: rate });
const flat = (rate: number) => ({ commissionType: 'FLAT_PER_SERVICE' as const, commissionRate: rate });
const none = { commissionType: 'NONE' as const, commissionRate: 0 };

describe('whose arrangement applies', () => {
  it("prefers the service's arrangement over the stylist's", () => {
    // The point of setting a rate on a service is to override the default.
    const terms = commissionTerms(percent(5), percent(10));
    expect(terms.ratePct.toString()).toBe('5');
  });

  it("falls back to the stylist's own when the service has no opinion", () => {
    const terms = commissionTerms(none, percent(10));
    expect(terms.ratePct.toString()).toBe('10');
  });

  it('pays nothing when neither carries an arrangement', () => {
    const terms = commissionTerms(none, none);
    expect(commissionAmount(terms, 2800, 1).toString()).toBe('0');
  });

  it('treats a 0% service rate as an arrangement, not as silence', () => {
    // A salon that pays nothing on one treatment says so by setting it to 0 —
    // and that must beat the stylist's 10%, or the exception does nothing.
    const terms = commissionTerms(percent(0), percent(10));
    expect(commissionAmount(terms, 2800, 1).toString()).toBe('0');
  });

  it('applies the service arrangement even where there is no stylist yet', () => {
    const terms = commissionTerms(percent(8), null);
    expect(terms.ratePct.toString()).toBe('8');
  });
});

describe('what the entry is worth', () => {
  it('takes a percentage of what was actually charged, to 2dp', () => {
    // 2372.88 is a 2800 inclusive-GST line's taxable value: a real number from
    // this app, not a round one, so the rounding is exercised.
    expect(commissionAmount(commissionTerms(none, percent(10)), 2372.88, 1).toString()).toBe('237.29');
  });

  it('multiplies a flat rate by the quantity performed', () => {
    // Three blow-dries at 150 each is 450, whatever they were billed at.
    expect(commissionAmount(commissionTerms(none, flat(150)), 4500, 3).toString()).toBe('450');
  });

  it('ignores the charged amount entirely when the rate is flat', () => {
    const terms = commissionTerms(none, flat(200));
    expect(commissionAmount(terms, 0, 1).toString()).toBe('200');
    expect(commissionAmount(terms, 99_999, 1).toString()).toBe('200');
  });

  it('earns nothing on a redeemed line under a percentage arrangement', () => {
    // A service taken out of a package is billed at zero — the salon took the
    // money when the package was sold — so a percentage of it is nothing.
    expect(commissionAmount(commissionTerms(none, percent(10)), 0, 1).toString()).toBe('0');
  });

  it('still pays a flat arrangement on a redeemed line', () => {
    // The work was done. This asymmetry is the whole reason flat and percentage
    // are kept as two fields rather than collapsed into one number.
    expect(commissionAmount(commissionTerms(none, flat(150)), 0, 1).toString()).toBe('150');
  });

  it('records a flat arrangement with a zero rate percentage', () => {
    // What goes in commission_entries.ratePct. A flat payment has no percentage,
    // and writing the flat amount into a column named ratePct would read as a
    // 150% commission in every report that touches it.
    const terms = commissionTerms(none, flat(150));
    expect(terms.ratePct.toString()).toBe('0');
    expect(terms.flat.toString()).toBe('150');
  });
});
