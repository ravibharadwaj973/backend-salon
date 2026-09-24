import { describe, expect, it } from 'vitest';
import { lookupTerms } from '../src/modules/customers/customer.service';

describe('customer lookup terms', () => {
  it('treats anything that is mostly digits as a phone number, however it is typed', () => {
    expect(lookupTerms('98765 43210').phone).toBe('9876543210');
    expect(lookupTerms('+91 98765-43210').phone).toBe('9876543210');
    expect(lookupTerms('09876543210').phone).toBe('9876543210');
    expect(lookupTerms('(98765) 43210').phone).toBe('9876543210');
  });

  /**
   * This used to say four digits, and four was wrong.
   *
   * Searching "931" in a book containing 93118 91503 and 93153 41503 returned
   * "No customer matches that": three digits fell under the threshold, so the
   * query ran as a TEXT search, compared "931" against names, emails and codes,
   * and matched none of them.
   *
   * Nobody types a whole number to find somebody. They read the first few
   * digits off a phone screen and stop when the name appears.
   */
  it('matches on a partial number from two digits', () => {
    expect(lookupTerms('93').phone).toBe('93');
    expect(lookupTerms('931').phone).toBe('931');
    expect(lookupTerms('9876').phone).toBe('9876');
  });

  it('does not treat a single digit as a number worth searching', () => {
    // One digit matches most of the book, which is not a search result.
    expect(lookupTerms('9').phone).toBe('');
  });

  it('does not mistake a name or email containing digits for a phone', () => {
    expect(lookupTerms('priya98').phone).toBe('');
    expect(lookupTerms('priya1990@gmail.com').phone).toBe('');
    expect(lookupTerms('priya1990@gmail.com').text).toBe('priya1990@gmail.com');
  });
});
