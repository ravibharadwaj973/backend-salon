import type { CommissionType, Prisma } from '@prisma/client';
import { d, div, mul, round2 } from '../../core/money';

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
