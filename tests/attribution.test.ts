import { describe, expect, it } from 'vitest';
import {
  MAX_WINDOW_DAYS,
  MIN_GROUP_FOR_LIFT,
  OBJECTIVES,
  WINDOW_CHOICES,
  computeLift,
  inWindow,
  objectiveInfo,
  windowEnd,
  windowStart,
} from '../src/modules/marketing/attribution';

/**
 * The attribution window is the whole argument. Too short and a campaign that
 * worked looks like it failed; too long and every visit a customer was going to
 * make anyway is credited to whatever message happened to land first.
 */
describe('how long a campaign gets credit for', () => {
  it('gives a short window to a reminder and a long one to a win-back', () => {
    // One fixed fortnight for both flatters the reminder and writes off the
    // win-back — and the owner then acts on that conclusion.
    expect(objectiveInfo('REMINDER').suggestedWindowDays).toBeLessThanOrEqual(3);
    expect(objectiveInfo('WINBACK').suggestedWindowDays).toBeGreaterThanOrEqual(30);
    expect(objectiveInfo('REACTIVATION').suggestedWindowDays).toBeGreaterThanOrEqual(
      objectiveInfo('WINBACK').suggestedWindowDays,
    );
  });

  it('describes every objective, with a reason for its window', () => {
    // The number is a judgement the owner should be able to argue with, not a
    // default nobody questioned.
    for (const info of OBJECTIVES) {
      expect(info.label, info.objective).toBeTruthy();
      expect(info.rationale, info.objective).toBeTruthy();
      expect(info.suggestedWindowDays, info.objective).toBeGreaterThan(0);
      expect(info.suggestedEvents.length, info.objective).toBeGreaterThan(0);
    }
  });

  it('keeps every suggested window inside what the form allows', () => {
    for (const info of OBJECTIVES) {
      expect(info.suggestedWindowDays, info.objective).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
      expect(WINDOW_CHOICES, info.objective).toContain(info.suggestedWindowDays);
    }
  });

  it('judges a reminder on the visit, not on a booking it already had', () => {
    // The appointment exists already; booking is not the thing being measured.
    expect(objectiveInfo('REMINDER').suggestedEvents).toEqual(['VISIT']);
  });

  it('falls back rather than throwing on an objective it has no entry for', () => {
    // A value added to the enum and not yet described here must not stop a
    // campaign being sent.
    expect(objectiveInfo('OTHER').objective).toBe('OTHER');
    expect(objectiveInfo('NONSENSE' as never).objective).toBe('OTHER');
  });
});

/**
 * A campaign that goes out over five days must not give the person reached on
 * the fifth day a window two-fifths shorter than the first, purely because of
 * sending order — the ones reached last would look like the ones who did not
 * respond.
 */
describe('where a recipient’s window starts', () => {
  const DELIVERED = new Date('2026-09-29T10:00:00Z');
  const SENT = new Date('2026-09-25T10:00:00Z');
  const QUEUED = new Date('2026-09-25T09:00:00Z');

  it('starts at that recipient’s own delivery', () => {
    expect(windowStart({ deliveredAt: DELIVERED, sentAt: SENT, queuedAt: QUEUED })).toBe(DELIVERED);
  });

  it('falls back to the send when the channel never confirms delivery', () => {
    // SMS. Without this fallback every SMS recipient would have no window at
    // all, and an entire channel would report zero conversions for ever.
    expect(windowStart({ deliveredAt: null, sentAt: SENT, queuedAt: QUEUED })).toBe(SENT);
  });

  it('falls back to the queue when nothing else is known', () => {
    expect(windowStart({ deliveredAt: null, sentAt: null, queuedAt: QUEUED })).toBe(QUEUED);
  });

  it('has no window at all when nothing ever left', () => {
    // A skipped message is not evidence of anything either way.
    expect(windowStart({ deliveredAt: null, sentAt: null, queuedAt: null })).toBeNull();
  });

  it('runs the same number of days for everyone, whenever they were reached', () => {
    // The point from the spec: reached on the 29th, the window runs from the
    // 29th — not from the campaign's launch on the 25th.
    const early = windowEnd(SENT, 21);
    const late = windowEnd(DELIVERED, 21);
    expect(late.getTime() - DELIVERED.getTime()).toBe(early.getTime() - SENT.getTime());
    expect(late > early).toBe(true);
  });

  it('counts an event on the window’s own edges', () => {
    const end = windowEnd(SENT, 14);
    expect(inWindow(SENT, SENT, end)).toBe(true);
    expect(inWindow(end, SENT, end)).toBe(true);
    expect(inWindow(new Date(SENT.getTime() - 1), SENT, end)).toBe(false);
    expect(inWindow(new Date(end.getTime() + 1), SENT, end)).toBe(false);
  });
});

