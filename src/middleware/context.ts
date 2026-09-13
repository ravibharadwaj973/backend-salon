import type { RequestHandler } from 'express';
import { runWithContext, type RequestContext } from '../core/context';
import { requestId as newRequestId } from '../core/ids';

/**
 * Establishes the AsyncLocalStorage request context for the whole request.
 * Everything downstream — including the Prisma tenant filter — reads from here.
 */
export const contextMiddleware: RequestHandler = (req, res, next) => {
  const id = (req.headers['x-request-id'] as string | undefined) ?? newRequestId();

  const ctx: RequestContext = {
    requestId: id,
    tenantId: null,
    userId: null,
    role: null,
    branchIds: null,
    activeBranchId: null,
    isPlatformAdmin: false,
    bypassTenantScope: false,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  };

  req.ctx = ctx;
  res.setHeader('X-Request-Id', id);

  runWithContext(ctx, () => next());
};
