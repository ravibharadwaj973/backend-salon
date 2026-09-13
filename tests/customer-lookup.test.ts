import { describe, expect, it } from 'vitest';
import { lookupTerms } from '../src/modules/customers/customer.service';

describe('customer lookup terms', () => {
  it('treats anything that is mostly digits as a phone number, however it is typed', () => {
    expect(lookupTerms('98765 43210').phone).toBe('9876543210');
    expect(lookupTerms('+91 98765-43210').phone).toBe('9876543210');
    expect(lookupTerms('09876543210').phone).toBe('9876543210');
    expect(lookupTerms('(98765) 43210').phone).toBe('9876543210');
  });

  it('matches on a partial number once four digits are in', () => {
    expect(lookupTerms('987').phone).toBe('');
    expect(lookupTerms('9876').phone).toBe('9876');
  });

  it('does not mistake a name or email containing digits for a phone', () => {
    expect(lookupTerms('priya98').phone).toBe('');
    expect(lookupTerms('priya1990@gmail.com').phone).toBe('');
    expect(lookupTerms('priya1990@gmail.com').text).toBe('priya1990@gmail.com');
  });
});
