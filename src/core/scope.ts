import { getContext } from './context';
import { Forbidden, BadRequest } from './errors';

/**
 * Branch-level scoping. Tenant isolation is automatic (Prisma extension); branch
 * visibility is a business rule, so it is applied explicitly by each service
 * through these helpers.
 *
 *   Owner / Admin            -> every branch
 *   Regional manager         -> assigned branches
 *   Manager / Receptionist   -> assigned branch(es)
 *   Stylist                  -> own branch, own appointments
 */
export function allowedBranchIds(): string[] | null {
  return getContext()?.branchIds ?? null;
}

export function activeBranchId(): string | null {
  return getContext()?.activeBranchId ?? null;
}

export function canAccessBranch(branchId: string): boolean {
  const allowed = allowedBranchIds();
  return allowed === null || allowed.includes(branchId);
}

export function assertBranchAccess(branchId: string): void {
  if (!canAccessBranch(branchId)) {
    throw Forbidden('You do not have access to this branch');
  }
}

/**
 * Build a `branchId` filter fragment for a Prisma `where` clause.
 *  - explicit branch given  -> pinned to it (after an access check)
 *  - active branch selected -> pinned to it
 *  - restricted user        -> `in` their assigned branches
 *  - unrestricted user      -> no filter (whole tenant)
 */
export function branchFilter(explicitBranchId?: string | null): { branchId?: string | { in: string[] } } {
  if (explicitBranchId) {
    assertBranchAccess(explicitBranchId);
    return { branchId: explicitBranchId };
  }
  const active = activeBranchId();
  if (active) {
    assertBranchAccess(active);
    return { branchId: active };
  }
  const allowed = allowedBranchIds();
  if (allowed === null) return {};
  return { branchId: { in: allowed } };
}

/**
 * Same as branchFilter but for models whose branch column is nullable —
 * customers, leads, campaigns, segments.
 *
 * A row with no branch belongs to the whole salon, so it must appear in every
 * branch's view rather than none. Filtering on `branchId = active` alone hides
 * it everywhere at once, which is how a customer added at the counter, or
 * imported from a CSV, can exist in the database and appear nowhere in the app.
 *
 * Returned under `AND` so it cannot collide with a caller's own `OR` — the
 * search clause in buildCustomerWhere is exactly that. A caller that sets its
 * own `AND` must merge rather than overwrite, or the branch scope is silently
 * dropped.
 */
export function optionalBranchFilter(explicitBranchId?: string | null) {
  const filter = branchFilter(explicitBranchId);
  if (!filter.branchId) return {};
  return { AND: [{ OR: [{ branchId: filter.branchId }, { branchId: null }] }] };
}

/**
 * EVERY BRANCH THIS USER MAY SEE — NOT JUST THE ONE THEY HAVE SELECTED.
 *
 * The branch picker is a convenience for BROWSING: "show me this shop's book".
 * It is the wrong scope for SEARCHING, and the difference produced a dead end
 * somebody could not get out of.
 *
 * A customer is a salon-level record. Their phone number is unique across the
 * whole tenant, the duplicate check behind every "new customer" form is
 * tenant-wide, and a customer registered at one shop can be served at another —
 * that is what a chain is. But the customer LIST was pinned to the selected
 * branch, so a receptionist standing in front of somebody registered elsewhere
 * saw all three of these at once:
 *
 *   · "Already in your book?" — naming them, with their visits and spend;
 *   · "No customer matches that" — searching for the same number;
 *   · "A customer with this phone number already exists" — on trying to add them.
 *
 * Found, not found, and cannot be created. There is no way forward from that
 * without knowing which shop they were first signed up at, which is exactly the
 * thing nobody at a counter knows.
 *
 * So a search widens to everything the user is PERMITTED to see, while browsing
 * stays pinned to the selected branch. It drops the pin, not the permission:
 * `allowedBranchIds` is still honoured, so a user restricted to two shops still
 * searches those two and no others. For an owner or an admin, who may see every
 * branch, that is the whole salon — which is the same scope as the uniqueness
 * rule they are being held to.
 */
export function permittedBranchFilter() {
  const allowed = allowedBranchIds();
  if (allowed === null) return {};
  return { AND: [{ OR: [{ branchId: { in: allowed } }, { branchId: null }] }] };
}

/**
 * Branch required for writes (creating an appointment, taking a payment...).
 * Falls back to the request's active branch.
 */
export function requireBranchId(explicitBranchId?: string | null): string {
  const branchId = explicitBranchId ?? activeBranchId();
  if (!branchId) {
    throw BadRequest('A branch is required. Send X-Branch-Id or include branchId in the request body.');
  }
  assertBranchAccess(branchId);
  return branchId;
}

/** Resolve the branch id list for raw analytics SQL. */
export function branchIdsForQuery(explicitBranchId?: string | null): string[] | null {
  if (explicitBranchId) {
    assertBranchAccess(explicitBranchId);
    return [explicitBranchId];
  }
  const active = activeBranchId();
  if (active) {
    assertBranchAccess(active);
    return [active];
  }
  return allowedBranchIds();
}
