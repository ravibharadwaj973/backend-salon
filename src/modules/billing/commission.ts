import type { CommissionType, Prisma } from '@prisma/client';
import { add, d, div, mul, round2, sub } from '../../core/money';

/**
 * WHO EARNS WHAT ON A BILLED SERVICE — IN ONE PLACE.
 *
 * This used to live inline inside createInvoice, which was fine while the till
 * was the only thing that ever wrote a commission entry. It is not any more:
 * the staff member on a billed line can be corrected afterwards, and that path
 * has to arrive at exactly the same number the till would have.
 *
 * Two copies of this rule would not fail loudly. They would agree on the common
 * case — a percentage on the line total — and disagree on the flat-per-service
 * one, or on the precedence below, and the only symptom would be a stylist's
 * payslip being a few hundred rupees out on the bills that had been corrected.
 * Nobody traces that back to a duplicated conditional. So it is written once and
 * both callers read it.
 */

/** Anything that carries a commission arrangement: a service, or a stylist. */
export interface CommissionArrangement {
  commissionType: CommissionType;
  commissionRate: Prisma.Decimal | number | string;
}

export interface CommissionTerms {
  /** A fixed amount per unit performed. Wins over `ratePct` when above zero. */
  flat: Prisma.Decimal;
  /** A percentage of the line's charged value. */
  ratePct: Prisma.Decimal;
}

export const NO_COMMISSION: CommissionTerms = { flat: d(0), ratePct: d(0) };

/**
 * THE SERVICE'S ARRANGEMENT WINS; OTHERWISE THE STYLIST'S OWN.
 *
 * That precedence is deliberate and not arbitrary. A salon that pays 10% across
 * the board sets it on each stylist. A salon that pays differently on one
 * treatment — a keratin at 5% because the product cost is most of the price —
 * sets it on the service, and that has to override every stylist's default or
 * the exception is pointless.
 *
 * `NONE` on the service means "no opinion, use the stylist's", NOT "pay nothing
 * on this service". There is no way to express the latter here, and that is a
 * known limitation rather than an oversight: to pay nothing, the service is set
 * to a 0% rate, which is a positive statement and survives a reader.
 */
export function commissionTerms(
  service: CommissionArrangement | null | undefined,
  staff: CommissionArrangement | null | undefined,
): CommissionTerms {
  const arrangement =
    service && service.commissionType !== 'NONE'
      ? service
      : staff && staff.commissionType !== 'NONE'
        ? staff
        : null;

  if (!arrangement) return NO_COMMISSION;

  /**
   * Every type other than FLAT_PER_SERVICE is treated as a straight percentage
   * of the line, which is exactly what PERCENT_OF_SERVICE means and is NOT what
   * PERCENT_OF_TOTAL or SLAB mean. Both of those need something this function
   * cannot see — the whole bill, or the stylist's month to date — so they
   * currently behave as PERCENT_OF_SERVICE rather than failing.
   *
   * That is carried over from the till unchanged, deliberately: this refactor
   * moved the rule, it did not change anybody's pay. Written down here because a
   * salon that picks SLAB in the staff form and gets a flat percentage has no
   * way of knowing that from the outside, and the next person to implement slabs
   * needs to know this is the only place it has to change.
   */
  return arrangement.commissionType === 'FLAT_PER_SERVICE'
    ? { flat: d(arrangement.commissionRate), ratePct: d(0) }
    : { flat: d(0), ratePct: d(arrangement.commissionRate) };
}

/**
 * What the entry is worth.
 *
 * `base` is the line's charged value — what the customer actually paid for it
 * after discounts, not the menu price. A line redeemed from a package or a
 * membership has a base of zero, so a percentage arrangement earns nothing on
 * it while a flat-per-service arrangement still pays: the stylist did the work,
 * and the salon took the money when the package was sold.
 */
