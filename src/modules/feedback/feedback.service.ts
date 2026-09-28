import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { branchFilter } from '../../core/scope';
import { BadRequest, NotFound } from '../../core/errors';
import { possibleAuthors } from './website-feedback.service';
import { pageParams } from '../../core/http';
import { pctOf, round2 } from '../../core/money';
import { enqueueSafe } from '../../jobs/queue';
import { aiReady } from '../../config/env';
import { draftReviewNow } from './feedback-ai.service';
import {
  type SubmittedServiceRating,
  meanServiceRating,
  selectServiceRatings,
} from './service-ratings';

export interface FeedbackInput {
  appointmentId?: string;
  customerId?: string;
  staffId?: string;
  branchId?: string;
  rating: number;
  serviceRating?: number;
  ambienceRating?: number;
  staffRating?: number;
  waitRating?: number;
  npsScore?: number;
  comment?: string;
  /**
   * One rating per service on the visit. Checked against the appointment's own
   * services before anything is stored — see service-ratings.ts.
   */
  services?: SubmittedServiceRating[];
}

/**
 * Records a rating, and offers EVERY customer the Google link.
 *
 * ── Why this no longer depends on the rating ──────────────────────────────
 *
 * It used to: 4–5 stars were handed the Google link, 1–3 stars were not. That
 * is called review gating, and Google prohibits it in as many words — a
 * merchant must not "discourage or prohibit negative reviews, or selectively
 * solicit positive reviews from customers". In April 2026 they named the
 * practice directly and put automated detection behind it.
 *
 * The penalty is not a warning. It is reviews stripped and the profile
 * restricted, which destroys the asset the whole feature exists to grow. A
 * salon with a 4.9 built by gating has a 4.9 that can be deleted.
 *
 * ── What did NOT change ───────────────────────────────────────────────────
 *
 * The low-rating alert, the complaint flag, and the apology journey all still
 * fire. Catching a bad visit early and putting a person on it is legitimate
 * and is most of what this form is for. The only thing that stopped is
 * withholding the public link from the people most likely to use it.
 *
 * Asking everyone honestly also reads as real. A page of nothing but five
 * stars is something customers have learned to distrust.
 */
