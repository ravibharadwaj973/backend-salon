import { describe, expect, it } from 'vitest';
import { runWithContext, type RequestContext } from '../src/core/context';
import { optionalBranchFilter } from '../src/core/scope';
import { buildCustomerWhere } from '../src/modules/customers/customer.service';

const context = (activeBranchId: string | null): RequestContext => ({
  requestId: 'test',
  tenantId: 't1',
  userId: 'u1',
  role: 'MANAGER',
  branchIds: null,
  activeBranchId,
  isPlatformAdmin: false,
  bypassTenantScope: false,
});

const asCounterStaff = <T>(branchId: string, fn: () => T): T => runWithContext(context(branchId), fn);

/**
 * A customer added at the counter had no branch on them, and every list was
 * filtered on `branchId = the active branch`. The row existed, the lookup in
 * the new-customer form found it, and the customer list never showed it — the
 * salon's own book quietly lost everyone added through the front door.
 */
describe('branch scoping for rows that may not have a branch', () => {
  it('includes rows with no branch alongside the active one', () => {
    const filter = asCounterStaff('b1', () => optionalBranchFilter());
    expect(filter).toEqual({ AND: [{ OR: [{ branchId: 'b1' }, { branchId: null }] }] });
  });

  it('does not filter at all when no branch is selected', () => {
    const filter = runWithContext(context(null), () => optionalBranchFilter());
    expect(filter).toEqual({});
  });

  it('keeps the branch scope when a name is searched', () => {
    // A name search is a list of AND groups, one per word, and the branch
    // scope is also an AND group. Spreading both into one object would let the
    // search replace the branch scope, and a receptionist at one shop would
    // start seeing customers from every shop the moment they typed a name.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: 'priya' }));
    const and = (where.AND ?? []) as Record<string, unknown>[];

    expect(and).toContainEqual({ OR: [{ branchId: 'b1' }, { branchId: null }] });
    // The word group is there too — the branch scope did not eat the search.
    expect(and).toHaveLength(2);
  });

  it('keeps the branch scope when a phone number is searched', () => {
    // The phone branch returns OR rather than AND, so it takes a different
    // path through the merge and deserves its own check.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: '9315341503' }));

    expect(where.AND).toEqual([{ OR: [{ branchId: 'b1' }, { branchId: null }] }]);
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it('keeps every word of a multi-word search alongside the branch scope', () => {
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: 'priya sharma' }));
    const and = (where.AND ?? []) as Record<string, unknown>[];

    // One branch group plus one group per word.
    expect(and).toHaveLength(3);
    expect(and).toContainEqual({ OR: [{ branchId: 'b1' }, { branchId: null }] });
  });

  it('still scopes a plain list with no search term', () => {
    const where = asCounterStaff('b2', () => buildCustomerWhere('t1', {}));
    expect(where.AND).toEqual([{ OR: [{ branchId: 'b2' }, { branchId: null }] }]);
    expect(where.OR).toBeUndefined();
  });
});
