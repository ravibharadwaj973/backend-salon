import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { DEFAULT_TZ } from '../../core/dates';

/**
 * WHAT THE ASSISTANT MAY KNOW ABOUT THE PERSON IT IS TALKING TO.
 *
 * It knew the salon and nothing about the customer. So "what time is my
 * appointment", "did I miss my last one", "do I have any offers" — the questions
 * a customer is most likely to ask a salon's WhatsApp number — all landed on a
 * model with no facts, and the prompt correctly made it say it would check. The
 * app knew every answer.
 *
 * ── Whose data this is ────────────────────────────────────────────────────
 *
 * Theirs. The conversation is matched to a customer by the phone number
 * WhatsApp verified as the sender's, and the assistant already refuses to
 * answer a number with no customer record at all. So this reads one person's own
 * bookings back to them, which is what any receptionist would do.
 *
 * It is also the reason nothing here is fetched by name, area or any other loose
 * match: a wrong match would read somebody else's appointments aloud. The only
 * key used is the customerId the conversation was resolved to.
 *
 * ── Formatted here, not by the model ─────────────────────────────────────
 *
 * Dates and times arrive already written out, in the salon's timezone. A model
 * handed an ISO timestamp and asked to say it in words will eventually say the
 * wrong day — and a customer told the wrong day turns up on it. The only date
 * arithmetic that matters is done in code and read out verbatim.
 */

const RECENT_VISITS = 3;
const UPCOMING = 3;
const OFFERS = 3;

export interface CustomerContext {
  firstName: string | null;
  /** Appointments still to come, soonest first. */
  upcoming: { what: string; when: string; where: string; withWhom: string | null }[];
  /**
   * The last few visits, with what became of each.
   *
   * `outcome` is the whole point of including them: "did I miss it" and "was I
   * there" are different questions, and a salon's own record answers both.
   */
  recent: { what: string; when: string; outcome: 'came' | 'did not come' | 'cancelled' }[];
  /** Points, when the salon runs a loyalty scheme. Null when it does not. */
  points: number | null;
  /** Offers this customer could actually use today. */
  offers: { code: string; what: string; until: string; minimumSpend: string | null }[];
}

/** "Tuesday 30 September at 6:00 pm", in the salon's timezone. */
function when(at: Date): string {
  const day = at.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: DEFAULT_TZ,
  });
  const clock = at.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DEFAULT_TZ,
  });
  return `${day} at ${clock}`;
}

function outcomeOf(status: string): 'came' | 'did not come' | 'cancelled' | null {
  if (status === 'COMPLETED') return 'came';
  if (status === 'NO_SHOW') return 'did not come';
  if (status === 'CANCELLED') return 'cancelled';
  // CHECKED_IN and IN_PROGRESS are happening right now and are not history;
  // BOOKED and CONFIRMED in the past are a salon that has not closed them off,
  // and guessing which would be inventing an outcome.
  return null;
}

export async function customerContext(
  tenantId: string,
  customerId: string,
): Promise<CustomerContext> {
  const now = new Date();

  const [customer, upcoming, past, program, coupons] = await runUnscoped(() =>
    Promise.all([
      prisma.customer.findUnique({
        where: { id: customerId },
        select: { firstName: true, loyaltyPoints: true },
      }),

      prisma.appointment.findMany({
        where: {
          tenantId,
          customerId,
          startAt: { gte: now },
          // Only what is actually still on. A cancelled future booking is not an
          // appointment, and reading it out would send somebody to the salon.
          status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN'] },
        },
        orderBy: { startAt: 'asc' },
        take: UPCOMING,
        select: {
          startAt: true,
          branch: { select: { name: true } },
          services: {
            select: { service: { select: { name: true } }, staff: { select: { displayName: true } } },
          },
        },
      }),

      prisma.appointment.findMany({
        where: { tenantId, customerId, startAt: { lt: now } },
        orderBy: { startAt: 'desc' },
        take: RECENT_VISITS,
        select: {
          startAt: true,
          status: true,
          services: { select: { service: { select: { name: true } } } },
        },
      }),

      prisma.loyaltyProgram.findFirst({ where: { tenantId, isActive: true }, select: { id: true } }),

      /**
       * Offers that are live TODAY. A salon's expired campaign codes stay in the
       * table, and reading one out is worse than saying there are none: the
       * customer arrives expecting a discount the till will refuse.
       */
      prisma.coupon.findMany({
        where: {
          tenantId,
          isActive: true,
          validFrom: { lte: now },
          validTo: { gte: now },
        },
        orderBy: { validTo: 'asc' },
        select: {
          id: true,
          code: true,
          description: true,
          discountType: true,
          value: true,
          minBillAmount: true,
          validTo: true,
          usageLimit: true,
          usedCount: true,
          perCustomerLimit: true,
        },
      }),
    ]),
  );

  /**
   * How many times THIS customer has already used each of those codes.
   *
   * One query for all of them rather than one each. Without it the assistant
   * offers a single-use code to somebody who used it last month, and the refusal
   * happens at the counter in front of them.
   */
  const used = await runUnscoped(() =>
    prisma.couponRedemption.groupBy({
      by: ['couponId'],
      where: { tenantId, customerId, couponId: { in: coupons.map((c) => c.id) } },
      _count: { _all: true },
    }),
  ).catch(() => []);

  const usedByCoupon = new Map(used.map((row) => [row.couponId, row._count._all]));

  const offers = coupons
    .filter((coupon) => {
      // Exhausted across the whole salon.
      if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return false;
      // Exhausted by this person.
      return (usedByCoupon.get(coupon.id) ?? 0) < coupon.perCustomerLimit;
    })
    .slice(0, OFFERS)
    .map((coupon) => ({
      code: coupon.code,
      what:
        coupon.description ??
        (coupon.discountType === 'PERCENT'
          ? `${Math.round(Number(coupon.value))}% off`
          : `₹${Math.round(Number(coupon.value))} off`),
      until: when(coupon.validTo).split(' at ')[0]!,
      minimumSpend:
        Number(coupon.minBillAmount) > 0 ? `₹${Math.round(Number(coupon.minBillAmount))}` : null,
    }));

  return {
    firstName: customer?.firstName ?? null,

    upcoming: upcoming.map((row) => ({
      what: row.services.map((s) => s.service.name).join(', ') || 'an appointment',
      when: when(row.startAt),
      where: row.branch?.name ?? '',
      withWhom: row.services.find((s) => s.staff?.displayName)?.staff?.displayName ?? null,
    })),

    recent: past
      .map((row) => {
        const outcome = outcomeOf(row.status);
        if (!outcome) return null;
        return {
          what: row.services.map((s) => s.service.name).join(', ') || 'an appointment',
          when: when(row.startAt),
          outcome,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),

    // Null rather than 0 when the salon runs no scheme: "you have 0 points" from
    // a salon with no loyalty programme is a confusing thing to be told.
    points: program ? (customer?.loyaltyPoints ?? 0) : null,

    offers,
  };
}
