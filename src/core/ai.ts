import { logger } from './logger';
import { env, aiReady } from '../config/env';

/**
 * THE ONE PLACE THAT TALKS TO A MODEL.
 *
 * Lifted out of the feedback module, where it was private, the moment a second
 * feature needed it. The alternative was a second copy — and a second copy of
 * a client means two timeout policies, two ways of classifying a 404, and a
 * misconfiguration that is loud in one half of the app and silent in the other.
 *
 * Everything here is about failure, because that is the only interesting part.
 * A model is a third party: it is slow, it is occasionally absent, and nothing
 * a salon runs on may depend on it answering.
 */

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/**
 * Why the last call failed, when it failed for a reason a retry cannot fix.
 *
 * Null means either "no call has been made yet" or "the last one worked" —
 * the two states that need no attention. Anything else is a setting somebody
 * has to change, and /health says so, because a key that is PRESENT and a key
 * that WORKS are different facts and only the second one matters.
 */
let configBroken: string | null = null;

/**
 * Has the model actually answered? true after one good call, false once a
 * setting has been rejected, null before anything has been tried.
 *
 * Deliberately not a live probe: /health is hit constantly by a container
 * healthcheck and must not spend a token or wait on a third party to answer.
 */
export function aiVerified(): boolean | null {
  if (configBroken) return false;
  return aiAnswered ? true : null;
}

let aiAnswered = false;

/**
 * `reasoning_effort`, for the models that have one.
 *
 * An explicit GROQ_REASONING_EFFORT wins. Otherwise it is sent to the gpt-oss
 * family and to nothing else, because a model that does not know the parameter
 * rejects the whole request with a 400 — so guessing wrong here does not
 * degrade the answer, it removes it.
 */
function reasoningEffort(): { reasoning_effort: string } | Record<string, never> {
  if (env.GROQ_REASONING_EFFORT) return { reasoning_effort: env.GROQ_REASONING_EFFORT };
  if (/gpt-oss/i.test(env.GROQ_MODEL)) return { reasoning_effort: 'low' };
  return {};
}

/**
 * One call to an OpenAI-compatible chat endpoint.
 *
 * Returns null on anything at all — no key, a refusal, a timeout, malformed
 * JSON. The caller cannot tell the difference and does not need to: in every
 * case there is nothing to store.
 */
export async function chat(
  system: string,
  user: string,
  options: { timeoutMs?: number; temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
  if (!aiReady) return null;

  // AbortSignal.timeout rather than a race: this actually cancels the request,
  // so a slow endpoint stops holding a socket as well as a worker.
  const signal = AbortSignal.timeout(options.timeoutMs ?? env.GROQ_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        /**
         * Zero for labelling, warm for writing — and the difference matters
         * more than it looks.
         *
         * Labelling is not creative: the same comment must come back with the
         * same topics in March as in September, or the trend lines measure the
         * model's mood rather than the salon's.
         *
         * A drafted review is the opposite case. At zero, every customer who
         * rated a haircut four stars gets the SAME SENTENCE — and twenty
         * reviews on one Google profile opening the same way is the clearest
         * signal of astroturfing there is. Real customers do not write in
         * chorus. The variation is not decoration; it is the thing that keeps
         * these from being detectable as a batch.
         */
        temperature: options.temperature ?? 0,
        /**
         * Room for a model that thinks first.
         *
         * 500 was ample for the answer and is not ample for a reasoning model,
         * where the deliberation is spent from the same budget: the content
         * comes back empty or cut in half, which looks exactly like a model
         * that refused. Neither prompt here wants more than a paragraph, so
         * the headroom costs nothing when it is not used.
         */
        max_tokens: options.maxTokens ?? 1200,
        /**
         * Only when it will be understood — an unknown parameter is a 400, not
         * a shrug. Overridable because the next family will have its own idea
         * of what this is called, and a stale default should be one env change.
         */
        ...reasoningEffort(),
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
       * A BROKEN SETTING IS NOT A BAD DAY, AND MUST NOT LOOK LIKE ONE.
       *
       * This was one `warn` for every failure, and it cost a long hunt. The
       * server had been answering
       *
       *   404 — the model `llama-3.3-70b-versatile` does not exist or you do
       *         not have access to it
       *
       * on every single request, for days. A 404 there can never succeed: the
       * key is fine, the endpoint is fine, the account simply cannot use that
       * model, and nothing will change until somebody edits GROQ_MODEL. But it
       * logged at the same level as a momentary rate limit, in a stream of
       * 200s, so it read as noise — while the feature it disabled looked, from
       * the outside, exactly like a feature that had never been built.
       *
       * 401/403/404 are settings. 429 and 5xx and timeouts are weather. The
       * first kind says what to change and is loud enough to stop somebody;
       * the second stays quiet, because it fixes itself.
       *
       * The message, never the key. An upstream error body can echo request
       * details back, and this line goes to the same log a support engineer
       * pastes into a ticket.
       */
      const reason = data.error?.message ?? 'unknown';
      const isSetting = [400, 401, 403, 404].includes(response.status);

      if (isSetting) {
        configBroken = reason;
        logger.error(
          { status: response.status, reason, model: env.GROQ_MODEL, set: 'GROQ_MODEL / GROQ_API_KEY' },
          'feedback AI is MISCONFIGURED and every call will fail until a setting changes — ' +
            'no sentiment, no topics and no drafted reviews',
        );
      } else {
        logger.warn({ status: response.status, reason }, 'feedback analysis: model refused');
      }
      return null;
    }

    // One good answer clears a previous complaint, so a fixed setting stops
    // being reported as broken without needing a restart.
    configBroken = null;
    aiAnswered = true;
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'feedback analysis: call failed');
    return null;
  }
}

