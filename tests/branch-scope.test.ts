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

  it('keeps the branch scope in its own key, so a search never overwrites it', () => {
    // Both live on the where clause at once: the search is `OR`, the branch
    // scope is `AND`. Putting the branch scope in `OR` would have widened the
    // search to every branch the moment someone typed a name.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: 'priya' }));

    expect(where.AND).toEqual([{ OR: [{ branchId: 'b1' }, { branchId: null }] }]);
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(5);
  });

  it('still scopes a plain list with no search term', () => {
    const where = asCounterStaff('b2', () => buildCustomerWhere('t1', {}));
    expect(where.AND).toEqual([{ OR: [{ branchId: 'b2' }, { branchId: null }] }]);
    expect(where.OR).toBeUndefined();
  });
});
