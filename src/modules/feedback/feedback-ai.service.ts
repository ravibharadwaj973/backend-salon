import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { env, aiReady } from '../../config/env';
import { aiVerified, chat } from '../../core/ai';

export { aiVerified };
import {
  type AnalysisInput,
  advertWordsIn,
  analysisPrompt,
  draftPrompt,
  DRAFT_COUNT,
  hasDraftMaterial,
  parseAnalysis,
  parseDrafts,
} from './feedback-ai';

/**
 * THE ONE PLACE THAT TALKS TO A MODEL.
 *
 * Everything decided here is about failure, because that is the only
 * interesting part: an analysis is a nice-to-have sitting behind a third
 * party's availability, and it must never be able to hurt the things a salon
 * actually runs on. So a failure is logged and dropped — never retried into a
 * loop, never propagated to the caller, never allowed to mark feedback as
 * analysed when it was not.
 *
 * What it will NOT do, ever: write a rating. The update at the bottom names
 * four columns and none of them is a score the customer gave. See the rule in
 * feedback-ai.ts.
 */

/**
 * The services to tell the model about, each with the customer's own stars
 * where they gave any.
 *
 * Two sources because a visit and a rating are not the same list: the
 * appointment knows everything they had, the rating rows know what they
 * bothered to score. A rated service wins — its score is the useful part —
 * and a service they had but skipped is named with a null so the prompt's
 * "say nothing about it" rule applies.
 */
function servicesWithRatings(feedback: {
  appointment?: { services: { service: { name: string } }[] } | null;
  serviceRatings: { rating: number; service: { name: string } }[];
}): { name: string; rating?: number | null }[] {
  const rated = feedback.serviceRatings.map((row) => ({
    name: row.service.name,
    rating: row.rating,
  }));
  const ratedNames = new Set(rated.map((row) => row.name));

  const unrated = (feedback.appointment?.services ?? [])
    .map((row) => ({ name: row.service.name, rating: null }))
    .filter((row) => !ratedNames.has(row.name));

  return [...rated, ...unrated];
}

/**
 * Analyse one piece of feedback and store what came back.
 *
 * Idempotent by way of the unique index on (feedbackId, topic): running it
 * twice replaces the topics rather than doubling every count on the dashboard.
 */
export async function analyseFeedback(feedbackId: string): Promise<void> {
  if (!aiReady) return;

  const feedback = await runUnscoped(() =>
    prisma.feedback.findUnique({
      where: { id: feedbackId },
      include: {
        appointment: {
          include: { services: { include: { service: { select: { name: true } } } } },
        },
        /**
         * The stars the customer put against each service, which the draft
         * writes from. Read from the ratings rather than from the appointment,
         * because these are the ones they actually answered — a service they
         * skipped has no row here and must go unmentioned.
         */
        serviceRatings: { include: { service: { select: { name: true } } } },
      },
    }),
  );

  if (!feedback) return;

  /**
   * Nothing to read means nothing to analyse.
   *
   * A rating with no comment is a complete piece of feedback and the numbers
   * are already stored; asking a model to infer a mood from a lone "4" invents
   * a topic list out of nothing. analyzedAt is still stamped, so it does not
   * sit in the backlog forever waiting for words that will never come.
   */
  const comment = feedback.comment?.trim();
  if (!comment) {
    await runUnscoped(() =>
      prisma.feedback.update({ where: { id: feedbackId }, data: { analyzedAt: new Date() } }),
    );
    return;
  }

  const input: AnalysisInput = {
    overallRating: feedback.rating,
    staffRating: feedback.staffRating,
    cleanlinessRating: feedback.ambienceRating,
    waitingRating: feedback.waitRating,
    comment,
    /**
     * The rated ones first, since those carry a score the draft can use. A
     * service on the visit that the customer did not rate is still named — it
     * is context for the words they wrote — but with a null score, which the
     * prompt is told means "say nothing about it".
     */
    services: servicesWithRatings(feedback),
  };

  const { system, user } = analysisPrompt(input);
  const raw = await chat(system, user);
  const analysis = raw ? parseAnalysis(raw) : null;

  if (!analysis) {
    // Deliberately NOT stamped as analysed. The model was reachable or it was
    // not, but this row still has words nobody has read — leaving analyzedAt
    // null keeps it in the backlog for a later run.
    logger.info({ feedbackId }, 'feedback analysis: nothing usable came back');
    return;
  }

  /**
   * A draft for whoever has something to draft from, whatever it says.
   *
   * It used to be produced only when the reading came back POSITIVE, on the
   * grounds that tidying an unhappy customer's complaint for publication was
   * no favour to the salon. That was the wrong call twice over: the Google
   * link is offered to everyone precisely because choosing who gets help is
   * gating, and doing it on a MODEL's reading of the words made the filter
   * both invisible and unaccountable. So the sentiment is recorded and does
   * not decide this.
   */
  /**
   * The first of the suggestions, for the single column. The salon's dashboard
   * shows one line per piece of feedback and has nowhere to put five; the list
   * itself is for the customer, on the page, while they are choosing.
   */
  const draft = (await draftReviewsNow(input))[0] ?? null;

  await runUnscoped(async () => {
    await prisma.$transaction([
      /**
       * Four columns, and not one of them is a rating.
       *
       * This is the rule the feature lives on, and it is enforced by what is
       * written rather than by anybody remembering it: `rating`,
       * `serviceRating`, `staffRating` and the rest are the customer's taps
       * and are not in this list.
       */
      prisma.feedback.update({
        where: { id: feedbackId },
        data: {
          sentiment: analysis.sentiment,
          sentimentScore: analysis.score,
          /**
           * Only ever written, never cleared.
           *
           * The submit path may already have drafted one while the customer
           * was still on the page. If this job then fails to produce its own —
           * the model was slow, or the reading came back neutral — writing
           * null here would delete the draft out from under somebody who is
           * looking at it.
           */
          ...(draft ? { reviewDraft: draft } : {}),
          analyzedAt: new Date(),
        },
      }),
      // Replaced rather than added to, so a re-run corrects a reading instead
      // of leaving both the old and the new one to be counted.
      prisma.feedbackTopic.deleteMany({ where: { feedbackId } }),
      prisma.feedbackTopic.createMany({
        data: analysis.topics.map((topic) => ({
          tenantId: feedback.tenantId,
          feedbackId,
          topic: topic.topic,
          sentiment: topic.sentiment,
        })),
      }),
    ]);
  });

  logger.info(
    { feedbackId, sentiment: analysis.sentiment, topics: analysis.topics.length },
    'feedback analysed',
  );
}