export async function submitFeedback(input: FeedbackInput, tenantIdOverride?: string) {
  const tenantId = tenantIdOverride ?? requireTenantId();

  let branchId = input.branchId;
  let customerId = input.customerId;
  let staffId = input.staffId;
  /** The services actually on this visit — the only ones that may be rated. */
  let onAppointment: string[] = [];

  if (input.appointmentId) {
    const appointment = await runUnscoped(() =>
      prisma.appointment.findUnique({
        where: { id: input.appointmentId },
        include: { services: { select: { staffId: true, serviceId: true } } },
      }),
    );
    if (!appointment || appointment.tenantId !== tenantId) throw NotFound('Appointment');

    branchId = appointment.branchId;
    customerId = customerId ?? appointment.customerId ?? undefined;
    staffId = staffId ?? appointment.services.find((s) => s.staffId)?.staffId ?? undefined;
    onAppointment = appointment.services.map((s) => s.serviceId);

    const existing = await runUnscoped(() =>
      prisma.feedback.findUnique({ where: { appointmentId: input.appointmentId } }),
    );
    if (existing) throw BadRequest('Feedback has already been submitted for this visit');
  }

  if (!branchId) throw BadRequest('A branch is required');
  if (input.rating < 1 || input.rating > 5) throw BadRequest('Rating must be between 1 and 5');

  const isComplaint = input.rating <= 3;

  /**
   * Only the services this visit actually had.
   *
   * The public feedback page is unauthenticated — anybody holding the link can
   * post to it — so an unchecked serviceId would let anyone put a 1 against
   * any service in the catalogue, and the service-performance table would stop
   * being evidence of anything.
   */
  const serviceRatings = selectServiceRatings(input.services, onAppointment);

  const feedback = await runUnscoped(() =>
    prisma.feedback.create({
      data: {
        tenantId,
        branchId,
        appointmentId: input.appointmentId ?? null,
        customerId: customerId ?? null,
        staffId: staffId ?? null,
        rating: input.rating,
        /**
         * The old single column, still filled — from the per-service rows when
         * they are there. Every average, report and staff score written before
         * feedback_service_ratings existed reads this, and a change that
         * silently empties it would flatten a salon's history to nothing.
         */
        serviceRating: input.serviceRating ?? meanServiceRating(serviceRatings),
        ambienceRating: input.ambienceRating ?? null,
        staffRating: input.staffRating ?? null,
        waitRating: input.waitRating ?? null,
        npsScore: input.npsScore ?? null,
        comment: input.comment ?? null,
        isComplaint,
        // Everyone is asked now, so this is true for everyone. It stays as a
        // column rather than becoming a constant because it is the honest
        // record of what the salon did, and a future policy may narrow it.
        googleReviewRequested: true,
      },
    }),
  );

  if (serviceRatings.length > 0) {
    await runUnscoped(() =>
      prisma.feedbackServiceRating.createMany({
        data: serviceRatings.map((row) => ({
          tenantId,
          feedbackId: feedback.id,
          serviceId: row.serviceId,
          rating: row.rating,
          comment: row.comment ?? null,
        })),
      }),
    );
  }

  if (staffId) await refreshStaffRating(staffId);

  /**
   * Read the comment, in the background, if there is a key for it.
   *
   * Enqueued rather than awaited: the customer is looking at a spinner, and
   * whether a model answers in 200ms or times out at twenty seconds is not
   * their problem. Guarded by aiReady so a salon with no key does not build a
   * queue of work that can only fail — retries of an impossible job are how
   * the reminders behind it get delayed.
   */
  if (aiReady && feedback.comment?.trim()) {
    enqueueSafe('feedback.analyze', { feedbackId: feedback.id, tenantId });
  }

  if (isComplaint) {
    await runUnscoped(() =>
      prisma.businessAlert.create({
        data: {
          tenantId,
          branchId,
          type: 'LOW_RATING',
          title: `${input.rating}-star rating received`,
          body: input.comment ?? 'A customer left a low rating. Follow up with them today.',
          severity: input.rating <= 2 ? 'CRITICAL' : 'WARNING',
          data: { feedbackId: feedback.id, customerId } as Prisma.InputJsonValue,
          forDate: new Date(new Date().toISOString().slice(0, 10)),
        },
      }),
    ).catch(() => undefined);
  }

  // Award loyalty points for taking the time to review.
  if (customerId) {
    // Two different journeys, because the two cases want opposite things: a
    // happy customer gets pointed at Google, an unhappy one gets a person.
    enqueueSafe('journey.trigger', {
      trigger: isComplaint ? 'FEEDBACK_NEGATIVE' : 'FEEDBACK_POSITIVE',
      customerId,
      tenantId,
    });
    enqueueSafe('journey.trigger', { trigger: 'REVIEW_REQUEST', customerId, tenantId });
    const program = await runUnscoped(() => prisma.loyaltyProgram.findFirst({ where: { tenantId, isActive: true } }));
    if (program && program.reviewPoints > 0) {
      await runUnscoped(async () => {
        const customer = await prisma.customer.findUnique({ where: { id: customerId! } });
        if (!customer) return;
        const balance = customer.loyaltyPoints + program.reviewPoints;
        await prisma.customer.update({ where: { id: customerId! }, data: { loyaltyPoints: balance } });
        await prisma.loyaltyTransaction.create({
          data: {
            tenantId,
            customerId: customerId!,
            type: 'BONUS',
            points: program.reviewPoints,
            balanceAfter: balance,
            reason: 'Feedback submitted',
          },
        });
      });
    }
  }

  /**
   * Drafted now rather than in the analysis job, because the one moment
   * somebody might post a review is the thirty seconds after they press send.
   * Awaited, but on a short leash: a slow model shows the link without a
   * draft rather than holding the thank-you screen.
   */
  const reviewDraft =
    aiReady && !isComplaint && input.comment?.trim()
      ? await draftReviewNow({
          overallRating: input.rating,
          staffRating: input.staffRating ?? null,
          cleanlinessRating: input.ambienceRating ?? null,
          waitingRating: input.waitRating ?? null,
          comment: input.comment,
          /**
           * Empty on purpose. draftPrompt never reads the services or the
           * ratings — it is handed the comment and nothing else, so that what
           * comes back can only be a rearrangement of what the customer
           * actually wrote. Passing them would imply otherwise.
           */
          services: [],
        }).catch(() => null)
      : null;

  if (reviewDraft) {
    await runUnscoped(() =>
      prisma.feedback.update({ where: { id: feedback.id }, data: { reviewDraft } }),
    ).catch(() => undefined);
  }

  return {
    feedback,
    /**
     * What the page says next — NOT who gets the link.
     *
     * A complaint still gets an apology and the promise of a person, because
     * that is the right thing to say to someone who had a bad afternoon. It
     * just no longer decides whether they are allowed to review the salon.
     */
    nextStep: isComplaint ? ('APOLOGY' as const) : ('GOOGLE_REVIEW' as const),
    /** Offered whatever they rated. See the note on this function. */
    googleReviewUrl: await googleReviewUrlFor(tenantId, branchId),
    /**
     * Their own words, tidied, for them to edit and post if they want to.
     *
     * Null whenever there is nothing honest to build it from: no comment, no
     * key, or a model that did not answer in time. Never assembled from the
     * rating and the service list — that would be the salon's words in the
     * customer's mouth, which is the thing Google's policy is written against
     * and the thing this feature must not become.
     */
    reviewDraft,
  };
}

