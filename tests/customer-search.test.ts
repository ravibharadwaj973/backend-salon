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

/**
 * THE SEARCH THAT SAID "NO CUSTOMER MATCHES THAT" ABOUT A CUSTOMER IT HAD.
 *
 * Typing "931" into the customer search returned nothing, in a book with
 * 93118 91503 and 93153 41503 in it. Three digits fell under a four-digit
 * threshold, so the query ran as a TEXT search instead, compared "931" against
 * names, emails and codes, and matched none of them.
 *
 * Nobody types a whole phone number to find somebody. They type the first few
 * digits off a phone screen and stop when the name appears.
 */
describe('a partial phone number finds the customer', () => {
  it('searches phones from two digits up', () => {
    for (const q of ['93', '931', '9311', '93118']) {
      const clause = searchClause(q) as { OR?: unknown[] };
      expect(clause.OR, `"${q}" should search phone numbers`).toBeDefined();
      expect(patterns(clause), `"${q}"`).toContain(q);
    }
  });

  it('still refuses to treat a customer code as a phone number', () => {
    // Unchanged, and the reason the threshold is not the only guard: every
    // character that is not a digit has to be phone punctuation.
    const clause = searchClause('C-00046') as { AND?: unknown[]; OR?: unknown[] };
    expect(clause.OR).toBeUndefined();
    expect(clause.AND).toBeDefined();
  });

  it('never searches for an empty string, however short the query', () => {
    for (const q of ['9', '93', '1', 'a']) {
      expect(patterns(searchClause(q))).not.toContain('');
    }
  });
});
