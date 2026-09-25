import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLocalDateTime } from '../src/core/dates';
import { localDateTime } from '../src/core/validators';

/**
 * THE BUG, AS THE SALON EXPERIENCED IT.
 *
 * "I set 11:50 today and it went out at 5 pm."
 *
 * `<input type="datetime-local">` sends "2026-09-25T11:50" with no timezone on
 * it. `new Date(...)` reads such a string in the SERVER's timezone, and the
 * server is a container running UTC — so 11:50 became 11:50Z, which is 17:20
 * in Kolkata. Five and a half hours late, every time, with nothing reporting a
 * fault, because 11:50 UTC is a perfectly valid instant and nothing downstream
 * can tell it was not the one meant.
 */
const TYPED = '2026-09-25T11:50';

const ist = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

describe('a time somebody typed into the app', () => {
  it('is read in the salon’s clock, not the server’s', () => {
    // The regression test for the reported failure.
    expect(parseLocalDateTime(TYPED).toISOString()).toBe('2026-09-25T06:20:00.000Z');
    expect(ist(parseLocalDateTime(TYPED))).toContain('11:50');
  });

  it('is exactly what the old behaviour got wrong', () => {
    // Left as evidence of the size of the drift, so nobody "simplifies" this
    // back to new Date() without seeing what it costs.
    const broken = new Date(`${TYPED}Z`); // what the server used to store
    const fixed = parseLocalDateTime(TYPED);
    expect((broken.getTime() - fixed.getTime()) / 3_600_000).toBe(5.5);
    expect(ist(broken)).toContain('17:20');
  });

  it('does not second-guess a value that already carries a timezone', () => {
    // An API client doing the right thing must be respected as sent.
    expect(parseLocalDateTime('2026-09-25T11:50:00Z').toISOString()).toBe('2026-09-25T11:50:00.000Z');
    expect(parseLocalDateTime('2026-09-25T11:50:00+05:30').toISOString()).toBe('2026-09-25T06:20:00.000Z');
    expect(parseLocalDateTime('2026-09-25T11:50:00+0530').toISOString()).toBe('2026-09-25T06:20:00.000Z');
  });

  it('handles seconds, which some browsers include and some do not', () => {
    expect(parseLocalDateTime('2026-09-25T11:50:30').toISOString()).toBe('2026-09-25T06:20:30.000Z');
  });

  it('is midnight in the salon, not midnight in London', () => {
    const midnight = parseLocalDateTime('2026-09-25T00:00');
    expect(ist(midnight)).toContain('00:00');
    // Which is the previous evening in UTC — the case a naive reading inverts.
    expect(midnight.toISOString()).toBe('2026-09-24T18:30:00.000Z');
  });
});

describe('the schema the routes use', () => {
  it('parses a typed time into the right instant', () => {
    const parsed = localDateTime.parse(TYPED);
    expect(parsed.toISOString()).toBe('2026-09-25T06:20:00.000Z');
  });

  it('passes a Date straight through', () => {
    const date = new Date('2026-09-25T06:20:00.000Z');
    expect(localDateTime.parse(date)).toEqual(date);
  });

  it('refuses something that is not a time at all', () => {
    expect(() => localDateTime.parse('not a date')).toThrow();
  });
});

describe('the recurring sweeps', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'src/jobs/worker.ts'), 'utf8');

  it('runs every schedule on the salon’s clock', () => {
    // Without a timezone, node-cron uses the container's — so "09:00
    // birthdays" went out at half past two in the afternoon in India.
    const schedules = SOURCE.match(/cron\.schedule\(/g) ?? [];
    const withTimezone = SOURCE.match(/cron\.schedule\([\s\S]*?\), opts\)/g) ?? [];
    expect(schedules.length).toBeGreaterThan(10);
    expect(withTimezone).toHaveLength(schedules.length);
  });

  it('takes the timezone from configuration rather than hard-coding it', () => {
    expect(SOURCE).toContain('timezone: env.DEFAULT_TIMEZONE');
  });
});
