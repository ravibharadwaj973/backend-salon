import { describe, expect, it } from 'vitest';
import { REPLY_WINDOW_HOURS, minutesLeft, windowClosesAt } from '../src/modules/messaging/inbox.service';

/**
 * THE 24-HOUR WINDOW, WHICH NOTHING USED TO TRACK.
 *
 * WhatsApp allows a free-form reply only within 24 hours of the customer
 * writing. Outside it, only an approved template sends and a plain reply comes
 * back 131047 — which a salon experiences as their answer silently never
 * arriving, with no error anywhere they would look.
 *
 * The arithmetic is trivial and the consequence of getting it wrong is not, so
 * it is in one place and tested rather than inlined into a component.
 */
describe('the reply window', () => {
  const received = new Date('2026-09-29T10:00:00Z');

  it('closes 24 hours after the customer wrote', () => {
    expect(REPLY_WINDOW_HOURS).toBe(24);
    expect(windowClosesAt(received).toISOString()).toBe('2026-09-30T10:00:00.000Z');
  });

  it('counts down in minutes', () => {
    expect(minutesLeft(received, new Date('2026-09-29T10:00:00Z'))).toBe(24 * 60);
    expect(minutesLeft(received, new Date('2026-09-29T22:00:00Z'))).toBe(12 * 60);
    expect(minutesLeft(received, new Date('2026-09-30T09:30:00Z'))).toBe(30);
  });

  it('never goes negative', () => {
    // A closed window is closed. A negative number would sort oddly and read
    // as "minus three hours left", which is not a thing.
    expect(minutesLeft(received, new Date('2026-10-05T10:00:00Z'))).toBe(0);
  });

  it('is zero exactly on the boundary, not one minute over', () => {
    expect(minutesLeft(received, new Date('2026-09-30T10:00:00Z'))).toBe(0);
  });
});
