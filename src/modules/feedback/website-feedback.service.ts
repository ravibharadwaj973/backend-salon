import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped, requireTenantId } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { normalizePhone } from '../../core/ids';
import { logger } from '../../core/logger';

/**
 * FEEDBACK LEFT ON THE SALON'S OWN WEBSITE.
 *
 * Kept in its own file rather than folded into submitFeedback, because the two
 * differ in the one way that matters: WHO IS SAYING IT.
 *
 * A post-visit rating arrives through a link in a message the salon sent to a
 * specific customer about a specific appointment. The salon knows who it was
 * and what was done. A rating typed into a form on a public website arrives
 * from whoever opened the page — a delighted regular, somebody who has never
 * been in, or a competitor with a spare afternoon.
 *
 * Both are worth collecting. Treating them as the same kind of evidence is
 * what turns a salon's rating into a number a stranger can move, so three
 * things are deliberately NOT done here:
 *
 *  1. NO CUSTOMER LINK. The phone number is unverified. Matching it to a
 *     customer record and writing customerId would let anybody attach "I was
 *     treated badly" to a named person's profile. The salon is shown a
 *     possible match when they read it, which is a suggestion, not a claim.
 *
 *  2. NO JOURNEY. A low rating from the visit form starts the recovery
 *     automation, which messages the customer. Firing that from a public form
 *     means anyone can type a stranger's number and make the salon message
 *     them — a spam cannon with the salon's name on it.
 *
 *  3. NOTHING IS PUBLISHED. isPublic stays false until a person at the salon
 *     says otherwise. A form that puts a stranger's words on the salon's
 *     website the moment they press send is a defacement tool with a rating
 *     attached.
 */

export interface WebsiteFeedbackInput {
  rating: number;
  comment?: string;
  name: string;
  phone?: string;
  branchId?: string;
  /**
   * A field no human ever fills in, because it is not shown to them.
   *
   * The cheapest spam filter there is: the overwhelming majority of form
   * bots fill in every input they find. It costs one hidden field and stops
   * more than a CAPTCHA would — and unlike a CAPTCHA it asks nothing of the
   * customer, who came here to say something nice.
   */
  website?: string;
}

export interface FeedbackFormConfig {
  enabled: boolean;
  heading: string;
  prompt: string;
  /** Whether the form asks for a phone number, and whether it insists. */
  phone: 'required' | 'optional' | 'off';
  /** Whether approved reviews are shown back on the salon's site. */
  showReviews: boolean;
}

const DEFAULTS: FeedbackFormConfig = {
  enabled: false,
  heading: 'How did we do?',
  prompt: 'We read every one of these, and they go straight to the owner.',
  // Required by default: a rating nobody can be traced back to is a rating the
  // salon can neither act on nor answer.
  phone: 'required',
  showReviews: true,
};

/** The salon's own wording, over the defaults. Never throws on a bad shape. */
export function readFormConfig(settings: unknown): FeedbackFormConfig {
  const raw = ((settings as Record<string, unknown>)?.feedbackForm ?? {}) as Record<string, unknown>;

  const str = (value: unknown, fallback: string, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;

  return {
    enabled: raw.enabled === true,
    heading: str(raw.heading, DEFAULTS.heading, 80),
    prompt: str(raw.prompt, DEFAULTS.prompt, 240),
    phone:
      raw.phone === 'optional' || raw.phone === 'off' || raw.phone === 'required'
        ? raw.phone
        : DEFAULTS.phone,
    showReviews: raw.showReviews !== false,
  };
}

/**
 * Everything the salon's website needs to draw its feedback section, in one
 * call: whether it is switched on, the salon's own wording, and the reviews
 * they have approved for showing.
 */
export async function publicFeedbackSection(tenantId: string) {
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
  );
  const config = readFormConfig(tenant?.settings);

  const reviews = config.showReviews
    ? await runUnscoped(() =>
        prisma.feedback.findMany({
          where: { tenantId, isPublic: true, comment: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 12,
          select: { id: true, rating: true, comment: true, createdAt: true, authorName: true, customer: { select: { firstName: true } } },
        }),
      )
    : [];

  return {
    config,
    /**
     * A first name and nothing else. The salon approved the words, not the
     * customer's full identity — and a surname plus a rating on a public page
     * is more than anybody agreed to when they filled in a form.
     */
    reviews: reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      at: review.createdAt,
      name: (review.authorName ?? review.customer?.firstName ?? 'A customer').split(' ')[0],
    })),
  };
}

