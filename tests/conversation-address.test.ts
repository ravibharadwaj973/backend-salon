import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/core/ids';

/**
 * THE BUG THIS PINS, WHICH WAS FOUND BEFORE IT SHIPPED.
 *
 * openConversation ran normalizePhone over every address. That was right while
 * every channel carried a phone number, and silently destructive the moment
 * Instagram and Messenger arrived: both address people by a scoped id, which is
 * a long run of digits, and normalizePhone treats a run of digits as a number
 * to tidy up.
 *
 * Nothing would have thrown. The id stored on the way in would simply stop
 * matching the one looked up later, and the damage lands in one of two places:
 * a person's thread splits in two, or — far worse — two people's ids collapse
 * onto one key and a customer is shown somebody else's conversation.
 *
 * These assert the mangling directly, against the real function, so that if
 * anybody ever routes a scoped id back through it the reason is on the screen.
 */
describe('why a scoped id must not be normalised as a phone number', () => {
  it('loses the first two digits of a 12-digit id beginning 91', () => {
    expect(normalizePhone('911234567890')).toBe('1234567890');
  });

  it('loses the leading zero of an 11-digit id', () => {
    expect(normalizePhone('01234567890')).toBe('1234567890');
  });

  it('collapses two different ids onto the same key', () => {
    // The breach case: two Instagram users, one conversation.
    expect(normalizePhone('911234567890')).toBe(normalizePhone('1234567890'));
  });

  it('leaves a real Instagram-shaped id alone, which is why this hid', () => {
    // 17 digits falls through untouched, so the common case looks fine and the
    // failure only appears for ids of particular lengths — the worst shape a
    // bug can have.
    expect(normalizePhone('17841405793187218')).toBe('17841405793187218');
  });

  it('still normalises a real phone number, which is what it is for', () => {
    expect(normalizePhone('+91 93118 91503')).toBe('9311891503');
    expect(normalizePhone('09311891503')).toBe('9311891503');
  });
});
