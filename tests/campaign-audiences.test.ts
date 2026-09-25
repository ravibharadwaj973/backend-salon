import { describe, expect, it } from 'vitest';
import { AUDIENCES, audienceInfo, stateOf } from '../src/modules/marketing/campaign-audiences';

/**
 * A campaign's recipients are not one audience, they are six, and the six want
 * completely different things next. The rule that keeps them apart is that a
 * person lands in exactly ONE group — the furthest they got — because a person
 * listed in several would receive several follow-ups, including ones asking
 * whether they are still thinking about a visit they have already made.
 */
const who = (over: Partial<Parameters<typeof stateOf>[0]> = {}) =>
  stateOf({
    customerId: 'c1',
    refused: false,
    delivered: true,
    read: false,
    engaged: false,
    booked: false,
    visited: false,
    ...over,
  });

describe('which group a recipient is in', () => {
  it('sorts each recipient by the furthest they got', () => {
    expect(who({ refused: true, delivered: false })).toBe('NOT_DELIVERED');
    expect(who()).toBe('DELIVERED_NOT_READ');
    expect(who({ read: true })).toBe('READ_NOT_ENGAGED');
    expect(who({ read: true, engaged: true })).toBe('ENGAGED_NOT_BOOKED');
    expect(who({ read: true, engaged: true, booked: true })).toBe('BOOKED_NOT_VISITED');
    expect(who({ read: true, engaged: true, booked: true, visited: true })).toBe('VISITED');
  });

  it('puts somebody who did everything ONLY in the last group', () => {
    // The rule the whole design rests on. Listed in four groups, this customer
    // would get a "still thinking about it?" while sitting in the chair.
    const state = who({ read: true, engaged: true, booked: true, visited: true });
    expect(state).toBe('VISITED');
    expect(state).not.toBe('READ_NOT_ENGAGED');
  });

  it('counts somebody who visited without ever booking', () => {
    // Walk-ins exist. Somebody who got the message and turned up without an
    // appointment converted, and must not sit in "read, did nothing".
    expect(who({ read: true, booked: false, visited: true })).toBe('VISITED');
  });

  it('counts somebody who booked without the message being read', () => {
    // Read receipts can be off. A booking is a stronger signal than a blue
    // tick, and it must not be overridden by the absence of one.
    expect(who({ read: false, booked: true })).toBe('BOOKED_NOT_VISITED');
  });

  it('treats a click as engagement even with no read receipt recorded', () => {
    expect(who({ read: false, engaged: true })).toBe('ENGAGED_NOT_BOOKED');
  });

  it('never calls an undelivered message read', () => {
    // Nothing arrived, so nothing downstream of arriving can be claimed.
    expect(who({ refused: true, delivered: false, read: false, engaged: false })).toBe('NOT_DELIVERED');
  });

  /**
   * "It was refused" and "we have not been told" are opposite findings with
   * opposite fixes, and they were one group. That group's advice read "usually
   * a wrong number — fix it on their profile", so when the delivery webhook was
   * not wired up the salon was sent to correct four perfectly good phone
   * numbers while the real fault sat untouched.
   */
  it('separates a refusal from silence', () => {
    expect(who({ refused: true, delivered: false })).toBe('NOT_DELIVERED');
    expect(who({ refused: false, delivered: false })).toBe('AWAITING_RECEIPT');
  });

  it('does not blame the customer’s number for an absence of news', () => {
    const silent = audienceInfo(who({ refused: false, delivered: false }));
    expect(silent?.meaning).toMatch(/not a failure|absence of news/);
    expect(silent?.suggestion).toMatch(/Do not change/);
    // And points at the thing that is actually likely to be broken.
    expect(silent?.suggestion).toMatch(/webhook/);
  });
});

describe('what each group is told to do about it', () => {
  it('describes all seven', () => {
    expect(AUDIENCES).toHaveLength(7);
    for (const info of AUDIENCES) {
      expect(info.label, info.audience).toBeTruthy();
      expect(info.meaning, info.audience).toBeTruthy();
      expect(info.suggestion, info.audience).toBeTruthy();
    }
  });

  it('refuses to offer a follow-up where a message is the wrong answer', () => {
    // Selling to somebody who has already booked reads as having forgotten
    // they said yes; re-sending to a dead number fails the same way twice.
    expect(audienceInfo('BOOKED_NOT_VISITED')?.followUpSensible).toBe(false);
    expect(audienceInfo('VISITED')?.followUpSensible).toBe(false);
    expect(audienceInfo('NOT_DELIVERED')?.followUpSensible).toBe(false);
    // Nor to people we simply have not heard about: nothing is known to be
    // wrong, so there is nothing to follow up on yet.
    expect(audienceInfo('AWAITING_RECEIPT')?.followUpSensible).toBe(false);
  });

  it('offers a follow-up to the three groups worth chasing', () => {
    expect(audienceInfo('DELIVERED_NOT_READ')?.followUpSensible).toBe(true);
    expect(audienceInfo('READ_NOT_ENGAGED')?.followUpSensible).toBe(true);
    expect(audienceInfo('ENGAGED_NOT_BOOKED')?.followUpSensible).toBe(true);
  });

  it('does not claim a blue tick proves somebody chose not to come', () => {
    // A salon acting on "they saw it and said no" behaves differently, and
    // worse, than one acting on "we do not know whether this landed".
    const unread = audienceInfo('DELIVERED_NOT_READ');
    expect(unread?.meaning).toMatch(/weaker evidence|switched off/);
    expect(unread?.suggestion).toMatch(/Do not assume/);
  });

  it('tells the salon to fix the number rather than resend to a dead one', () => {
    expect(audienceInfo('NOT_DELIVERED')?.suggestion).toMatch(/Fix the number/);
  });

  it('returns nothing for a group it has no entry for', () => {
    expect(audienceInfo('NONSENSE' as never)).toBeNull();
  });
});
