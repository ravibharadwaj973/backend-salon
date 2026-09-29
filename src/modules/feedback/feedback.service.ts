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
import { draftReviewsNow } from './feedback-ai.service';
import {
  type SubmittedServiceRating,
  meanServiceRating,
  selectServiceRatings,
} from './service-ratings';

export interface FeedbackInput {
  appointmentId?: string;
  /**
   * The bill this rating is about, when there was no appointment.
   *
   * A walk-in has one and not the other. Exactly one of these is ever set:
   * the public page resolves which from the id in the link, so nothing
   * downstream has to guess.
   */
  invoiceId?: string;
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
  /**
   * Where this rating came in from. Absent means VISIT, the schema default —
   * a rating reached through the salon's own message about a specific visit.
   *
   * QR is the card on the counter: a real visit with no appointment and no
   * bill attached, where the customer picked their own services off the menu.
   */
  source?: 'VISIT' | 'WEBSITE' | 'QR';
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

  /**
   * THE SAME FACTS, OFF THE BILL.
   *
   * A walk-in's rating has to know its branch, its customer and which
   * services may be rated, exactly as a booked visit does — and the invoice
   * carries all three. Without this the rating would be refused for want of a
   * branch, which is the failure this whole change exists to remove.
   */
  if (input.invoiceId) {
    const invoice = await runUnscoped(() =>
      prisma.invoice.findUnique({
        where: { id: input.invoiceId },
        include: { items: { where: { itemType: 'SERVICE' }, select: { refId: true, staffId: true } } },
      }),
    );
    if (!invoice || invoice.tenantId !== tenantId) throw NotFound('Invoice');

    const existingForInvoice = await runUnscoped(() =>
      prisma.feedback.findUnique({ where: { invoiceId: input.invoiceId } }),
    );
    if (existingForInvoice) throw BadRequest('Feedback has already been submitted for this visit');

    branchId = invoice.branchId;
    customerId = customerId ?? invoice.customerId ?? undefined;
    staffId = staffId ?? invoice.items.find((item) => item.staffId)?.staffId ?? undefined;
    onAppointment = invoice.items
      .map((item) => item.refId)
      .filter((refId): refId is string => Boolean(refId));
  }

  /**
   * A QR RATING HAS NO VISIT TO CHECK AGAINST, SO THE MENU IS THE CHECK.
   *
   * With an appointment or a bill, `onAppointment` is the short list of what
   * that customer actually had, and anything else submitted is dropped. From
   * the counter card there is no such list — the customer ticks what they had.
   *
   * So the allow-list widens to the salon's own active services, which is the
   * most this can be narrowed to and still work. It still refuses a serviceId
   * from another salon, or one that has been retired, which is what stops the
   * open form being a way to write rows against arbitrary ids.
   *
   * What it cannot do is verify that the person actually had the service they
   * ticked. That is why these are stored as QR rather than VISIT, and why the
   * per-service performance table keeps ignoring them.
   */
  if (!input.appointmentId && !input.invoiceId && branchId) {
    const catalogue = await runUnscoped(() =>
      prisma.service.findMany({ where: { tenantId, isActive: true }, select: { id: true } }),
    );
    onAppointment = catalogue.map((service) => service.id);
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
        invoiceId: input.invoiceId ?? null,
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
        ...(input.source ? { source: input.source } : {}),
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
   *
   * ── What it is built from, and why that changed ──────────────────────────
   *
   * Their comment when they wrote one, and otherwise the stars they gave: each
   * service by name, the wait, the person who served them. Most customers type
   * nothing at all — the box is optional and it is the last thing on the page
   * — so a draft that required words was a feature that almost never ran. From
   * the salon's side it looked broken, and from the customer's side the one
   * screen where they might post a review was a blank Google box again.
   *
   * ── Offered to everybody, complaint or not ───────────────────────────────
   *
   * This used to stop at `!isComplaint`. But the Google link itself is offered
   * to everyone, because deciding who is invited to review by how they rated
   * is the gating Google prohibits — and handing only the happy ones help
   * composing is that same filter one step further down the page. The draft
   * carries their criticism instead: a two against the wait comes out as a
   * sentence about waiting. See the rule in feedback-ai.ts.
   */
  /**
   * THE RATING IS SAVED BY HERE. NOTHING AFTER THIS POINT MAY RISK IT.
   *
   * The suggestions used to be written on this request: submit, then wait up
   * to eight seconds while a model composed five reviews, THEN answer. Which
   * meant the customer's rating — the thing the salon actually needs, the
   * thing that cannot be asked for twice — was sitting behind a third party's
   * latency on a serverless function with a hard ceiling. When that ceiling
   * was hit the function died, the browser got an empty body, and the page
   * said "Something went wrong" about a rating that had in fact been stored.
   *
   * Worse than a bad error message: a customer told it failed tries again,
   * finds the link already used, and concludes the salon's app is broken.
   *
   * So the request answers as soon as the rating is written, and the page
   * fetches its suggestions separately. If that second call is slow, or times
   * out, or the model is down, the customer sees the Google link without a
   * draft — which is what they saw before any of this existed, and nothing is
   * lost that mattered.
   */

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
     * What they told us, in sentences, for them to edit and post if they want.
     *
     * Null whenever there is nothing honest to build it from: no key, a model
     * that did not answer in time, or an overall rating with nothing specific
     * behind it — no comment and not one service, wait or staff member scored.
     * That last case is the line this feature lives on: a review has to come
     * from something the customer actually pointed at, or it is the salon
     * talking about itself in the customer's voice.
     */
    /**
     * The list the customer chooses from.
     *
     * One draft is a sentence to accept or reject, and most people reject it —
     * it is somebody else's words about their own afternoon. Five is a choice,
     * and picking one makes it theirs. That editorial judgement belongs to the
     * customer rather than the model, which is also what keeps this the right
     * side of writing reviews on their behalf.
     */
    reviewDrafts: [] as string[],
  };
}

