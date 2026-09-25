import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMAT,
  MAX_LENGTH,
  counterKey,
  formatNumber,
  isValidFormat,
  parseFormat,
  previewNumbers,
  validateFormat,
  type SeriesFormat,
} from '../src/modules/billing/invoice-series';

/**
 * Rule 46(b) of the CGST Rules is not advisory. A bill number over sixteen
 * characters, or carrying a character outside letters/digits/"-"/"/", is a
 * defective tax invoice — and the consequence lands on the CUSTOMER, whose
 * input-credit claim is what breaks, months later, through no fault of theirs.
 *
 * Nothing checked this before. The shipped default sits at fifteen characters,
 * one short of the limit, reachable by adding a single letter to a prefix.
 */

const fmt = (over: Partial<SeriesFormat> = {}): SeriesFormat => ({ ...DEFAULT_FORMAT, ...over });
const APRIL = new Date('2026-04-10T10:00:00Z');
const MARCH = new Date('2026-03-31T10:00:00Z');

describe('what a bill number may look like', () => {
  it('builds the shape the app has always used', () => {
    expect(formatNumber(fmt(), 1, APRIL)).toBe('INV/26-27/00001');
  });

  it('leaves the shipped default one character inside the legal limit', () => {
    // Documented rather than assumed: the moment this stops being true the
    // default itself is illegal, and that should fail here, not at a till.
    expect(formatNumber(fmt(), 99_999, APRIL)).toHaveLength(15);
    expect(isValidFormat(fmt())).toBe(true);
  });

  it('honours the financial year rather than the calendar year', () => {
    // 31 March is still last year's books; 10 April is the new one. A salon
    // whose March bills are filed under the wrong year has filed wrongly.
    expect(formatNumber(fmt(), 7, MARCH)).toBe('INV/25-26/00007');
    expect(formatNumber(fmt(), 7, APRIL)).toBe('INV/26-27/00007');
  });

  it('lets a business carry on from where its old system stopped', () => {
    // The whole reason startFrom exists. A salon at bill 1,247 cannot be told
    // to begin again at 1 — that is a duplicate of a bill they already issued.
    expect(previewNumbers(fmt({ startFrom: 1247 }), APRIL)[0]).toBe('INV/26-27/01247');
  });

  it('allows the shapes salons actually use', () => {
    expect(formatNumber(fmt({ prefix: 'GC', separator: '-', includeFinancialYear: false, padding: 3 }), 42, APRIL)).toBe('GC-042');
    expect(formatNumber(fmt({ separator: '', includeFinancialYear: false, padding: 4 }), 42, APRIL)).toBe('INV0042');
  });
});

