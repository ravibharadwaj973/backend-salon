import { describe, expect, it } from 'vitest';
import { searchClause } from '../src/modules/customers/customer.service';

/**
 * The customer list's search box.
 *
 * These exist because the bug they cover was invisible from the outside: the
 * query ran, returned rows, and was wrong. Searching "priya" built
 * `phone LIKE '%%'` — because normalizePhone strips non-digits and left the
 * empty string — which matches every row in Postgres, so the OR matched
 * everything and the filter silently did nothing.
 */

/** Pull the LIKE patterns out of a where clause, whatever its shape. */
function patterns(clause: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        const contains = (value as { contains?: unknown }).contains;
        if (typeof contains === 'string') found.push(contains);
        walk(value);
      }
    }
  };
  walk(clause);
  return found;
}

describe('customer search', () => {
  it('never searches for an empty string', () => {
    // The whole bug in one assertion. An empty `contains` matches every row.
    for (const q of ['priya', 'sony', 'a', 'Priya Sharma', 'C-00003', '  ']) {
      expect(patterns(searchClause(q))).not.toContain('');
    }
  });

  it('matches a full name spanning first and last name', () => {
    const clause = searchClause('Priya Sharma') as { AND?: unknown[] };
    // One group per word, ANDed — "Priya" and "Sharma" each have to appear
    // somewhere, which is what lets a name split across two columns match.
    expect(clause.AND).toHaveLength(2);
    expect(patterns(clause)).toEqual(
      expect.arrayContaining(['Priya', 'Sharma']),
    );
  });

  it('does not care what order the words come in', () => {
    expect(patterns(searchClause('sharma priya')).sort()).toEqual(
      patterns(searchClause('priya sharma')).sort(),
    );
  });

  it('searches phone numbers when the query is a number', () => {
    const clause = searchClause('+91 93153 41503') as { OR?: unknown[] };
    expect(clause.OR).toBeDefined();
    // Normalised to the local 10 digits, so the stored form matches however
    // the receptionist typed it.
    expect(patterns(clause)).toContain('9315341503');
  });

  it('treats a customer code as text, not as a phone number', () => {
    // "C-00003" has five digits. Counting digits alone would send this down
    // the phone branch and find nobody.
    const clause = searchClause('C-00003') as { AND?: unknown[]; OR?: unknown[] };
    expect(clause.AND).toBeDefined();
    expect(clause.OR).toBeUndefined();
    expect(patterns(clause)).toContain('C-00003');
  });

  it('still finds a code typed without its prefix', () => {
    expect(patterns(searchClause('00003'))).toContain('00003');
  });

  it('returns no constraint for an empty query', () => {
    expect(searchClause('')).toEqual({});
    expect(searchClause('   ')).toEqual({});
    expect(searchClause(undefined)).toEqual({});
  });
});
