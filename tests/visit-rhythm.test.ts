import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERVAL_DAYS, stageFor, visitRhythm } from '../src/modules/customers/visit-rhythm';

/**
 * The case for measuring each customer against their own clock rather than one
 * number for the whole book. Most of these tests are two customers on the same
 * day, where a fixed threshold gets one of them wrong.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-18T10:00:00Z');
/** A visit `n` days before NOW. */
const ago = (n: number) => new Date(NOW.getTime() - n * DAY);

/** Visits every `gap` days, most recent `since` days ago. */
const series = (gap: number, count: number, since = 0) =>
  Array.from({ length: count }, (_, i) => ago(since + i * gap));

describe('a customer’s own visit rhythm', () => {
  it('learns the gap from their history', () => {
    const r = visitRhythm(series(28, 6), NOW);
    expect(r.intervalDays).toBe(28);
    expect(r.basedOnIntervals).toBe(5);
  });

  it('is not thrown by one long absence', () => {
    // A monthly regular who spent a year abroad. The mean of these gaps is 98
    // days, which would say "on schedule" while they quietly stop coming.
    const visits = [ago(0), ago(30), ago(60), ago(90), ago(470), ago(500)];
    const r = visitRhythm(visits, NOW);
    expect(r.intervalDays).toBe(30);
  });

  it('refuses to call two visits a rhythm', () => {
    // One interval is a coincidence — it might be a fringe trim a week after a
    // colour. Saying "their cycle is 7 days" from that is worse than admitting
    // we do not know.
    const r = visitRhythm([ago(0), ago(7)], NOW);
    expect(r.intervalDays).toBeNull();
    expect(r.basedOnIntervals).toBe(1);
  });

  it('falls back to the salon default until a rhythm is earned, and says so', () => {
    const r = visitRhythm([ago(50), ago(57)], NOW);
    expect(r.intervalDays).toBeNull();
    // Still usable: the ratio is measured against the default.
    expect(r.overdueRatio).toBeCloseTo(50 / DEFAULT_INTERVAL_DAYS, 2);
  });

  it('follows a change of habit instead of averaging it away', () => {
    // Was every 90 days, has been every 30 for the last several visits. Only
    // the recent window counts, so the newer habit wins.
    const visits = [ago(0), ago(30), ago(60), ago(90), ago(120), ago(150), ago(240), ago(330), ago(420)];
    expect(visitRhythm(visits, NOW).intervalDays).toBe(30);
  });

  it('treats two bills in one afternoon as one visit', () => {
    // A service and a retail product on separate invoices would otherwise
    // inject a zero-day gap and drag the median towards nothing.
    const sameDay = [ago(0), ago(0), ago(28), ago(56), ago(84)];
    expect(visitRhythm(sameDay, NOW).intervalDays).toBe(28);
  });

  it('predicts the next visit on their clock, not the calendar’s', () => {
    const r = visitRhythm(series(21, 5), NOW);
    expect(r.intervalDays).toBe(21);
    // Last visit was today, so they are due in 21 days.
    expect(Math.round((r.expectedNextVisitAt!.getTime() - NOW.getTime()) / DAY)).toBe(21);
  });
});

describe('the same 45 days, two different customers', () => {
  // The whole point. A fixed "45 days = lapsed" rule gets one of these wrong.
  const threeWeekly = visitRhythm(series(21, 6, 45), NOW);
  const sixMonthly = visitRhythm(series(180, 5, 45), NOW);

  it('flags the three-weekly customer as at risk', () => {
    expect(threeWeekly.intervalDays).toBe(21);
    // 45 days is 2.1x their cycle — well past due, not yet a write-off.
    expect(threeWeekly.stage).toBe('AT_RISK');
  });

  it('leaves the twice-a-year customer alone', () => {
    expect(sixMonthly.intervalDays).toBe(180);
    expect(sixMonthly.stage).toBe('ACTIVE'); // 45 / 180 = 0.25x — nowhere near due
  });

  it('is the same day for both, and two different answers', () => {
    // The sentence this whole module exists for.
    expect(threeWeekly.stage).not.toBe(sixMonthly.stage);
  });
});

describe('the ladder', () => {
  const at = (ratio: number) => stageFor({ visits: 5, daysSince: Math.round(ratio * 30), ratio });

  it('climbs in the order a customer travels', () => {
    expect(at(0.5)).toBe('ACTIVE');
    expect(at(0.9)).toBe('DUE_SOON');
    expect(at(1.1)).toBe('DUE');
    expect(at(1.3)).toBe('OVERDUE');
    expect(at(1.8)).toBe('AT_RISK');
    expect(at(3.0)).toBe('LAPSED');
  });

  it('keeps the first visit out of the ratio ladder entirely', () => {
    // First-to-second conversion is the number that decides whether a salon
    // grows, and one visit gives no interval to measure against.
    expect(stageFor({ visits: 1, daysSince: 10, ratio: 0.2 })).toBe('NEW');
    expect(stageFor({ visits: 1, daysSince: 60, ratio: 1.3 })).toBe('ONE_TIME');
  });

  it('calls a year away dormant whatever their cycle was', () => {
    // A twice-a-year customer at 400 days is 2.2x their cycle, which would
    // read as "at risk". A year is a year.
    expect(stageFor({ visits: 6, daysSince: 400, ratio: 2.2 })).toBe('DORMANT');
  });

  it('says never visited rather than guessing', () => {
    expect(visitRhythm([], NOW).stage).toBe('NEVER_VISITED');
    expect(visitRhythm([], NOW).expectedNextVisitAt).toBeNull();
  });
});

describe('what the salon would actually do with it', () => {
  it('separates the new customer worth chasing from the one who never returned', () => {
    expect(visitRhythm([ago(10)], NOW).stage).toBe('NEW');
    expect(visitRhythm([ago(90)], NOW).stage).toBe('ONE_TIME');
  });

  it('finds the regular who is drifting before they are gone', () => {
    // Every 35 days, now 55 days out: 1.57x. Nothing about "45 days" would
    // catch this at the right moment for this person.
    const drifting = visitRhythm(series(35, 6, 55), NOW);
    expect(drifting.stage).toBe('AT_RISK');
    expect(drifting.overdueRatio).toBeGreaterThan(1.5);
  });

  it('does not message someone who was in last week', () => {
    expect(visitRhythm(series(30, 6, 7), NOW).stage).toBe('ACTIVE');
  });
});