export async function submitWebsiteFeedback(tenantId: string, input: WebsiteFeedbackInput) {
  // Silently accepted and silently dropped. Telling a bot it was caught is
  // telling it which field to leave alone next time.
  if (input.website) {
    logger.debug({ tenantId }, 'website feedback: honeypot filled, dropped');
    return { recorded: false };
  }

  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
  );
  const config = readFormConfig(tenant?.settings);
  if (!config.enabled) throw NotFound('Feedback form');

  if (input.rating < 1 || input.rating > 5) throw BadRequest('Rating must be between 1 and 5');
  if (config.phone === 'required' && !input.phone?.trim()) {
    throw BadRequest('A phone number is required so we can get back to you');
  }

  /**
   * The branch, when the salon has more than one.
   *
   * A feedback row needs one, and a website visitor usually has no idea the
   * salon has three shops. The form may name one; otherwise it lands on the
   * first active branch and the salon can move it. Guessing is better than
   * refusing: a customer who took the trouble to write something must not
   * lose it to a field they were never shown.
   */
  const branchId =
    input.branchId ??
    (
      await runUnscoped(() =>
        prisma.branch.findFirst({
          where: { tenantId, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        }),
      )
    )?.id;
  if (!branchId) throw BadRequest('This salon has no branch set up yet');

  const branchBelongs = await runUnscoped(() =>
    prisma.branch.count({ where: { id: branchId, tenantId } }),
  );
  if (!branchBelongs) throw BadRequest('Unknown branch');

  const feedback = await runUnscoped(() =>
    prisma.feedback.create({
      data: {
        tenantId,
        branchId,
        source: 'WEBSITE',
        rating: input.rating,
        comment: input.comment?.trim().slice(0, 2000) || null,
        authorName: input.name.trim().slice(0, 80),
        authorPhone: input.phone?.trim() ? normalizePhone(input.phone.trim()) : null,
        isComplaint: input.rating <= 3,
        // Never asked for on this path. The Google invitation belongs to a
        // customer the salon knows served well, not to an unverified form.
        googleReviewRequested: false,
        isPublic: false,
      } satisfies Prisma.FeedbackUncheckedCreateInput,
    }),
  );

  return { recorded: true, id: feedback.id };
}

/**
 * The customer this MIGHT be, for the salon's eyes only.
 *
 * Computed when the salon reads the feedback rather than stored on it, which
 * is the whole point: a stored link is the app asserting that this rating
 * belongs to that customer, on the strength of a phone number anybody could
 * type. A match shown on screen is the salon being told something useful and
 * left to decide.
 */
export async function possibleAuthors(feedbackIds: string[]) {
  if (feedbackIds.length === 0) return new Map<string, { id: string; name: string }>();
  const tenantId = requireTenantId();

  const rows = await prisma.feedback.findMany({
    where: { id: { in: feedbackIds }, source: 'WEBSITE', authorPhone: { not: null } },
    select: { id: true, authorPhone: true },
  });

  const phones = [...new Set(rows.map((r) => r.authorPhone!))];
  if (phones.length === 0) return new Map<string, { id: string; name: string }>();

  const customers = await prisma.customer.findMany({
    where: { tenantId, phone: { in: phones } },
    select: { id: true, firstName: true, lastName: true, phone: true },
  });

  const byPhone = new Map(customers.map((c) => [c.phone, c]));
  const out = new Map<string, { id: string; name: string }>();

  for (const row of rows) {
    const match = byPhone.get(row.authorPhone!);
    if (match) out.set(row.id, { id: match.id, name: `${match.firstName} ${match.lastName ?? ''}`.trim() });
  }

  return out;
}

/** Publish, or take down, one piece of feedback on the salon's own website. */
export async function setFeedbackPublic(id: string, isPublic: boolean, userId: string | null) {
  const tenantId = requireTenantId();
  const feedback = await prisma.feedback.findFirst({ where: { id, tenantId } });
  if (!feedback) throw NotFound('Feedback');

  return prisma.feedback.update({
    where: { id },
    data: {
      isPublic,
      approvedAt: isPublic ? new Date() : null,
      approvedById: isPublic ? userId : null,
    },
  });
}
