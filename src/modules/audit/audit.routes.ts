import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate, authenticatePlatform } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { idParam, idSchema, paginationQuery } from '../../core/validators';
import * as service from './audit.service';
import type { ListAuditInput } from './audit.service';

const listQuery = paginationQuery.extend({
  userId: idSchema.optional(),
  branchId: idSchema.optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  action: z.string().trim().max(80).optional(),
  group: z.string().trim().max(40).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().trim().max(120).optional(),
});

const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const historyParams = z.object({
  entity: z.string().trim().min(1).max(60),
  entityId: z.string().trim().min(1).max(60),
});

// ------------------------------------------------------------ salon-facing --

export const auditRouter = Router();

auditRouter.use(authenticate);

// Only OWNER and ADMIN hold audit.view. The trail records who discounted a bill
// and who voided an invoice, so it must not be readable by the staff it watches.
auditRouter.use(requirePermission(PERMISSIONS.AUDIT_VIEW));

auditRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listAudit(req.auth!.tenantId, req.query as unknown as ListAuditInput);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

auditRouter.get(
  '/summary',
  validate({ query: summaryQuery }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    return ok(res, await service.auditSummary(req.auth!.tenantId, days));
  }),
);

/** Who and what this salon has — used to build the filter dropdowns. */
auditRouter.get(
  '/facets',
  asyncHandler(async (req, res) => ok(res, await service.auditFacets(req.auth!.tenantId))),
);

/** The full history of one record, oldest first. */
auditRouter.get(
  '/:entity/:entityId',
  validate({ params: historyParams }),
  asyncHandler(async (req, res) =>
    ok(res, await service.entityHistory(req.auth!.tenantId, req.params.entity!, req.params.entityId!)),
  ),
);

// -------------------------------------------------------- platform operator --

export const platformAuditRouter = Router();

platformAuditRouter.use(authenticatePlatform);

/**
 * A salon's activity, seen from the console — for answering "who deleted it"
 * when an owner rings support. Reading another business's trail is itself worth
 * noticing, so keep this to genuine support requests.
 */
platformAuditRouter.get(
  '/tenants/:id/audit',
  validate({ params: idParam, query: listQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listAudit(req.params.id!, req.query as unknown as ListAuditInput);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

export default auditRouter;