/**
 * A DRAFT WHILE THE CUSTOMER IS STILL LOOKING AT THE PAGE.
 *
 * analyseFeedback runs in a job, minutes later, which is the right place for
 * sentiment and topics — nobody is waiting for those. It is the wrong place
 * for the draft: the one moment somebody might post a public review is the
 * thirty seconds after they pressed send, and a draft that arrives after they
 * have closed the tab is a draft nobody reads.
 *
 * So this one is awaited on submit, with a short leash. If the model is slow
 * or missing, the page simply shows the Google link without a draft, which is
 * what it did before this existed.
 *
 * IT ONLY EVER SAYS BACK WHAT THEY TOLD US. Their comment when they wrote
 * one; otherwise the scores they gave — which service, the wait, the person
 * who served them — put into words, with a low score still reading as a
 * complaint. What it must never do is improve on them: see the rules in
 * feedback-ai.ts.
 *
 * `hasDraftMaterial` is what stops that from sliding into invention. An
 * overall rating and nothing else is not material; every draft is anchored to
 * something the customer actually pointed at.
 */
const DRAFT_TIMEOUT_MS = 8000;

/**
 * High on purpose. Two customers who rated the same thing the same way must
 * not get the same sentence — see the note on temperature in `chat`.
 */
const DRAFT_TEMPERATURE = 0.9;

/**
 * Five suggestions in one request, not five requests.
 *
 * One call is cheaper and faster, but the real reason is that a model asked for
 * five at once can be told to make them DIFFERENT from each other — different
 * lengths, different openings, leading on different things. Five separate calls
 * at the same temperature produce five samples from the same distribution, and
 * about one time in three two of them come back nearly identical, which is the
 * one impression a list of suggestions must not give.
 */
export async function draftReviewsNow(input: AnalysisInput): Promise<string[]> {
  if (!aiReady) return [];
  if (!hasDraftMaterial(input)) return [];

  const { system, user } = draftPrompt(input);
  const raw = await chat(system, user, {
    timeoutMs: DRAFT_TIMEOUT_MS,
    temperature: DRAFT_TEMPERATURE,
    // Five short reviews, plus whatever a reasoning model spends thinking.
    maxTokens: 300 * DRAFT_COUNT,
  });
  const drafts = raw ? parseDrafts(raw) : [];
  for (const draft of drafts) noteAdvertDrift(draft);
  return drafts;
}

/**
 * Count the times the draft came back sounding like a brochure.
 *
 * The draft is still shown — it is the customer's to edit, and a wince-worthy
 * adjective is not worth withholding the whole thing over. But a model drifts
 * back to marketing English on its own, and harder every time the model name
 * in the config changes, so the drift has to be visible in a log rather than
 * discovered by a salon owner reading their own Google page.
 */
function noteAdvertDrift(draft: string): void {
  const words = advertWordsIn(draft);
  if (words.length === 0) return;
  logger.warn(
    { words, model: env.GROQ_MODEL },
    'drafted review used advertisement words the prompt forbids',
  );
}
