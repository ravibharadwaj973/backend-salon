import type { RequestHandler } from 'express';
import { Forbidden } from '../core/errors';

/**
 * Reads the branch the client is working in (header first, then query string)
 * and validates it against the user's branch assignments. Services then pick it
 * up through the request context via `core/scope`.
 */
export const resolveBranch: RequestHandler = (req, _res, next) => {
  const headerBranch = req.get('x-branch-id');
  const queryBranch = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
  const branchId = headerBranch || queryBranch;

  if (!branchId) return next();

  const allowed = req.ctx.branchIds;
  if (allowed !== null && !allowed.includes(branchId)) {
    return next(Forbidden('You do not have access to this branch'));
  }

  req.branchId = branchId;
  req.ctx.activeBranchId = branchId;
  next();
};
