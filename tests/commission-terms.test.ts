import { describe, expect, it } from 'vitest';
import { add, d } from '../src/core/money';
import { commissionAmount, commissionTerms, shareOut, splitCommission } from '../src/modules/billing/commission';

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

describe('cutting one amount into parts', () => {
  it('divides evenly when it divides evenly', () => {
    expect(shareOut(d(1000), 2).map(String)).toEqual(['500', '500']);
  });

  it('still adds up to the whole when it does not', () => {
    // ₹333.33 three times is ₹999.99, and the missing paisa turns up in a
    // reconciliation two quarters later with nobody able to explain it.
    const parts = shareOut(d(1000), 3);
    expect(parts.map(String)).toEqual(['333.34', '333.33', '333.33']);
    expect(parts.reduce((sum, part) => add(sum, part), d(0)).toString()).toBe('1000');
  });

  it('gives the remainder to the first part', () => {
    // The first part is the primary performer. Somebody has to get it, and the
    // name on the line is the one that can be defended.
    expect(shareOut(d(100), 3)[0]!.toString()).toBe('33.34');
  });

  it('hands the whole thing over when there is only one of them', () => {
    expect(shareOut(d(2800), 1).map(String)).toEqual(['2800']);
  });
});

describe('two stylists on one service', () => {
  const priya = { id: 'priya', ...percent(10) };
  const anita = { id: 'anita', ...percent(10) };

  it('splits the line between them rather than paying both in full', () => {
    // A 10% rate on a ₹3,000 service costs the salon ₹300 whether one person
    // did it or three. Paying each of them ₹300 would double the wage bill
    // every time a second name was added, and nothing on the bill would say so.
    const split = splitCommission({ service: none, performers: [priya, anita], base: 3000, quantity: 1 });
    expect(split.map((row) => row.amount.toString())).toEqual(['150', '150']);
  });

  it('lets each earn at their own rate on their own share', () => {
    // Different people are on different deals, and sharing a service does not
    // put them on the same one.
    const split = splitCommission({
      service: none,
      performers: [{ id: 'senior', ...percent(15) }, { id: 'junior', ...percent(5) }],
      base: 2000,
      quantity: 1,
    });
    expect(split.map((row) => row.amount.toString())).toEqual(['150', '50']);
  });

  it('still lets the service arrangement override both of them', () => {
    const split = splitCommission({ service: percent(4), performers: [priya, anita], base: 5000, quantity: 1 });
    expect(split.map((row) => row.amount.toString())).toEqual(['100', '100']);
  });

  it('divides a flat rate too', () => {
    // A flat per-service rate is what the salon pays for the service being done,
    // not what it pays each person who touches it.
    const split = splitCommission({
      service: none,
      performers: [{ id: 'a', ...flat(150) }, { id: 'b', ...flat(150) }],
      base: 4000,
      quantity: 1,
    });
    expect(split.map((row) => row.amount.toString())).toEqual(['75', '75']);
  });

  it('records what each was credited on, not the whole line', () => {
    // baseAmount is what a payslip query reports back. Writing the full line
    // value against each person would show a ₹3,000 service twice.
    const split = splitCommission({ service: none, performers: [priya, anita], base: 3000, quantity: 1 });
    expect(split.map((row) => row.baseAmount.toString())).toEqual(['1500', '1500']);
  });

  it('pays no more in total for three than for one', () => {
    const alone = splitCommission({ service: none, performers: [priya], base: 1000, quantity: 1 });
    const three = splitCommission({
      service: none,
      performers: [priya, anita, { id: 'c', ...percent(10) }],
      base: 1000,
      quantity: 1,
    });
    const total = (rows: { amount: ReturnType<typeof d> }[]) =>
      rows.reduce((sum, row) => add(sum, row.amount), d(0)).toString();

    expect(total(alone)).toBe('100');
    expect(total(three)).toBe('100');
  });

  it('returns nothing at all when nobody is on the line', () => {
    expect(splitCommission({ service: percent(10), performers: [], base: 3000, quantity: 1 })).toEqual([]);
  });
});
