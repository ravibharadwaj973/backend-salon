import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * "NO INVOICES HERE" ON A SALON WITH HUNDREDS OF BILLS.
 *
 * An HTML GET form submits every control it contains. The invoice filter bar
 * has a status dropdown, two date boxes and a search box, so pressing Apply
 * without setting anything navigates to `?q=&status=&from=&to=`.
 *
 * To zod those are three PRESENT values. `status: ''` fails an enum that does
 * not list it; `from: ''` coerces to an Invalid Date and fails too. The request
 * is refused with 422, the list comes back empty, and the screen says "No
 * invoices here. Bills you create will appear here."
 *
 * stripBlanks is reproduced from validate.ts, because importing the middleware
 * drags in the error types and the app.
 */
function stripBlanks(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === '') continue;
    if (Array.isArray(value)) {
      const values = value.filter((entry) => entry !== '');
      if (values.length === 0) continue;
      kept[key] = values;
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

const invoiceQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'REFUNDED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  unpaidOnly: z.enum(['true', 'false']).optional(),
});

describe('a filter bar with nothing set is not a validation error', () => {
  it('accepts what the form actually submits', () => {
    const submitted = { q: '', status: '', from: '', to: '' };

    expect(invoiceQuery.safeParse(submitted).success, 'before the fix').toBe(false);
    expect(invoiceQuery.safeParse(stripBlanks(submitted)).success).toBe(true);
  });

  it('keeps the filters that were set', () => {
    const parsed = invoiceQuery.parse(stripBlanks({ q: 'INV-1042', status: 'PAID', from: '', to: '' }));
    expect(parsed.q).toBe('INV-1042');
    expect(parsed.status).toBe('PAID');
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBeUndefined();
  });

  it('drops a repeated parameter whose values were all blank', () => {
    expect(stripBlanks({ status: ['', ''] })).toEqual({});
    expect(stripBlanks({ status: ['', 'PAID'] })).toEqual({ status: ['PAID'] });
  });

  it('leaves a zero alone, which is a value and not a blank', () => {
    expect(stripBlanks({ page: '0', pageSize: 25 })).toEqual({ page: '0', pageSize: 25 });
  });
});
