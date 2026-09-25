import { describe, expect, it } from 'vitest';
import { dayInRange } from '../src/modules/analytics/analytics.service';
import { dateKey } from '../src/core/dates';

/**
 * A day before the salon existed renders as zeros, and zeros look exactly like
 * a terrible day. An owner scrolling back through the calendar would meet a
 * wall of empty dashboards with no way to tell "we took nothing" from "we were
 * not open yet" — so the calendar stops at the day the account was created.
 *
 * Every assertion here goes through dateKey rather than toISOString, and that
 * is not fussiness. The app runs in the salon's own timezone: 23:00 UTC is half
 * past four the NEXT morning in Kolkata, so a UTC rendering of these dates
 * disagrees with the app by a whole day for five and a half hours out of every
 * twenty-four. The first draft of this file asserted in UTC and failed, which
 * is exactly the confusion an Indian salon would have hit at half past six in
 * the evening.
 */
const CREATED = new Date('2026-01-25T09:30:00Z'); // 3pm IST, 25 January
const NOW = new Date('2026-03-10T14:00:00Z'); // 7:30pm IST, 10 March

describe('which day the dashboard can answer for', () => {
  it('answers for a day inside the account’s life', () => {
    const asked = new Date('2026-02-14T06:00:00Z');
    const result = dayInRange(asked, CREATED, NOW);
    expect(result.clamped).toBe(false);
    expect(result.date).toBe(asked);
  });

  it('answers for the day the account was created', () => {
    // The boundary itself is inside, not outside. An off-by-one here hides the
    // salon's own first day of trading.
    const result = dayInRange(new Date('2026-01-25T12:30:00Z'), CREATED, NOW);
    expect(result.clamped).toBe(false);
  });

  it('refuses the day before the account existed', () => {
    // The example as reported: created on 25 January, so the 24th is not a day
    // this salon can be asked about.
    const result = dayInRange(new Date('2026-01-24T06:00:00Z'), CREATED, NOW);
    expect(result.clamped).toBe(true);
    expect(dateKey(result.date)).toBe('2026-01-25');
  });

  it('refuses days well before, landing on the first day either way', () => {
    for (const day of ['2026-01-23', '2025-12-01', '2020-06-15']) {
      const result = dayInRange(new Date(`${day}T06:00:00Z`), CREATED, NOW);
      expect(result.clamped, day).toBe(true);
      expect(dateKey(result.date), day).toBe('2026-01-25');
    }
  });

  it('ignores the time of day the account was created at', () => {
    // Created at 3pm. A bill rung up at 10am that same morning still belongs to
    // that day, and comparing timestamps rather than days would hide it.
    const result = dayInRange(new Date('2026-01-25T04:30:00Z'), CREATED, NOW);
    expect(result.clamped).toBe(false);
  });

  it('refuses a day that has not happened', () => {
    // There are no takings tomorrow. Shown as zeros it reads as a disaster.
    const result = dayInRange(new Date('2026-03-11T06:00:00Z'), CREATED, NOW);
    expect(result.clamped).toBe(true);
    expect(result.date).toBe(NOW);
  });

  it('allows the rest of today, up to the salon’s own midnight', () => {
    // 11pm IST is still today's takings. Treating "later than now" as the
    // future would make the dashboard unreachable for most of the evening.
    const lateTonight = new Date('2026-03-10T17:30:00Z'); // 11pm IST
    expect(dateKey(lateTonight)).toBe('2026-03-10');
    expect(dayInRange(lateTonight, CREATED, NOW).clamped).toBe(false);
  });

  it('counts the day by the salon’s clock, not UTC', () => {
    // 23:00 UTC on the 10th is 4:30am on the 11th in Kolkata — tomorrow, and
    // correctly refused. This is the case that makes dateKey mandatory here.
    const afterMidnightIst = new Date('2026-03-10T23:00:00Z');
    expect(dateKey(afterMidnightIst)).toBe('2026-03-11');
    expect(dayInRange(afterMidnightIst, CREATED, NOW).clamped).toBe(true);
  });

  it('handles an account created today, where there is exactly one day', () => {
    // A salon that signed up this morning: every arrow is disabled and the only
    // day available is the one they are looking at.
    const result = dayInRange(new Date('2026-03-09T06:00:00Z'), NOW, NOW);
    expect(result.clamped).toBe(true);
    expect(dateKey(result.date)).toBe('2026-03-10');
  });
});
