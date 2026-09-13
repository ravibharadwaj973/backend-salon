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
