import { describe, expect, it } from 'vitest';
import {
  BURST_WINDOW_MINUTES,
  MAX_REPLIES_PER_BURST,
  MAX_REPLIES_PER_DAY,
  replyCeiling,
} from '../src/modules/messaging/reply-limits';

/**
 * THE LOOP GUARD THAT WAS STOPPING CONVERSATIONS.
 *
 * It was ten replies per customer per day, and what it caught was a customer
 * asking ordinary questions:
 *
 *   4:43  "do we have empty slot for appointment?"  → the handoff
 *   4:44  "Do you have the hair spa service"        → nothing
 *   4:45  "Hello again this stop answering"         → nothing
 *
 * Nothing was looping. So these pin both halves of the shape: a loop must still
 * be stopped quickly, and a person must be able to hold a long conversation
 * without ever meeting a limit.
 */

const under = { inBurst: 0, today: 0 };

describe('an ordinary conversation', () => {
  it('is never stopped', () => {
    expect(replyCeiling(under)).toBeNull();
  });

  it('is not stopped by a booking, which costs three replies of its own', () => {
    // Which location → here is a time → done. Three replies for one booking,
    // and the old ceiling of ten was barely three of those.
    expect(replyCeiling({ inBurst: 3, today: 3 })).toBeNull();
  });

  it('is not stopped by a keen customer working through the whole menu', () => {
    /**
     * The case that killed the first two attempts. Hello, what do you offer,
     * how much, which location, what is free, anything else, yes, thank you —
     * eight replies from somebody typing quickly. A daily ten stopped it, and so
     * did eight-in-ten-minutes. Spread over an afternoon, nothing may.
     */
    expect(replyCeiling({ inBurst: 2, today: 8 })).toBeNull();
    expect(replyCeiling({ inBurst: 3, today: 25 })).toBeNull();
  });

  it('is not stopped by a customer who has been in touch all day', () => {
    // The case that actually happened. Twelve replies over an afternoon is a
    // good customer, not a runaway.
    expect(replyCeiling({ inBurst: 2, today: 12 })).toBeNull();
  });

  it('is not stopped one reply short of either limit', () => {
    expect(replyCeiling({ inBurst: MAX_REPLIES_PER_BURST - 1, today: 0 })).toBeNull();
    expect(replyCeiling({ inBurst: 0, today: MAX_REPLIES_PER_DAY - 1 })).toBeNull();
  });
});

describe('a runaway, answering within seconds', () => {
  it('is stopped by the burst window', () => {
    expect(replyCeiling({ inBurst: MAX_REPLIES_PER_BURST, today: 9 })?.which).toBe('burst');
  });

  it('is told once, at the limit', () => {
    expect(replyCeiling({ inBurst: MAX_REPLIES_PER_BURST, today: 9 })?.action).toBe('HAND_OVER');
  });

  it('is met with silence after that, which is what ends it', () => {
    /**
     * The other side speaks only because we did. Handing over every time would
     * feed the loop a message per cycle forever; going quiet stops it.
     */
    for (const over of [1, 2, 50]) {
      expect(replyCeiling({ inBurst: MAX_REPLIES_PER_BURST + over, today: 99 })?.action).toBe('SILENT');
    }
  });

  it('is caught by the burst window before the daily one, when both are over', () => {
    // Which is the useful report: a conversation going at four a minute is a
    // different problem from one that has been going all day.
    expect(replyCeiling({ inBurst: 20, today: 100 })?.which).toBe('burst');
  });
});

describe('a slow runaway that stays under the burst window', () => {
  it('is stopped by the daily backstop', () => {
    // One message every few minutes, driven by something on a schedule rather
    // than by our own replies, never reaches eight in ten minutes.
    expect(replyCeiling({ inBurst: 2, today: MAX_REPLIES_PER_DAY })?.which).toBe('daily');
  });

  it('is told once, then met with silence', () => {
    expect(replyCeiling({ inBurst: 2, today: MAX_REPLIES_PER_DAY })?.action).toBe('HAND_OVER');
    expect(replyCeiling({ inBurst: 2, today: MAX_REPLIES_PER_DAY + 1 })?.action).toBe('SILENT');
  });
});

describe('the numbers themselves', () => {
  it('keeps the burst window short enough that only a machine can fill it', () => {
    /**
     * The count matters less than the window it sits in. Six replies in two
     * minutes means a message every twenty seconds WHILE READING ours; widen the
     * window and it starts catching people who simply type fast, which is how
     * the first two versions of this went wrong.
     */
    expect(BURST_WINDOW_MINUTES).toBeLessThanOrEqual(3);
    expect(MAX_REPLIES_PER_BURST).toBeGreaterThanOrEqual(5);
  });

  it('keeps the daily figure generous enough that a customer never meets it', () => {
    // It is no longer the limit that protects anything in the common case, so
    // it must not be the one that fires.
    expect(MAX_REPLIES_PER_DAY).toBeGreaterThanOrEqual(30);
  });

  it('cannot have a daily figure below the burst one, which would make it dead code', () => {
    expect(MAX_REPLIES_PER_DAY).toBeGreaterThan(MAX_REPLIES_PER_BURST);
  });
});
