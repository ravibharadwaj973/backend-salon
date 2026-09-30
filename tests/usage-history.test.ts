import { describe, expect, it } from 'vitest';
import { usageHistoryQuery } from '../src/modules/quotas/quota.schema';
import { ALL_METERS, METER_LABELS, meterFor, periodFor } from '../src/modules/quotas/quota.service';

/**
 * THE MONTH-WISE USAGE SCREEN.
 *
 * The aggregation itself needs a database, so what is pinned here is the part
 * that decides which month a send belongs to — and that is where this would go
 * wrong silently. A total that lands in the wrong month is not an error anybody
 * sees; it is a screen that quietly disagrees with itself.
 */

describe('which month a send is counted in', () => {
  it('uses the salon’s own timezone, not UTC', () => {
    /**
     * 1am on the 1st of October in India is 7:30pm on 30 September in UTC.
     *
     * Computed in UTC, a Diwali campaign sent just after midnight would be
     * counted against September — and the history screen would disagree with
     * the current-month card on the same page, which is the bug report nobody
     * can reproduce because it only happens for five and a half hours a month.
     */
    const justAfterMidnightIST = new Date('2026-09-30T19:00:00.000Z');
    const period = periodFor(justAfterMidnightIST, 'Asia/Kolkata');

    expect(period.label).toBe('October 2026');
  });

  it('puts the last moment of a month in that month', () => {
    // 11:59pm on 31 October IST is still October, and is 6:29pm UTC.
    const lastMomentIST = new Date('2026-10-31T18:29:00.000Z');
    expect(periodFor(lastMomentIST, 'Asia/Kolkata').label).toBe('October 2026');
  });

  it('gives a period that starts before it ends, every month of the year', () => {
    for (let month = 0; month < 12; month += 1) {
      const at = new Date(Date.UTC(2026, month, 15, 12, 0, 0));
      const period = periodFor(at, 'Asia/Kolkata');
      expect(period.start.getTime()).toBeLessThan(period.end.getTime());
    }
  });
});

describe('what each channel is counted as', () => {
  it('separates WhatsApp marketing from utility, because they cost differently', () => {
    expect(meterFor('WHATSAPP', 'MARKETING')).toBe('WA_MARKETING');
    expect(meterFor('WHATSAPP', 'UTILITY')).toBe('WA_UTILITY');
    expect(meterFor('WHATSAPP', 'AUTHENTICATION')).toBe('WA_AUTHENTICATION');
  });

  it('counts a reply to a customer on its own meter', () => {
    // Not utility, though Meta charges both the same from 1 October 2026: the
    // salon needs to see what the assistant costs separately from what its
    // reminders cost, and neither should be able to exhaust the other.
    expect(meterFor('WHATSAPP', 'SERVICE')).toBe('WA_SERVICE');
  });

  it('counts SMS and email as themselves', () => {
    expect(meterFor('SMS')).toBe('SMS');
    expect(meterFor('EMAIL')).toBe('EMAIL');
  });

  it('counts in-app notices as nothing, because they cost nothing', () => {
    expect(meterFor('IN_APP')).toBeNull();
  });

  it('has a label for every meter the screen will draw a column for', () => {
    // A missing label renders as "undefined" in a table header, which looks
    // like a broken page rather than a missing string.
    for (const meter of ALL_METERS) {
      expect(METER_LABELS[meter]).toBeTruthy();
    }
  });
});

describe('how far back the screen may ask', () => {
  it('defaults to nothing and lets the service choose', () => {
    expect(usageHistoryQuery.parse({})).toEqual({});
  });

  it('accepts a number that arrived as text from a query string', () => {
    // Everything in a query string is a string, and the service subtracts from
    // this value. `"12" - 1` is the bug that produces an empty screen.
    expect(usageHistoryQuery.parse({ months: '6' })).toEqual({ months: 6 });
  });

  it('refuses a request for more than two years', () => {
    // Told no by the validator rather than quietly clamped, so a client asking
    // for 500 months learns it asked for something silly.
    expect(() => usageHistoryQuery.parse({ months: '500' })).toThrow();
  });

  it('refuses zero, a negative, and a fraction of a month', () => {
    for (const months of ['0', '-3', '1.5']) {
      expect(() => usageHistoryQuery.parse({ months })).toThrow();
    }
  });
});
