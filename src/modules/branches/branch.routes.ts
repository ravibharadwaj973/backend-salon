import { Router } from 'express';
import { asyncHandler, created, noContent, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './branch.service';
import type { BranchInput } from './branch.service';
import {
  createBranchSchema,
  createHolidaySchema,
  createResourceSchema,
  listBranchesQuery,
  updateBranchSchema,
  updateResourceSchema,
} from './branch.schema';
import type { ResourceType } from '@prisma/client';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission(PERMISSIONS.BRANCH_VIEW),
  validate({ query: listBranchesQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listBranches(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ body: createBranchSchema }),
  asyncHandler(async (req, res) => {
    const branch = await service.createBranch(req.body as BranchInput);
    audit({ action: 'branch.created', entity: 'Branch', entityId: branch.id, after: branch });
    return created(res, branch);
  }),
);

router.get(
  '/resources',
  requirePermission(PERMISSIONS.BRANCH_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.listResources(req.branchId))),
);

router.post(
  '/resources',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ body: createResourceSchema }),
  asyncHandler(async (req, res) => {
    const resource = await service.createResource(req.body as { branchId: string; name: string; type?: ResourceType; capacity?: number });
    audit({ action: 'resource.created', entity: 'Resource', entityId: resource.id, after: resource });
    return created(res, resource);
  }),
);

router.patch(
  '/resources/:id',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ params: idParam, body: updateResourceSchema }),
  asyncHandler(async (req, res) => ok(res, await service.updateResource(req.params.id!, req.body as never))),
);

router.delete(
  '/resources/:id',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteResource(req.params.id!);
    return noContent(res);
  }),
);

router.get(
  '/holidays',
  requirePermission(PERMISSIONS.BRANCH_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.listHolidays(req.branchId))),
);

router.post(
  '/holidays',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ body: createHolidaySchema }),
  asyncHandler(async (req, res) =>
    created(res, await service.createHoliday(req.body as { branchId?: string; date: Date; name: string })),
  ),
);

router.delete(
  '/holidays/:id',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteHoliday(req.params.id!);
    return noContent(res);
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.BRANCH_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getBranch(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ params: idParam, body: updateBranchSchema }),
  asyncHandler(async (req, res) => {
    const branch = await service.updateBranch(req.params.id!, req.body as Partial<BranchInput>);
    audit({ action: 'branch.updated', entity: 'Branch', entityId: branch.id, after: req.body });
    return ok(res, branch);
  }),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.BRANCH_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const branch = await service.deactivateBranch(req.params.id!);
    audit({ action: 'branch.deactivated', entity: 'Branch', entityId: branch.id });
    return ok(res, branch);
  }),
);

export default router;