/**
 * The services to hand the draft, by name, with the customer's stars.
 *
 * Names are looked up here rather than carried down from the appointment
 * because the two paths into this function reach them differently — a booked
 * visit has AppointmentService rows, a walk-in has invoice lines — and the
 * draft only needs "Haircut, four stars".
 *
 * A service on the visit that the customer did not score is still named, with
 * a null, because it is context for the words they wrote. The prompt is told
 * that a null was not asked about and must go unmentioned, so an unrated
 * service can never turn into a sentence of invented praise.
 */
async function draftableServices(
  rated: SubmittedServiceRating[],
  onVisit: string[],
): Promise<{ name: string; rating?: number | null }[]> {
  const ids = Array.from(new Set([...rated.map((row) => row.serviceId), ...onVisit]));
  if (ids.length === 0) return [];

  const services = await runUnscoped(() =>
    prisma.service.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ).catch(() => []);

  const nameOf = new Map(services.map((service) => [service.id, service.name]));
  const ratingOf = new Map(rated.map((row) => [row.serviceId, row.rating]));

  return ids
    .map((id) => ({ name: nameOf.get(id), rating: ratingOf.get(id) ?? null }))
    .filter((row): row is { name: string; rating: number | null } => Boolean(row.name))
    /**
     * Rated first, and otherwise left in the order they came.
     *
     * Deliberately NOT sorted by score. Putting the fives at the top and the
     * twos at the bottom of a prompt nudges a model to lead with the praise
     * and trail off before the complaint, which is the one outcome this
     * feature must not quietly produce.
     */
    .sort((a, b) => (a.rating === null ? 1 : 0) - (b.rating === null ? 1 : 0));
}

/**
 * The salon's own Google review link, set by the owner per branch (each shop
 * has its own listing, and a review on the wrong one is wasted). Falls back to
 * a tenant-wide link for a single-branch salon that set it once.
 */
/**
 * Write the suggestions for a rating that has already been stored.
 *
 * Called by the thank-you screen on its own request, so nothing here can cost
 * the customer their rating — by the time this runs, that is safe on disk.
 *
 * Idempotent in the way that matters: once a draft has been stored, a second
 * call reads it back rather than paying a model to write five more. Somebody
 * refreshing the page should see the same suggestions, not a new set.
 */
