import { describe, expect, it } from 'vitest';
import { fillDays, rangeOf, readIsMeasurable } from '../src/modules/marketing/journey-analytics.service';
import { dateKey } from '../src/core/dates';

/**
 * THE AUTOMATION THAT STOPPED, AND NOBODY NOTICED.
 *
 * An automation fails differently from a campaign. A campaign fails loudly:
 * somebody pressed send, watched the screen, and saw the numbers. An
 * automation fails by going quiet — and every total it has keeps looking
 * healthy, because the handful of messages it did manage to send arrived
 * perfectly.
 *
 * Both functions here exist to stop the app saying something confident about
 * data it does not have. They are tested apart from the database queries that
 * use them because that is where the reasoning lives: the queries only count.
 */

describe('a gap in the chart has to be drawn as a gap', () => {
  const from = new Date('2026-03-01T00:00:00+05:30');
  const to = new Date('2026-03-10T23:59:59+05:30');

  it('fills the silent days with zero rather than skipping them', () => {
    // Fired on the 1st, then nothing for a week, then once on the 10th.
    const counts = new Map([
      [dateKey(new Date('2026-03-01T10:00:00+05:30')), 4],
      [dateKey(new Date('2026-03-10T10:00:00+05:30')), 1],
    ]);

    const series = fillDays(from, to, counts);

    expect(series).toHaveLength(10);
    expect(series[0]).toEqual({ date: dateKey(from), runs: 4 });
    expect(series.at(-1)).toEqual({ date: dateKey(to), runs: 1 });

    // The eight days in between are the whole point. Without them the chart
    // draws one bar, a gap, one bar — and eight days of silence look like the
    // x-axis simply not having those dates, which is not what happened.
    expect(series.slice(1, 9).every((point) => point.runs === 0)).toBe(true);
    expect(series.reduce((n, p) => n + p.runs, 0)).toBe(5);
  });

  it('runs one point per day, in order, with no repeats', () => {
    const series = fillDays(from, to, new Map());
    const dates = series.map((p) => p.date);

    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it('counts days in the salon\u2019s calendar, not the server\u2019s', () => {
    // The bug this caught, before anyone saw it: the ten IST days above span
    // ELEVEN UTC days, and a dayjs loop over the raw timestamps duly produced
    // eleven buckets \u2014 the first being 28 February, a day that is not in the
    // period. Every one of these charts would have opened with a phantom empty
    // day on a server running UTC, which is every server this app runs on.
    const series = fillDays(from, to, new Map());
    expect(series[0]!.date).toBe('2026-03-01');
    expect(series.at(-1)!.date).toBe('2026-03-10');
  });
});

describe('a read rate is only shown where a read can be observed', () => {
  it('is measurable on WhatsApp, which reports blue ticks', () => {
    expect(readIsMeasurable(['WHATSAPP'])).toBe(true);
  });

  it('is not measurable on SMS, so the stage is dropped rather than zeroed', () => {
    // The failure this prevents: "Read 0" under an SMS automation, which a
    // salon owner reads as nobody opening their messages. No operator on earth
    // reports whether an SMS was read.
    expect(readIsMeasurable(['SMS'])).toBe(false);
  });

  it('is not measurable once one channel in the mix cannot report it', () => {
    // A WhatsApp journey with an SMS fallback. Counting reads over both would
    // divide by messages that can never contribute one, so the rate would sag
    // every time the fallback fired — movement caused by the fallback, not by
    // readers.
    expect(readIsMeasurable(['WHATSAPP', 'SMS'])).toBe(false);
  });

  it('is not measurable when nothing has been sent at all', () => {
    // Nothing sent is not nothing read. An automation that has never fired
    // must not report a rate of any kind.
    expect(readIsMeasurable([])).toBe(false);
  });
});

describe('the period a chart is asked for is the period it can honestly draw', () => {
  it('defaults to the last 90 days', () => {
    const { from, to } = rangeOf({ to: new Date('2026-03-31T12:00:00+05:30') });
    expect(dateKey(to)).toBe('2026-03-31');
    expect(fillDays(from, to, new Map())).toHaveLength(91);
  });

  it('clamps a range nobody could read, and clamps the dates with it', () => {
    // 3,650 points would be serialised to the browser and drawn as bars a
    // fraction of a pixel wide. The clamp lives on the RANGE rather than on
    // the series, so the dates the page prints are the dates it plots — a
    // header reading "2016 to today" over a chart starting in 2025 is worse
    // than a shorter chart.
    const { from, to } = rangeOf({
      from: new Date('2016-01-01T00:00:00+05:30'),
      to: new Date('2026-03-31T12:00:00+05:30'),
    });

    const series = fillDays(from, to, new Map());
    expect(series).toHaveLength(400);
    expect(series[0]!.date).toBe(dateKey(from));
    expect(series.at(-1)!.date).toBe(dateKey(to));
  });
});
