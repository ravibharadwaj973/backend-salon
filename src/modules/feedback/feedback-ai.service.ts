import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { env, aiReady } from '../../config/env';
import {
  type AnalysisInput,
  analysisPrompt,
  draftPrompt,
  parseAnalysis,
  parseDraft,
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

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * One call to an OpenAI-compatible chat endpoint.
 *
 * Returns null on anything at all — no key, a refusal, a timeout, malformed
 * JSON. The caller cannot tell the difference and does not need to: in every
 * case there is nothing to store.
 */
async function chat(system: string, user: string, timeoutMs?: number): Promise<string | null> {
  if (!aiReady) return null;

  // AbortSignal.timeout rather than a race: this actually cancels the request,
  // so a slow endpoint stops holding a socket as well as a worker.
  const signal = AbortSignal.timeout(timeoutMs ?? env.GROQ_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        // Labelling is not a creative task. The same comment should come back
        // with the same topics in March as in September, or the trend lines
        // measure the model's mood rather than the salon's.
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    });

    const data = (await response.json()) as ChatResponse;

    if (!response.ok || data.error) {
      /**
       * The message, never the key. An upstream error body can echo request
       * details back, and this line goes to the same log a support engineer
       * pastes into a ticket.
       */
      logger.warn(
        { status: response.status, reason: data.error?.message ?? 'unknown' },
        'feedback analysis: model refused',
      );
      return null;
    }

    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'feedback analysis: call failed');
    return null;
  }
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
    services: (feedback.appointment?.services ?? []).map((row) => ({ name: row.service.name })),
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
   * A drafted review only for somebody who might actually post one.
   *
   * Asked for separately, and only when the reading is positive — not to
   * filter who is invited to review (everyone is; see feedback.service.ts) but
   * because rewriting an unhappy customer's complaint into a tidy paragraph
   * for them to publish is not a favour anyone asked for. An unhappy customer
   * who wants to post says it in their own words.
   */
  let draft: string | null = null;
  if (analysis.sentiment === 'POSITIVE') {
    const draftPrompts = draftPrompt(input);
    const rawDraft = await chat(draftPrompts.system, draftPrompts.user);
    draft = rawDraft ? parseDraft(rawDraft) : null;
  }

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
 * IT ONLY EVER REARRANGES WHAT THEY WROTE. Nothing is generated from the
 * rating or the service list — a review assembled from a five-star tap and
 * the word "Haircut" would be the salon's words in the customer's mouth,
 * which is what Google's rating-manipulation policy is looking for. No
 * comment, no draft.
 */
const DRAFT_TIMEOUT_MS = 8000;

export async function draftReviewNow(input: AnalysisInput): Promise<string | null> {
  if (!aiReady) return null;
  if (!input.comment?.trim()) return null;

  const { system, user } = draftPrompt(input);
  const raw = await chat(system, user, DRAFT_TIMEOUT_MS);
  return raw ? parseDraft(raw) : null;
}
