import { describe, expect, it } from 'vitest';
import { SERVICE_WINDOW_HOURS, allowedShape, windowExpiresAt, windowIsOpen } from '../src/messaging/service-window';

/**
 * AFTER 24 HOURS, A PLAIN MESSAGE DOES NOT GO OUT.
 *
 * Meta delivers free-form WhatsApp text only within 24 hours of the customer's
 * own last message. Outside that it rejects the send with error 131047 — and
 * rejects it ASYNCHRONOUSLY, as a delivery failure arriving minutes later. So
 * the message looks sent, sits in the thread, and never arrives.
 *
 * That is the worst shape a failure can take, because the salon believes it
 * answered. The gate in the dispatcher refuses the send instead, and writes a
 * SKIPPED log saying what happened and that a template would have worked.
 *
 * What is pinned here is the rule the gate applies. The gate itself needs a
 * database; this is the arithmetic underneath it, which is where an off-by-one
 * would silently widen or narrow the window for every salon at once.
 */

const at = (iso: string) => new Date(iso);

describe('when a plain message may still be delivered', () => {
  it('is 24 hours, not a day of the week or a calendar day', () => {
    expect(SERVICE_WINDOW_HOURS).toBe(24);
    expect(windowExpiresAt(at('2026-10-01T10:00:00Z')).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('is open right up to the boundary and shut on it', () => {
    const last = at('2026-10-01T10:00:00Z');
    expect(windowIsOpen(last, at('2026-10-02T09:59:59Z'))).toBe(true);
    // Exactly 24 hours later is shut. `now < expiry`, not `<=` — a message sent
    // on the boundary is the one Meta is most likely to reject, and guessing
    // generously there produces a message that looks sent and never arrives.
    expect(windowIsOpen(last, at('2026-10-02T10:00:00Z'))).toBe(false);
    expect(windowIsOpen(last, at('2026-10-02T10:00:01Z'))).toBe(false);
  });

  it('restarts from the customer’s latest message, not their first', () => {
    // Day 1 10:00 "Hello", then day 1 20:00 "Can I come at 6?" — the window runs
    // to 20:00 on day 2. Reading the first message would shut it ten hours early
    // and refuse a reply the customer is actively waiting for.
    const first = at('2026-10-01T10:00:00Z');
    const latest = at('2026-10-01T20:00:00Z');
    const checkAt = at('2026-10-02T15:00:00Z');

    expect(windowIsOpen(first, checkAt)).toBe(false);
    expect(windowIsOpen(latest, checkAt)).toBe(true);
  });

  it('is shut for somebody who has never written', () => {
    /**
     * You cannot start a conversation with free text. This is also why the
     * dispatcher's gate reads BOTH the customer record and the conversation:
     * a stranger who messages the salon has no Customer row at all, and reading
     * only that field would refuse every reply to somebody not on the book —
     * which the inbox is specifically built to handle.
     */
    expect(windowIsOpen(null)).toBe(false);
    expect(windowIsOpen(undefined)).toBe(false);
    expect(allowedShape(null)).toBe('TEMPLATE');
  });

  it('says what to do instead rather than just refusing', () => {
    // 'TEMPLATE' rather than `false`. A boolean reads as "cannot message them",
    // which is not what it means: a template reaches them perfectly well, and
    // that misreading is how a proactive reminder gets suppressed for somebody
    // who was entirely reachable.
    const last = at('2026-10-01T10:00:00Z');
    expect(allowedShape(last, at('2026-10-01T18:00:00Z'))).toBe('FREE_FORM');
    expect(allowedShape(last, at('2026-10-03T10:00:00Z'))).toBe('TEMPLATE');
  });
});

describe('the later of the two records is the one that counts', () => {
  /**
   * `customer.lastInboundAt` and `conversation.lastCustomerMessageAt` both hold
   * this, and either can be the more recent one. The dispatcher takes the later,
   * which is the only choice that cannot silence a reply somebody is owed.
   */
  const later = (a: Date | null, b: Date | null): Date | null => {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  };

  it('opens the window when either record is recent', () => {
    const stale = at('2026-10-01T10:00:00Z');
    const fresh = at('2026-10-03T09:00:00Z');
    const now = at('2026-10-03T12:00:00Z');

    expect(windowIsOpen(later(stale, fresh), now)).toBe(true);
    expect(windowIsOpen(later(fresh, stale), now)).toBe(true);
  });

  it('answers a stranger who has no customer record at all', () => {
    const fromThread = at('2026-10-03T09:00:00Z');
    expect(windowIsOpen(later(null, fromThread), at('2026-10-03T12:00:00Z'))).toBe(true);
  });

  it('stays shut when both are old', () => {
    const now = at('2026-10-05T12:00:00Z');
    expect(windowIsOpen(later(at('2026-10-01T10:00:00Z'), at('2026-10-02T10:00:00Z')), now)).toBe(false);
  });
});