export async function reviewSuggestions(
  feedbackId: string,
): Promise<{ reviewDrafts: string[] }> {
  const feedback = await runUnscoped(() =>
    prisma.feedback.findUnique({
      where: { id: feedbackId },
      include: { serviceRatings: { include: { service: { select: { name: true } } } } },
    }),
  );
  if (!feedback) throw NotFound('Feedback');

  if (!aiReady) return { reviewDrafts: [] };

  const drafts = await draftReviewsNow({
    overallRating: feedback.rating,
    staffRating: feedback.staffRating,
    cleanlinessRating: feedback.ambienceRating,
    waitingRating: feedback.waitRating,
    comment: feedback.comment,
    services: feedback.serviceRatings.map((row) => ({
      name: row.service.name,
      rating: row.rating,
    })),
  }).catch(() => [] as string[]);

  /**
   * The first one is kept on the row, which is all the salon's own feedback
   * list has room to show. Stored rather than regenerated so the salon sees
   * the same sentence the customer was offered.
   */
  if (drafts[0] && !feedback.reviewDraft) {
    await runUnscoped(() =>
      prisma.feedback.update({ where: { id: feedback.id }, data: { reviewDraft: drafts[0] } }),
    ).catch(() => undefined);
  }

  return { reviewDrafts: drafts };
}

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
/**
 * The hand-off to Google, for either kind of visit.
 *
 * Takes the same id the feedback page does — an appointment for a booked
 * visit, an invoice for a walk-in. It had to move with the page: a link that
 * opens a walk-in's feedback form and then cannot record their tap through to
 * Google would lose exactly the measurement the routing exists for.
 */
export async function recordGoogleReviewClick(
  id: string,
): Promise<{ recorded: boolean; googleReviewUrl: string | null }> {
  /**
   * Three kinds of id, because there are three ways in.
   *
   * An appointment link and a bill link identify a visit, and the feedback
   * hangs off it. A QR rating has neither — there is no visit row to look up
   * — so the page hands back the feedback's OWN id and it is looked up
   * directly. All three are cuids from different tables; a collision is not a
   * thing that happens, and a wrong guess simply finds nothing.
   */
  const [appointment, invoice, direct] = await runUnscoped(() =>
    Promise.all([
      prisma.appointment.findUnique({ where: { id }, select: { tenantId: true, branchId: true } }),
      prisma.invoice.findUnique({ where: { id }, select: { tenantId: true, branchId: true } }),
      prisma.feedback.findUnique({ where: { id } }),
    ]),
  );

  const visit = appointment ?? invoice ?? direct;
  if (!visit) throw NotFound('Visit');

  const feedback = direct
    ? direct
    : await runUnscoped(() =>
        prisma.feedback.findUnique(
          appointment ? { where: { appointmentId: id } } : { where: { invoiceId: id } },
        ),
      );
  if (feedback && feedback.rating <= 3) return { recorded: false, googleReviewUrl: null };

  if (feedback && !feedback.googleReviewedAt) {
    await runUnscoped(() =>
      prisma.feedback.update({ where: { id: feedback.id }, data: { googleReviewedAt: new Date() } }),
    );
  }

  return {
    recorded: Boolean(feedback),
    googleReviewUrl: await googleReviewUrlFor(visit.tenantId, visit.branchId),
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

/**
 * THE PAGE BEHIND A FEEDBACK LINK, FOR EITHER KIND OF VISIT.
 *
 * The id in the URL is an APPOINTMENT id or an INVOICE id. One route rather
 * than two, because a customer's link should not have to advertise which kind
 * of salon billed them, and every template already carrying {{feedback_link}}
 * keeps working untouched.
 *
 * Appointments are tried first: a booked visit that was later billed has both,
 * and the appointment is the richer record — it knows who was rostered on it.
 */
export async function publicFeedbackContext(id: string) {
  const context = (await appointmentContext(id)) ?? (await invoiceContext(id));
  if (!context) throw NotFound('Visit');
  return context;
}

/**
 * THE CARD ON THE COUNTER.
 *
 * The third way in, and the only one that knows nothing about the customer.
 * An appointment link knows the visit; a bill link knows the visit; a QR code
 * printed and stuck by the till knows only which branch it was printed for.
 *
 * ── Why it is worth having anyway ─────────────────────────────────────────
 *
 * The other two routes require the salon to have the customer's number and to
 * have sent them something. Plenty of people pay cash, give no number, and
 * walk out — and they are exactly as capable of leaving a Google review as
 * anybody else. This is the only route that reaches them, and it works while
 * they are still standing in the salon, which is when they are most likely to.
 *
 * ── What it gives up ──────────────────────────────────────────────────────
 *
 * Everything the other two knew: who they are, what they had, when. So the
 * page has to ask for the services, and the answer is the customer's word
 * rather than the salon's record. Stored as QR for that reason — see the
 * enum comment in the schema.
 *
 * `alreadySubmitted` is always false. There is no visit to have answered for,
 * so nothing to check against; the page keeps its own per-device note instead,
 * and the rate limiter on the public router is what stops a flood.
 */
export async function qrFeedbackContext(branchId: string) {
  const branch = await runUnscoped(() =>
    prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        name: true,
        isActive: true,
        tenantId: true,
        tenant: { select: { name: true, logoUrl: true } },
      },
    }),
  );

  if (!branch || !branch.isActive) throw NotFound('Salon');

  /**
   * The menu as the customer would read it, not the whole catalogue.
   *
   * `onlineBookable` is the salon's own answer to "should a customer see this
   * without us in the room" — the same judgement the booking page relies on —
   * so a staff-only or internal line does not appear on a card by the till.
   */
  const services = await runUnscoped(() =>
    prisma.service.findMany({
      where: { tenantId: branch.tenantId, isActive: true, onlineBookable: true },
      select: { id: true, name: true, category: { select: { name: true, sortOrder: true } } },
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      take: 200,
    }),
  );

  return {
    tenantId: branch.tenantId,
    branchId: branch.id,
    salonName: branch.tenant.name,
    logoUrl: branch.tenant.logoUrl,
    branchName: branch.name,
    /** Nobody knows who they are, and the page should not pretend otherwise. */
    customerName: 'there',
    visitDate: null,
    alreadySubmitted: false,
    /** Chosen by the customer, so the page must show the whole menu. */
    pickServices: true,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      category: service.category?.name ?? null,
    })),
  };
}

