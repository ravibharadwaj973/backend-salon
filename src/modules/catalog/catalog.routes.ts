import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './catalog.service';
import type { ServiceInput } from './catalog.service';
import {
  consumptionSchema,
  createCategorySchema,
  createServiceSchema,
  listServicesQuery,
  updateCategorySchema,
  updateServiceSchema,
} from './catalog.schema';
import type { Gender } from '@prisma/client';

const router = Router();
router.use(authenticate);

// categories
router.get(
  '/categories',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  asyncHandler(async (_req, res) => ok(res, await service.listCategories())),
);

router.post(
  '/categories',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ body: createCategorySchema }),
  asyncHandler(async (req, res) => created(res, await service.createCategory(req.body as never))),
);

router.patch(
  '/categories/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam, body: updateCategorySchema }),
  asyncHandler(async (req, res) => ok(res, await service.updateCategory(req.params.id!, req.body as never))),
);

router.delete(
  '/categories/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.deleteCategory(req.params.id!))),
);

// menu
router.get(
  '/menu',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    query: z.object({
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
      onlineOnly: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as { gender?: Gender; onlineOnly?: string };
    return ok(res, await service.serviceMenu({ gender: q.gender, onlineOnly: q.onlineOnly === 'true' }));
  }),
);

// services
router.get(
  '/',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ query: listServicesQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listServices(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ body: createServiceSchema }),
  asyncHandler(async (req, res) => {
    const svc = await service.createService(req.body as ServiceInput);
    audit({ action: 'service.created', entity: 'Service', entityId: svc.id, after: svc });
    return created(res, svc);
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getService(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam, body: updateServiceSchema }),
  asyncHandler(async (req, res) => {
    const svc = await service.updateService(req.params.id!, req.body as Partial<ServiceInput>);
    audit({ action: 'service.updated', entity: 'Service', entityId: svc.id, after: req.body });
    return ok(res, svc);
  }),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.deactivateService(req.params.id!))),
);

router.put(
  '/:id/consumption',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam, body: consumptionSchema }),
  asyncHandler(async (req, res) => {
    const { items } = req.body as { items: { productId: string; quantity: number }[] };
    return ok(res, await service.setServiceConsumption(req.params.id!, items));
  }),
);

export default router;