/**
 * THE TEST THAT STOPS THIS BEING A VANITY METRIC.
 *
 * Attributed is not caused. A customer who comes every month is credited to
 * whichever campaign last landed in their window, so a salon with a healthy
 * book can send nothing of value and still record hundreds of "attributed"
 * visits. Reported alone, the total says the campaign worked no matter what it
 * was.
 */
describe('whether the campaign actually did anything', () => {
  const big = (engagedRate: number, quietRate: number) =>
    computeLift({
      engagedRecipients: 500,
      engagedConverted: Math.round(500 * engagedRate),
      quietRecipients: 500,
      quietConverted: Math.round(500 * quietRate),
    });

  it('says so when people who opened it came in far more often', () => {
    const lift = big(0.12, 0.04);
    expect(lift.ratio).toBe(3);
    expect(lift.reliable).toBe(true);
    expect(lift.verdict).toMatch(/campaign doing something/);
  });

  it('says plainly when the visits were happening anyway', () => {
    // Both groups at 6%: the campaign changed nothing, and no total would ever
    // have revealed it.
    const lift = big(0.06, 0.06);
    expect(lift.ratio).toBe(1);
    expect(lift.verdict).toMatch(/happening anyway/);
  });

  it('does not dress up a campaign that did worse than nothing', () => {
    const lift = big(0.03, 0.06);
    expect(lift.ratio).toBeLessThan(1);
    expect(lift.verdict).toMatch(/not evidence the campaign worked/);
  });

  it('refuses to print a ratio from too few people', () => {
    // A confident "3.2× lift" computed from four customers is worse than no
    // number: one person moves the rate by tens of per cent.
    const lift = computeLift({
      engagedRecipients: 4,
      engagedConverted: 2,
      quietRecipients: 3,
      quietConverted: 0,
    });
    expect(lift.reliable).toBe(false);
    expect(lift.verdict).toMatch(new RegExp(String(MIN_GROUP_FOR_LIFT)));
    // The totals are still real; it is the causal claim that is withheld.
    expect(lift.verdict).toMatch(/totals are still real/);
  });

  it('holds the line exactly at the threshold', () => {
    const just = computeLift({
      engagedRecipients: MIN_GROUP_FOR_LIFT,
      engagedConverted: 6,
      quietRecipients: MIN_GROUP_FOR_LIFT,
      quietConverted: 3,
    });
    expect(just.reliable).toBe(true);

    const oneShort = computeLift({
      engagedRecipients: MIN_GROUP_FOR_LIFT - 1,
      engagedConverted: 6,
      quietRecipients: MIN_GROUP_FOR_LIFT,
      quietConverted: 3,
    });
    expect(oneShort.reliable).toBe(false);
  });

  it('handles nobody ignoring the message converting', () => {
    // Division by zero would be a crash on the best possible result.
    const lift = computeLift({
      engagedRecipients: 200,
      engagedConverted: 40,
      quietRecipients: 200,
      quietConverted: 0,
    });
    expect(lift.ratio).toBeNull();
    expect(lift.verdict).toMatch(/good sign/);
  });

  it('handles a campaign nobody engaged with at all', () => {
    const lift = computeLift({
      engagedRecipients: 0,
      engagedConverted: 0,
      quietRecipients: 400,
      quietConverted: 20,
    });
    expect(lift.engagedRatePct).toBeNull();
    expect(lift.reliable).toBe(false);
  });

  it('reports both rates so the reader can check the ratio themselves', () => {
    const lift = big(0.12, 0.04);
    expect(lift.engagedRatePct).toBe(12);
    expect(lift.quietRatePct).toBe(4);
  });
});