export function commissionAmount(
  terms: CommissionTerms,
  base: Prisma.Decimal | number | string,
  quantity: Prisma.Decimal | number | string,
): Prisma.Decimal {
  return terms.flat.greaterThan(0)
    ? round2(mul(terms.flat, quantity))
    : round2(mul(d(base), div(terms.ratePct, 100)));
}

/**
 * ONE AMOUNT, CUT INTO PARTS THAT STILL ADD UP TO IT.
 *
 * ₹1,000 between three people is not ₹333.33 three times — that is ₹999.99, and
 * the missing paisa is the kind of thing that turns up in a GST reconciliation
 * two quarters later with nobody able to explain it. The remainder goes to the
 * first part, which is the primary performer: somebody has to get it, and the
 * person whose name is on the line is the defensible choice.
 */
export function shareOut(total: Prisma.Decimal, parts: number): Prisma.Decimal[] {
  if (parts <= 1) return [round2(total)];

  const each = round2(div(total, parts));
  const shares = Array.from({ length: parts }, () => each);
  // Whatever rounding lost or gained, settled on the first share.
  shares[0] = round2(sub(total, mul(each, parts - 1)));
  return shares;
}

/**
 * WHAT EACH PERSON EARNS WHEN A SERVICE IS SHARED.
 *
 * Two stylists on one bridal makeup is ordinary, and the salon pays for the
 * service once. So the line's value is divided between them and each earns at
 * their OWN arrangement on their own share — which is not the same as giving
 * both the full rate, and is the difference between a payroll that matches the
 * day's takings and one that quietly runs ahead of it.
 *
 * A flat-per-service rate divides the same way: a ₹150 flat with two performers
 * is ₹75 each, because the flat rate is what the salon pays for the service
 * being done, not what it pays each person who touches it.
 *
 * Order matters. The first entry is the primary performer — the one on
 * invoice_items.staffId that every existing report reads — and takes the
 * rounding remainder.
 */
export function splitCommission<T extends CommissionArrangement>(input: {
  service: CommissionArrangement | null | undefined;
  performers: T[];
  base: Prisma.Decimal | number | string;
  quantity: Prisma.Decimal | number | string;
}): { performer: T; ratePct: Prisma.Decimal; baseAmount: Prisma.Decimal; amount: Prisma.Decimal }[] {
  const count = input.performers.length;
  if (count === 0) return [];

  const bases = shareOut(d(input.base), count);

  const rows = input.performers.map((performer, index) => {
    const terms = commissionTerms(input.service, performer);
    const baseAmount = bases[index]!;
    // Unrounded on purpose — see the reconciliation below.
    const exact = terms.flat.greaterThan(0)
      ? div(mul(terms.flat, input.quantity), count)
      : mul(baseAmount, div(terms.ratePct, 100));

    return { performer, ratePct: terms.ratePct, baseAmount, exact, amount: round2(exact) };
  });

  /**
   * ADDING A NAME MUST NOT CHANGE WHAT THE SALON PAYS.
   *
   * Rounding each share on its own breaks that. ₹1,000 at 10% between three
   * people is ₹33.33 three times — ₹99.99 — so the salon pays a paisa less for
   * the same service because three people did it, and the payroll stops tying
   * out to the commission the arrangement actually promised.
   *
   * One paisa is nothing; an invariant that holds except sometimes is not. The
   * total is rounded ONCE, from the exact sum, and the difference is settled on
   * the primary performer — the same person who takes the remainder on the base.
   * With people on different rates there is no single "unshared total" to
   * reconcile to, and this still does the right thing: the sum of the exact
   * amounts is what each of them is owed added up, rounded the way money is.
   */
  const target = round2(rows.reduce((sum, row) => add(sum, row.exact), d(0)));
  const rounded = rows.reduce((sum, row) => add(sum, row.amount), d(0));
  const drift = sub(target, rounded);
  if (!drift.isZero() && rows[0]) {
    rows[0].amount = round2(add(rows[0].amount, drift));
  }

  return rows.map(({ performer, ratePct, baseAmount, amount }) => ({ performer, ratePct, baseAmount, amount }));
}
