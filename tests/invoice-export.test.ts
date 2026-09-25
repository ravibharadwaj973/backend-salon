import { describe, expect, it } from 'vitest';
import { compareInvoiceNumbers, sequenceOf, sortKey } from '../src/modules/billing/invoice-export.service';

/**
 * This file goes to an accountant, into a GSTR-1 working paper, or in front of
 * an officer. Order is not a presentational nicety here: a return that appears
 * to skip a bill number invites exactly the question nobody wants to answer.
 *
 * Sorting the obvious way — alphabetically, which is what a database ORDER BY on
 * the number column gives — puts 00010 before 0009 and manufactures that
 * question out of nothing.
 */
describe('putting bills in the order they were issued', () => {
  it('reads the sequence off the end of any format the app can produce', () => {
    // The format is the salon's own, so the sequence cannot be read off a
    // column. All three of these mean forty-two.
    expect(sequenceOf('INV/25-26/00042')).toBe(42);
    expect(sequenceOf('GC-042')).toBe(42);
    expect(sequenceOf('42')).toBe(42);
    expect(sequenceOf('INV0042')).toBe(42);
  });

  it('sorts numerically, not alphabetically', () => {
    // The whole point. Alphabetical order puts 10 before 9.
    const numbers = ['INV/25-26/00010', 'INV/25-26/00009', 'INV/25-26/00002'];
    expect([...numbers].sort(compareInvoiceNumbers)).toEqual([
      'INV/25-26/00002',
      'INV/25-26/00009',
      'INV/25-26/00010',
    ]);
  });

  it('groups each series rather than interleaving two branches', () => {
    // Two branches counting independently are two runs, and reading them
    // shuffled together makes both look full of holes.
    const mixed = ['GC/25-26/00002', 'INV/25-26/00001', 'GC/25-26/00001', 'INV/25-26/00002'];
    expect([...mixed].sort(compareInvoiceNumbers)).toEqual([
      'GC/25-26/00001',
      'GC/25-26/00002',
      'INV/25-26/00001',
      'INV/25-26/00002',
    ]);
  });

  it('keeps financial years apart within one branch', () => {
    const years = ['INV/26-27/00001', 'INV/25-26/00099'];
    expect([...years].sort(compareInvoiceNumbers)).toEqual(['INV/25-26/00099', 'INV/26-27/00001']);
  });

  it('keeps tax invoices and non-GST bills in separate runs', () => {
    // The reason there are two series at all: a GST series with cash bills
    // mixed in reads, at filing time, as a series with gaps.
    const both = ['BILL/25-26/00002', 'INV/25-26/00002', 'BILL/25-26/00001', 'INV/25-26/00001'];
    expect([...both].sort(compareInvoiceNumbers)).toEqual([
      'BILL/25-26/00001',
      'BILL/25-26/00002',
      'INV/25-26/00001',
      'INV/25-26/00002',
    ]);
  });

  it('separates the series part from the sequence part', () => {
    expect(sortKey('INV/25-26/00042')).toEqual(['INV/25-26/', 42]);
    expect(sortKey('GC-7')).toEqual(['GC-', 7]);
  });

  it('does not fall over on a number with no digits at all', () => {
    // Hand-entered legacy data exists. It must sort somewhere rather than throw
    // and take the whole export with it.
    expect(sequenceOf('MANUAL')).toBe(0);
    expect(() => ['MANUAL', 'INV/25-26/00001'].sort(compareInvoiceNumbers)).not.toThrow();
  });

  it('is a stable comparator, so a sort cannot loop', () => {
    expect(compareInvoiceNumbers('INV/25-26/00001', 'INV/25-26/00001')).toBe(0);
  });
});
