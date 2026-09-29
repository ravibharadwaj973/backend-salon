/**
 * WHAT KIND OF WHATSAPP MESSAGE IS ALLOWED RIGHT NOW.
 *
 * Meta's rule, not ours: a free-form message may be sent only within 24 hours
 * of the customer's own last message. Outside that window only an approved
 * template will deliver, and a plain send comes back 131047.
 *
 * ── The distinction that matters ─────────────────────────────────────────
 *
 * The window does NOT decide whether the assistant runs. A message arrives, the
 * webhook fires, the model is called, an answer exists — all of that is true at
 * any hour. The window decides only what SHAPE that answer may take on its way
 * out: free text now, or an approved template later.
 *
 * Conflating the two produces the wrong system twice over. Gate the model on
 * the window and a customer writing at hour 25 gets nothing at all, when a
 * template would have reached them. Ignore the window and every reply outside
 * it fails at Meta with an error the salon never sees, and their answers simply
 * evaporate.
 */

export const SERVICE_WINDOW_HOURS = 24;

export function windowExpiresAt(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + SERVICE_WINDOW_HOURS * 60 * 60 * 1000);
}

/** True while a plain, non-template WhatsApp message will be delivered. */
export function windowIsOpen(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now < windowExpiresAt(lastInboundAt);
}

export function minutesLeftInWindow(
  lastInboundAt: Date | null | undefined,
  now = new Date(),
): number {
  if (!lastInboundAt) return 0;
  return Math.max(0, Math.round((windowExpiresAt(lastInboundAt).getTime() - now.getTime()) / 60000));
}

/**
 * What a caller should do, said once so no caller has to work it out.
 *
 * 'FREE_FORM' — the customer wrote recently; say anything.
 * 'TEMPLATE'  — the window has shut; only an approved template will arrive.
 *
 * Deliberately not a boolean. `canSendFreeForm === false` reads as "cannot
 * message them", which is not what it means and is how a proactive reminder
 * ends up being suppressed for somebody who is perfectly reachable.
 */
export function allowedShape(
  lastInboundAt: Date | null | undefined,
  now = new Date(),
): 'FREE_FORM' | 'TEMPLATE' {
  return windowIsOpen(lastInboundAt, now) ? 'FREE_FORM' : 'TEMPLATE';
}