/**
 * The salon's own Google review link, set by the owner per branch (each shop
 * has its own listing, and a review on the wrong one is wasted). Falls back to
 * a tenant-wide link for a single-branch salon that set it once.
 */
export async function googleReviewUrlFor(tenantId: string, branchId: string | null): Promise<string | null> {
  if (branchId) {
    const branch = await runUnscoped(() =>
      prisma.branch.findUnique({ where: { id: branchId }, select: { googleReviewUrl: true } }),
    );
    if (branch?.googleReviewUrl) return branch.googleReviewUrl;
  }
  const tenant = await runUnscoped(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }));
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const url = settings.googleReviewUrl;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * The customer actually tapped through to Google. Recorded separately from
 * "we asked", because the gap between the two is the number worth watching.
 *
 * This is also the last gate. The link in a message can be forwarded, opened
 * late, or reached by someone who has since complained, so the rating is
 * re-checked here: a customer who rated 1–3 is never sent to Google, whatever
 * link they are holding.
 */
export async function recordGoogleReviewClick(
  appointmentId: string,
): Promise<{ recorded: boolean; googleReviewUrl: string | null }> {
  const appointment = await runUnscoped(() =>
    prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, tenantId: true, branchId: true },
    }),
  );
  if (!appointment) throw NotFound('Appointment');

  const feedback = await runUnscoped(() => prisma.feedback.findUnique({ where: { appointmentId } }));
  if (feedback && feedback.rating <= 3) return { recorded: false, googleReviewUrl: null };

  if (feedback && !feedback.googleReviewedAt) {
    await runUnscoped(() =>
      prisma.feedback.update({ where: { id: feedback.id }, data: { googleReviewedAt: new Date() } }),
    );
  }

  return {
    recorded: Boolean(feedback),
    googleReviewUrl: await googleReviewUrlFor(appointment.tenantId, appointment.branchId),
  };
}

async function refreshStaffRating(staffId: string) {
  const agg = await runUnscoped(() =>
    prisma.feedback.aggregate({ where: { staffId }, _avg: { rating: true }, _count: { _all: true } }),
  );
  await runUnscoped(() =>
    prisma.staff.update({
      where: { id: staffId },
      data: { avgRating: round2(agg._avg.rating ?? 0), ratingCount: agg._count._all },
    }),
  );
}

