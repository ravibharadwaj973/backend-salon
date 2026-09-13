import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { branchFilter } from '../../core/scope';
import { BadRequest, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { pctOf, round2 } from '../../core/money';
import { enqueueSafe } from '../../jobs/queue';

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
}

/**
 * Records a rating. 4–5 stars are invited to leave a public Google review;
 * 1–3 stars are routed to the owner as a complaint instead — the split that
 * keeps bad experiences off the public page and in front of a human.
 */
export async function submitFeedback(input: FeedbackInput, tenantIdOverride?: string) {
  const tenantId = tenantIdOverride ?? requireTenantId();

  let branchId = input.branchId;
  let customerId = input.customerId;
  let staffId = input.staffId;

  if (input.appointmentId) {
    const appointment = await runUnscoped(() =>
      prisma.appointment.findUnique({
        where: { id: input.appointmentId },
        include: { services: { select: { staffId: true } } },
      }),
    );
    if (!appointment || appointment.tenantId !== tenantId) throw NotFound('Appointment');

    branchId = appointment.branchId;
    customerId = customerId ?? appointment.customerId ?? undefined;
    staffId = staffId ?? appointment.services.find((s) => s.staffId)?.staffId ?? undefined;

    const existing = await runUnscoped(() =>
      prisma.feedback.findUnique({ where: { appointmentId: input.appointmentId } }),
    );
    if (existing) throw BadRequest('Feedback has already been submitted for this visit');
  }

  if (!branchId) throw BadRequest('A branch is required');
  if (input.rating < 1 || input.rating > 5) throw BadRequest('Rating must be between 1 and 5');

  const isComplaint = input.rating <= 3;

  const feedback = await runUnscoped(() =>
    prisma.feedback.create({
      data: {
        tenantId,
        branchId,
        appointmentId: input.appointmentId ?? null,
        customerId: customerId ?? null,
        staffId: staffId ?? null,
        rating: input.rating,
        serviceRating: input.serviceRating ?? null,
        ambienceRating: input.ambienceRating ?? null,
        staffRating: input.staffRating ?? null,
        waitRating: input.waitRating ?? null,
        npsScore: input.npsScore ?? null,
        comment: input.comment ?? null,
        isComplaint,
        googleReviewRequested: !isComplaint,
      },
    }),
  );

  if (staffId) await refreshStaffRating(staffId);

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

  return {
    feedback,
    nextStep: isComplaint ? ('APOLOGY' as const) : ('GOOGLE_REVIEW' as const),
    // Only a happy customer is ever handed the Google link. Sending an unhappy
    // one there is how a salon buys itself a public one-star review.
    googleReviewUrl: isComplaint ? null : await googleReviewUrlFor(tenantId, branchId),
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
  from?: Date;
  to?: Date;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.FeedbackWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.staffId ? { staffId: input.staffId } : {}),
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

  return { items, total, page, pageSize };
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

  const where: Prisma.FeedbackWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  const [agg, distribution, npsRows, staffRatings, unresolved] = await Promise.all([
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
export async function publicFeedbackContext(appointmentId: string) {
  const appointment = await runUnscoped(() =>
    prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        tenant: { select: { name: true, logoUrl: true } },
        branch: { select: { name: true } },
        customer: { select: { firstName: true } },
        services: { include: { service: { select: { name: true } }, staff: { select: { displayName: true } } } },
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
    services: appointment.services.map((s) => s.service.name),
    staffName: appointment.services.find((s) => s.staff)?.staff?.displayName ?? null,
    alreadySubmitted: Boolean(appointment.feedback),
    tenantId: appointment.tenantId,
    branchId: appointment.branchId,
    googleReviewUrl: await googleReviewUrlFor(appointment.tenantId, appointment.branchId),
  };
}
