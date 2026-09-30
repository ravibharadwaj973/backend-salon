import { describe, expect, it } from 'vitest';
import { runWithContext, type RequestContext } from '../src/core/context';
import { optionalBranchFilter, permittedBranchFilter } from '../src/core/scope';
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
 * Somebody who may only see certain shops — a receptionist assigned to two of
 * five. `branchIds: null` above means "every branch", which is an owner or an
 * admin; this is the other kind of user, and the one that proves a search
 * widens the SELECTION without widening the PERMISSION.
 */
const asRestrictedStaff = <T>(branchIds: string[], activeBranchId: string | null, fn: () => T): T =>
  runWithContext({ ...context(activeBranchId), branchIds }, fn);

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

  it('keeps every word of a search intact — the branch merge must not eat them', () => {
    // A name search is a list of AND groups, one per word. Whatever the branch
    // scope turns out to be, spreading both into one object would let one
    // replace the other, and this is the check that it does not.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: 'priya sharma' }));
    const and = (where.AND ?? []) as Record<string, unknown>[];

    expect(and).toHaveLength(2);
    for (const word of ['priya', 'sharma']) {
      expect(JSON.stringify(and)).toContain(word);
    }
  });
});

/**
 * SEARCHING IS NOT BROWSING, AND PINNING A SEARCH TO ONE SHOP TRAPPED PEOPLE.
 *
 * A customer registered at one branch, searched for at another, produced three
 * answers at once: the new-customer form's duplicate check named them, the
 * customer list said "No customer matches that", and creating them was refused
 * because the phone number already existed. Found, not found, and uncreatable —
 * with no way forward, because nobody at a counter knows which shop somebody
 * was first signed up at.
 *
 * Phone numbers are unique across the whole salon. A search held to that rule
 * cannot be narrower than the rule itself.
 */
describe('a search reaches the whole book', () => {
  it('is not pinned to the selected branch', () => {
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: '8809025436' }));
    const and = (where.AND ?? []) as Record<string, unknown>[];

    // Nothing about b1 anywhere: the phone clauses are the only condition left.
    expect(JSON.stringify(and)).not.toContain('b1');
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it('finds a customer whose home branch is a different shop', () => {
    // The reported case, as a query: the number was typed at b1, the customer
    // lives at b2, and the old clause excluded them.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: '88090' }));
    const clauses = JSON.stringify(where);

    expect(clauses).toContain('88090');
    expect(clauses).not.toContain('branchId');
  });

  it('widens the SELECTION without widening the PERMISSION', () => {
    // A user who may see two shops searches those two, and no others. Dropping
    // the pin must never become dropping the access check.
    const where = asRestrictedStaff(['b1', 'b2'], 'b1', () => buildCustomerWhere('t1', { q: '88090' }));

    expect(where.AND).toEqual([{ OR: [{ branchId: { in: ['b1', 'b2'] } }, { branchId: null }] }]);
  });

  it('still honours a branch somebody chose on purpose', () => {
    // An explicit branchId is a filter the caller set. Quietly widening it
    // underneath them would be its own kind of wrong.
    const where = asCounterStaff('b1', () => buildCustomerWhere('t1', { q: '88090', branchId: 'b2' }));

    expect(where.AND).toEqual([{ OR: [{ branchId: 'b2' }, { branchId: null }] }]);
  });

  it('leaves an unrestricted user unfiltered, and a restricted one filtered', () => {
    expect(runWithContext(context('b1'), () => permittedBranchFilter())).toEqual({});
    expect(asRestrictedStaff(['b3'], 'b3', () => permittedBranchFilter())).toEqual({
      AND: [{ OR: [{ branchId: { in: ['b3'] } }, { branchId: null }] }],
    });
  });
});

describe('browsing stays with the shop you are standing in', () => {
  it('still scopes a plain list with no search term', () => {
    const where = asCounterStaff('b2', () => buildCustomerWhere('t1', {}));
    expect(where.AND).toEqual([{ OR: [{ branchId: 'b2' }, { branchId: null }] }]);
    expect(where.OR).toBeUndefined();
  });
});