export async function listFeedback(input: {
  page?: number;
  pageSize?: number;
  branchId?: string;
  staffId?: string;
  minRating?: number;
  maxRating?: number;
  complaintsOnly?: boolean;
  unresolvedOnly?: boolean;
  /** 'VISIT', 'WEBSITE', or undefined for both. */
  source?: 'VISIT' | 'WEBSITE';
  from?: Date;
  to?: Date;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.FeedbackWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.complaintsOnly ? { isComplaint: true } : {}),
    ...(input.unresolvedOnly ? { isComplaint: true, resolvedAt: null } : {}),
    ...(input.minRating || input.maxRating
      ? {
          rating: {
            ...(input.minRating ? { gte: input.minRating } : {}),
            ...(input.maxRating ? { lte: input.maxRating } : {}),
          },
        }
      : {}),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        staff: { select: { id: true, displayName: true } },
        appointment: { select: { id: true, startAt: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  /**
   * For website feedback, who this MIGHT be — worked out now rather than
   * stored on the row. A stored link would be the app asserting that an
   * unverified phone number identifies a named customer; this is the salon
   * being shown a possible match and left to decide.
   */
  const matches = await possibleAuthors(items.filter((i) => i.source === 'WEBSITE').map((i) => i.id));

  return {
    items: items.map((item) => ({ ...item, possibleCustomer: matches.get(item.id) ?? null })),
    total,
    page,
    pageSize,
  };
}

export async function resolveComplaint(id: string, note: string) {
  const feedback = await prisma.feedback.findUnique({ where: { id } });
  if (!feedback) throw NotFound('Feedback');
  return prisma.feedback.update({
    where: { id },
    data: { resolvedAt: new Date(), resolutionNote: note },
  });
}

/** Reputation snapshot: average rating, distribution, NPS and staff ranking. */
export async function reputationSummary(input: { from?: Date; to?: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const period = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  } satisfies Prisma.FeedbackWhereInput;

  /**
   * THE SALON'S OWN RATING IS BUILT FROM VISITS ONLY.
   *
   * Feedback left on the salon's public website is unverified: anyone with
   * the address can leave it, including twice, including a competitor. Folded
   * into this average it would make the number the salon judges itself by
   * — and prices, and pays bonuses on — something a stranger can move.
   *
   * It is not hidden, it is counted separately and reported below, so the
   * screen can say "plus 12 from your website" rather than leaving somebody
   * to wonder why two counts disagree.
   */
  const where: Prisma.FeedbackWhereInput = { ...period, source: 'VISIT' };

  const [agg, distribution, npsRows, staffRatings, unresolved, fromWebsite] = await Promise.all([
    prisma.feedback.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    prisma.feedback.groupBy({ by: ['rating'], where, _count: { _all: true } }),
    prisma.feedback.findMany({ where: { ...where, npsScore: { not: null } }, select: { npsScore: true } }),
    prisma.feedback.groupBy({
      by: ['staffId'],
      where: { ...where, staffId: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.feedback.count({ where: { ...where, isComplaint: true, resolvedAt: null } }),
    prisma.feedback.aggregate({
      where: { ...period, source: 'WEBSITE' },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  // The Google funnel: how many were asked, how many actually went. And
  // whether there is anywhere to send them at all — a salon can run this for
  // months and wonder why nobody reviews, when nobody ever set the link.
  const [googleRequested, googleClicked, branchesWithLink, tenantRecord] = await Promise.all([
    prisma.feedback.count({ where: { ...where, googleReviewRequested: true } }),
    prisma.feedback.count({ where: { ...where, googleReviewedAt: { not: null } } }),
    prisma.branch.count({ where: { tenantId, googleReviewUrl: { not: null } } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
  ]);
  const tenantLink = ((tenantRecord?.settings as Record<string, unknown>) ?? {}).googleReviewUrl;
  const googleLinkConfigured = branchesWithLink > 0 || (typeof tenantLink === 'string' && tenantLink.length > 0);

  const promoters = npsRows.filter((r) => (r.npsScore ?? 0) >= 9).length;
  const detractors = npsRows.filter((r) => (r.npsScore ?? 0) <= 6).length;
  const nps = npsRows.length ? Math.round(((promoters - detractors) / npsRows.length) * 100) : null;

  const staff = await prisma.staff.findMany({
    where: { id: { in: staffRatings.map((s) => s.staffId!).filter(Boolean) } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(staff.map((s) => [s.id, s.displayName]));

  return {
    averageRating: round2(agg._avg.rating ?? 0),
    totalReviews: agg._count._all,
    /**
     * Alongside, never inside. See the note on `where` above.
     */
    website: {
      count: fromWebsite._count._all,
      averageRating: fromWebsite._count._all > 0 ? round2(fromWebsite._avg.rating ?? 0) : null,
    },
    distribution: Object.fromEntries(distribution.map((d) => [d.rating, d._count._all])),
    positiveRatePct: pctOf(
      distribution.filter((d) => d.rating >= 4).reduce((acc, d) => acc + d._count._all, 0),
      agg._count._all || 1,
    ),
    nps,
    unresolvedComplaints: unresolved,
    positive: distribution.filter((d) => d.rating >= 4).reduce((acc, d) => acc + d._count._all, 0),
    neutral: distribution.filter((d) => d.rating === 3).reduce((acc, d) => acc + d._count._all, 0),
    negative: distribution.filter((d) => d.rating <= 2).reduce((acc, d) => acc + d._count._all, 0),
    googleRequested,
    googleClicked,
    googleLinkConfigured,
    byStaff: staffRatings
      .map((s) => ({
        staffId: s.staffId,
        name: nameById.get(s.staffId!) ?? 'Unknown',
        averageRating: round2(s._avg.rating ?? 0),
        reviews: s._count._all,
      }))
      .sort((a, b) => Number(b.averageRating) - Number(a.averageRating)),
  };
}

/** Public feedback form data — no auth, resolved from the appointment id. */
/**
 * HOW EACH SERVICE IS ACTUALLY RATED.
 *
 * The one question an owner acts on. An overall 4.6 tells them nothing they
 * can do anything about; "the facial is 3.9 across 40 responses and everything
 * else is above 4.6" tells them who to talk to and what to watch on Saturday.
 *
 * VISIT feedback only, for the same reason the headline average is: a rating
 * left on the public website is unverified, and a competitor should not be
 * able to move the number a salon decides its staffing by.
 *
 * Ordered worst first, because a list of a salon's best services is a nice
 * feeling and a list of its worst is a to-do. Services nobody has rated are
 * left out entirely rather than shown as zero — an unrated service is not a
 * bad one, and a 0.0 in this table would read as a catastrophe.
 */
export async function servicePerformance(input: { from?: Date; to?: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const rows = await prisma.feedbackServiceRating.findMany({
    where: {
      tenantId,
      feedback: {
        tenantId,
        source: 'VISIT',
        ...branchFilter(input.branchId),
        ...(input.from || input.to
          ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
          : {}),
      },
    },
    select: { serviceId: true, rating: true, service: { select: { name: true } } },
  });

  const byService = new Map<string, { name: string; total: number; responses: number }>();
  for (const row of rows) {
    const entry = byService.get(row.serviceId) ?? { name: row.service.name, total: 0, responses: 0 };
    entry.total += row.rating;
    entry.responses += 1;
    byService.set(row.serviceId, entry);
  }

  return [...byService.entries()]
    .map(([serviceId, entry]) => ({
      serviceId,
      name: entry.name,
      /**
       * A plain number, not the Decimal round2 gives. That helper is for money,
       * where a rounding error is a rupee somebody is owed; a star average is
       * displayed to one or two places and then charted, and a Decimal arrives
       * at the browser as a string that every chart has to parse back.
       */
      average: Math.round((entry.total / entry.responses) * 100) / 100,
      responses: entry.responses,
      /**
       * Said out loud rather than left to the reader.
       *
       * "Facial 3.0" from two responses and "Facial 3.0" from ninety are
       * different facts, and a table that prints them identically invites a
       * salon to move a stylist off a service because two people had a bad
       * Tuesday. The screen can grey out or caveat a thin row; it cannot do
       * that if the count is not here.
       */
      thin: entry.responses < 10,
    }))
    .sort((a, b) => a.average - b.average || b.responses - a.responses);
}

export async function publicFeedbackContext(appointmentId: string) {
  const appointment = await runUnscoped(() =>
    prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        tenant: { select: { name: true, logoUrl: true } },
        branch: { select: { name: true } },
        customer: { select: { firstName: true } },
        services: { include: { service: { select: { id: true, name: true } }, staff: { select: { displayName: true } } } },
        feedback: { select: { id: true } },
      },
    }),
  );
  if (!appointment) throw NotFound('Appointment');

  return {
    salonName: appointment.tenant.name,
    logoUrl: appointment.tenant.logoUrl,
    branchName: appointment.branch.name,
    customerName: appointment.customer?.firstName ?? 'there',
    visitDate: appointment.startAt,
    /**
     * Id AND name, because the form now asks about each service by itself and
     * has to say which one it is answering about. The customer is never asked
     * to pick their services from a list: the appointment already knows.
     */
    services: appointment.services.map((s) => ({ id: s.service.id, name: s.service.name })),
    staffName: appointment.services.find((s) => s.staff)?.staff?.displayName ?? null,
    alreadySubmitted: Boolean(appointment.feedback),
    tenantId: appointment.tenantId,
    branchId: appointment.branchId,
    googleReviewUrl: await googleReviewUrlFor(appointment.tenantId, appointment.branchId),
  };
}