describe('refusing a format that would make bills defective', () => {
  it('refuses a prefix with an illegal character', () => {
    for (const prefix of ['INV 1', 'INV#', 'A&B', 'INV.']) {
      const problems = validateFormat(fmt({ prefix }));
      expect(problems.map((p) => p.field), prefix).toContain('prefix');
    }
  });

  it('accepts the three separators the rule allows and nothing else', () => {
    expect(isValidFormat(fmt({ separator: '/' }))).toBe(true);
    expect(isValidFormat(fmt({ separator: '-' }))).toBe(true);
    expect(isValidFormat(fmt({ separator: '', includeFinancialYear: false }))).toBe(true);
  });

  it('refuses an empty prefix', () => {
    expect(validateFormat(fmt({ prefix: '   ' })).map((p) => p.field)).toContain('prefix');
  });

  it('refuses a format that is already too long at its first bill', () => {
    const wide = fmt({ prefix: 'SALON', padding: 6 });
    expect(formatNumber(wide, 1, APRIL)).toBe('SALON/26-27/000001');
    expect(validateFormat(wide, APRIL).map((p) => p.field)).toContain('length');
  });

  it('measures the WIDEST number the format can reach, not the next one', () => {
    // Padding makes every number the same length, so the only way a series
    // grows past its limit is by outgrowing the padding itself — which happens
    // to a continuous series and not to one that restarts each April. A format
    // that is legal at 00001 and illegal at 100000 breaks in October, and the
    // point of checking now is to not find out then.
    const tight = fmt({ prefix: 'ABCD', padding: 5, reset: 'NEVER' });
    expect(formatNumber(tight, 1, APRIL)).toHaveLength(MAX_LENGTH);
    expect(formatNumber(tight, 100_000, APRIL).length).toBeGreaterThan(MAX_LENGTH);
    expect(validateFormat(tight, APRIL).map((p) => p.field)).toContain('length');
  });

  it('says how long it would get and what to do about it', () => {
    // An error that only says "invalid" gets the same thing retyped.
    const problem = validateFormat(fmt({ prefix: 'LONGPREFIX', padding: 6 }), APRIL).find((p) => p.field === 'length');
    expect(problem?.message).toMatch(/16/);
    expect(problem?.message).toMatch(/Shorten the prefix/);
  });

  it('allows for an extra digit when the series never resets', () => {
    // A continuous series outgrows its padding; one that resets each April
    // does not. So the same format can be legal with yearly resets and not
    // without, and that has to be decided now rather than in year nine.
    const tight = fmt({ prefix: 'ABCD', padding: 5, includeFinancialYear: true });
    expect(isValidFormat({ ...tight, reset: 'FINANCIAL_YEAR' }, APRIL)).toBe(true);
    expect(isValidFormat({ ...tight, reset: 'NEVER' }, APRIL)).toBe(false);
  });

  it('reports every problem at once', () => {
    // An owner told about the prefix, then the padding, then the length saves
    // three times and trusts the screen less each time.
    const problems = validateFormat(fmt({ prefix: 'BAD PREFIX', padding: 99, startFrom: 0 }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('does not add a length complaint on top of a broken padding', () => {
    // A nonsense padding produces a nonsense length, and a second error about
    // it would send the owner chasing the wrong field.
    const problems = validateFormat(fmt({ padding: 0 }));
    expect(problems.map((p) => p.field)).toEqual(['padding']);
  });
});

describe('where a counter lives', () => {
  it('keys on the financial year when numbering restarts', () => {
    expect(counterKey(fmt({ reset: 'FINANCIAL_YEAR' }), APRIL)).toBe('26-27');
    expect(counterKey(fmt({ reset: 'FINANCIAL_YEAR' }), MARCH)).toBe('25-26');
  });

  it('uses one key for a series that never restarts', () => {
    // One row, so the count carries across April instead of starting again.
    expect(counterKey(fmt({ reset: 'NEVER' }), APRIL)).toBe('');
    expect(counterKey(fmt({ reset: 'NEVER' }), MARCH)).toBe('');
  });

  it('changes key exactly at the year boundary, so April cannot reuse March', () => {
    // The two keys differing is what makes the database's unique constraint
    // the thing that prevents a duplicate on 1 April, rather than our code
    // remembering to check.
    expect(counterKey(fmt(), MARCH)).not.toBe(counterKey(fmt(), APRIL));
  });
});

describe('reading a stored format back', () => {
  it('fills in anything missing rather than throwing', () => {
    // These live in a JSON settings blob, so a partial or older shape is not
    // an error condition — it is Tuesday.
    expect(parseFormat({})).toEqual(DEFAULT_FORMAT);
    expect(parseFormat(null)).toEqual(DEFAULT_FORMAT);
    expect(parseFormat({ prefix: 'GC' }).prefix).toBe('GC');
  });

  it('keeps an explicit empty separator', () => {
    // '' is a real choice and falsy, so the obvious `||` default would eat it.
    expect(parseFormat({ separator: '' }).separator).toBe('');
  });

  it('does not let a stored zero become the starting number', () => {
    expect(parseFormat({ startFrom: 0 }).startFrom).toBe(1);
  });
});