/**
 * A WALK-IN'S VISIT, READ OFF THEIR BILL.
 *
 * Same shape as the appointment version, so neither the page nor the submit
 * path can tell them apart. The services come from the bill's own SERVICE
 * lines — exactly what the customer had, because it is what they paid for —
 * and each keeps its service id, so the per-service star rows work for a
 * walk-in the same as for a booked visit.
 */
async function invoiceContext(invoiceId: string) {
  const invoice = await runUnscoped(() =>
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        tenant: { select: { name: true, logoUrl: true } },
        branch: { select: { name: true } },
        customer: { select: { firstName: true } },
        items: {
          where: { itemType: 'SERVICE' },
          select: { refId: true, name: true, staff: { select: { displayName: true } } },
        },
        feedback: { select: { id: true } },
      },
    }),
  );

  if (!invoice) return null;

  return {
    salonName: invoice.tenant.name,
    logoUrl: invoice.tenant.logoUrl,
    branchName: invoice.branch.name,
    customerName: invoice.customer?.firstName ?? 'there',
    visitDate: invoice.invoiceDate,
    /**
     * Only lines still pointing at a service the salon has. A line whose
     * service was deleted keeps its name on the bill — that is the bill's job
     * — but it cannot be rated, because there is nothing to attach a rating to.
     */
    services: invoice.items
      .filter((item): item is typeof item & { refId: string } => Boolean(item.refId))
      .map((item) => ({ id: item.refId, name: item.name })),
    staffName: invoice.items.find((item) => item.staff)?.staff?.displayName ?? null,
    alreadySubmitted: Boolean(invoice.feedback),
    tenantId: invoice.tenantId,
    branchId: invoice.branchId,
    googleReviewUrl: await googleReviewUrlFor(invoice.tenantId, invoice.branchId),
    /** Which key this page is about, so the submit knows what to write. */
    invoiceId: invoice.id as string | null,
    appointmentId: null as string | null,
  };
}

async function appointmentContext(appointmentId: string) {
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
  if (!appointment) return null;

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
    invoiceId: null as string | null,
    appointmentId: appointment.id as string | null,
  };
}
