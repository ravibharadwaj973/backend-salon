import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery, percentSchema } from '../../core/validators';
import * as service from './membership.service';

const router = Router();
router.use(authenticate);

const planBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  price: moneySchema,
  taxRatePct: percentSchema.default(18),
  durationDays: z.coerce.number().int().min(1).max(3650).default(365),
  serviceDiscountPct: percentSchema.default(0),
  productDiscountPct: percentSchema.default(0),
  priorityBooking: z.boolean().default(false),
  birthdayBenefit: z.string().trim().max(240).optional(),
  loyaltyMultiplier: z.coerce.number().min(0.1).max(10).default(1),
  benefits: z.array(z.object({ serviceId: idSchema, quantity: z.coerce.number().int().min(1).max(100) })).max(50).optional(),
});

router.get(
  '/plans',
  requirePermission(PERMISSIONS.MEMBERSHIP_VIEW),
  validate({ query: z.object({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.listPlans((req.query as { activeOnly?: string }).activeOnly === 'true'))),
);

router.post(
  '/plans',
  requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
  validate({ body: planBody }),
  asyncHandler(async (req, res) => {
    const plan = await service.createPlan(req.body as never);
    audit({ action: 'membership_plan.created', entity: 'MembershipPlan', entityId: plan.id });
    return created(res, plan);
  }),
);

router.get(
  '/plans/:id',
  requirePermission(PERMISSIONS.MEMBERSHIP_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getPlan(req.params.id!))),
);

router.patch(
  '/plans/:id',
  requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
  validate({ params: idParam, body: planBody.partial().extend({ isActive: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.updatePlan(req.params.id!, req.body as never))),
);

router.get(
  '/subscriptions',
  requirePermission(PERMISSIONS.MEMBERSHIP_VIEW),
  validate({
    query: paginationQuery.extend({
      customerId: idSchema.optional(),
      branchId: idSchema.optional(),
      status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']).optional(),
      expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.listSubscriptions(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/subscriptions',
  requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
  validate({
    body: z.object({
      customerId: idSchema,
      planId: idSchema,
      branchId: idSchema.optional(),
      price: moneySchema.optional(),
      autoRenew: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subscription = await service.sellMembership(req.body as never);
    audit({ action: 'membership.sold', entity: 'MembershipSubscription', entityId: subscription.id });
    return created(res, subscription);
  }),
);

router.get(
  '/customer/:customerId',
  requirePermission(PERMISSIONS.MEMBERSHIP_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.membershipBenefitsForCustomer(req.params.customerId!))),
);

router.post(
  '/subscriptions/:id/cancel',
  requirePermission(PERMISSIONS.MEMBERSHIP_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.cancelSubscription(req.params.id!))),
);

export default router;
