import { describe, expect, it } from 'vitest';
import { parseStatusFilter } from '../src/modules/marketing/message-filter';

describe('the message log status filter', () => {
  it('reads one status', () => {
    expect(parseStatusFilter('DELIVERED')).toEqual(['DELIVERED']);
  });

  it('reads the whole "problems" chip in one go', () => {
    expect(parseStatusFilter('DELAYED,BOUNCED,COMPLAINED,FAILED')).toEqual([
      'DELAYED',
      'BOUNCED',
      'COMPLAINED',
      'FAILED',
    ]);
  });

  it('is empty when nothing was asked for, which means no filter at all', () => {
    expect(parseStatusFilter(undefined)).toEqual([]);
    expect(parseStatusFilter('')).toEqual([]);
    expect(parseStatusFilter('   ')).toEqual([]);
  });

  it('drops a value the enum does not have rather than passing it to the database', () => {
    // Postgres rejects an unknown enum label, and the 500 lands on the page —
    // so a stale bookmark must degrade to "no filter", not to an error.
    expect(parseStatusFilter('DELIVERE')).toEqual([]);
    expect(parseStatusFilter('DELIVERED,DELIVERE')).toEqual(['DELIVERED']);
    expect(parseStatusFilter("DELIVERED'; drop table --")).toEqual([]);
  });

  it('forgives spacing and case from a hand-typed URL', () => {
    expect(parseStatusFilter(' delivered , read ')).toEqual(['DELIVERED', 'READ']);
  });

  it('does not repeat a status listed twice', () => {
    expect(parseStatusFilter('FAILED,FAILED')).toEqual(['FAILED']);
  });
});
