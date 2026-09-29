/**
 * THE STOP ON A LOOP — WHICH MUST NOT BE A STOP ON A CONVERSATION.
 *
 * Every other guard in the reply path refuses a bad reply. These refuse a
 * runaway. If anything ever messages the salon's number automatically — another
 * bot, a forwarding rule, a test harness, the salon's own second system — each
 * side answers the other forever, at a cost per message, in the salon's name.
 *
 * ── Why one daily number was the wrong shape ──────────────────────────────
 *
 * It was ten replies per customer per day, and what it actually caught was a
 * customer asking ordinary questions:
 *
 *   4:43  "do we have empty slot for appointment?"
 *         → "I have passed this to the team. For anything today, please call…"
 *   4:44  "Do you have the hair spa service"     → nothing
 *   4:45  "Hello again this stop answering"      → nothing
 *
 * Nothing was looping. Somebody had used up the day's allowance having the kind
 * of conversation the feature exists to have, and the loop guard spent itself on
 * them. One booking costs up to three replies on its own — which location, here
 * is a time, done — so ten was barely three conversations.
 *
 * ── What actually separates a loop from a customer ────────────────────────
 *
 * Speed, not volume. Two machines answering each other complete a cycle in
 * seconds and would pass any sane daily figure within a minute. A person types,
 * reads, thinks, puts the phone down. So the tight limit belongs over a short
 * window — where a loop is unmistakable and a human cannot plausibly arrive —
 * and the daily figure becomes a generous backstop rather than the thing that
 * fires.
 *
 * The burst limit also ENDS a loop rather than merely surviving it: the other
 * side speaks only because we did, so the moment this goes quiet, it stops. The
 * daily limit exists for the loop that does not depend on us — something on a
 * schedule, slow enough to stay under the burst window.
 */

export const BURST_WINDOW_MINUTES = 10;

/**
 * Eight in ten minutes. A loop reaches this in about a minute, having cost eight
 * messages; a customer typing on a phone essentially cannot, and one in the
 * middle of a booking comes nowhere near it.
 */
export const MAX_REPLIES_PER_BURST = 8;

/**
 * Generous on purpose. This is no longer the limit that protects anything in the
 * common case — the burst window does that — so its job is only to bound the
 * slow runaway, and a real customer must never meet it.
 */
export const MAX_REPLIES_PER_DAY = 40;

export interface CeilingDecision {
  which: 'burst' | 'daily';
  /**
   * HAND_OVER exactly once, at the limit. SILENT above it.
   *
   * A limit that sends a message instead of a reply is not a limit, so it cannot
   * hand over every time. But going abruptly quiet mid-conversation is the
   * failure this whole area keeps producing, so it cannot simply stop either.
   *
   * Nothing is stored to make it happen once: the handoff is itself a reply and
   * counts towards the same totals, so the message that trips a limit sends the
   * handoff, and every message after it sees a count above the limit.
   */
  action: 'HAND_OVER' | 'SILENT';
}

/**
 * Whether this reply is allowed, given how many have already gone out.
 *
 * Null means carry on. The burst window is checked first because it is the one
 * that means something is wrong right now; a conversation that has been going
 * all day is not the same problem as one going at four messages a minute.
 */
export function replyCeiling(counts: { inBurst: number; today: number }): CeilingDecision | null {
  if (counts.inBurst >= MAX_REPLIES_PER_BURST) {
    return {
      which: 'burst',
      action: counts.inBurst === MAX_REPLIES_PER_BURST ? 'HAND_OVER' : 'SILENT',
    };
  }

  if (counts.today >= MAX_REPLIES_PER_DAY) {
    return {
      which: 'daily',
      action: counts.today === MAX_REPLIES_PER_DAY ? 'HAND_OVER' : 'SILENT',
    };
  }

  return null;
}
