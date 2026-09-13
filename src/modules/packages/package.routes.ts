import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery, percentSchema } from '../../core/validators';
import * as service from './package.service';

const router = Router();
router.use(authenticate);

const templateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  price: moneySchema,
  taxRatePct: percentSchema.default(18),
  validityDays: z.coerce.number().int().min(1).max(3650).default(90),
  items: z.array(z.object({ serviceId: idSchema, quantity: z.coerce.number().int().min(1).max(100) })).min(1).max(50),
});

router.get(
  '/',
  requirePermission(PERMISSIONS.PACKAGE_VIEW),
  validate({ query: z.object({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.listTemplates((req.query as { activeOnly?: string }).activeOnly === 'true'))),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.PACKAGE_MANAGE),
  validate({ body: templateBody }),
  asyncHandler(async (req, res) => {
    const template = await service.createTemplate(req.body as never);
    audit({ action: 'package.created', entity: 'PackageTemplate', entityId: template.id });
    return created(res, template);
  }),
);

router.get(
  '/purchases',
  requirePermission(PERMISSIONS.PACKAGE_VIEW),
  validate({
    query: paginationQuery.extend({
      customerId: idSchema.optional(),
      branchId: idSchema.optional(),
      status: z.enum(['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED']).optional(),
      expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.listPurchases(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/purchases',
  requirePermission(PERMISSIONS.PACKAGE_MANAGE),
  validate({
    body: z.object({
      customerId: idSchema,
      templateId: idSchema,
      branchId: idSchema.optional(),
      price: moneySchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const purchase = await service.sellPackage(req.body as never);
    audit({ action: 'package.sold', entity: 'PackagePurchase', entityId: purchase.id });
    return created(res, purchase);
  }),
);

router.get(
  '/customer/:customerId',
  requirePermission(PERMISSIONS.PACKAGE_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.redeemableForCustomer(req.params.customerId!))),
);

router.post(
  '/purchases/:id/cancel',
  requirePermission(PERMISSIONS.PACKAGE_MANAGE),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().max(240).optional() }) }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body as { reason?: string };
    return ok(res, await service.cancelPurchase(req.params.id!, reason));
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.PACKAGE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getTemplate(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.PACKAGE_MANAGE),
  validate({ params: idParam, body: templateBody.partial().extend({ isActive: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.updateTemplate(req.params.id!, req.body as never))),
);

export default router;
