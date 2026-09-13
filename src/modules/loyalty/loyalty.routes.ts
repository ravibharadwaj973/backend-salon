import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery, percentSchema } from '../../core/validators';
import * as service from './loyalty.service';

const router = Router();
router.use(authenticate);

router.get(
  '/program',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  asyncHandler(async (_req, res) => ok(res, await service.getProgram())),
);

router.put(
  '/program',
  requirePermission(PERMISSIONS.LOYALTY_MANAGE),
  validate({
    body: z.object({
      isActive: z.boolean().optional(),
      amountPerPoint: moneySchema.optional(),
      pointValue: moneySchema.optional(),
      referralPoints: z.coerce.number().int().min(0).max(10000).optional(),
      birthdayPoints: z.coerce.number().int().min(0).max(10000).optional(),
      reviewPoints: z.coerce.number().int().min(0).max(10000).optional(),
      signupPoints: z.coerce.number().int().min(0).max(10000).optional(),
      minRedeemPoints: z.coerce.number().int().min(0).max(100000).optional(),
      maxRedeemPctOfBill: percentSchema.optional(),
      expiryMonths: z.coerce.number().int().min(0).max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const program = await service.updateProgram(req.body as never);
    audit({ action: 'loyalty.program_updated', entity: 'LoyaltyProgram', entityId: program.id, after: req.body });
    return ok(res, program);
  }),
);

router.get(
  '/rewards',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  validate({ query: z.object({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.listRewards((req.query as { activeOnly?: string }).activeOnly === 'true'))),
);

router.post(
  '/rewards',
  requirePermission(PERMISSIONS.LOYALTY_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      pointsCost: z.coerce.number().int().min(1).max(1_000_000),
      rewardType: z.enum(['DISCOUNT', 'FREE_SERVICE', 'PRODUCT']).default('DISCOUNT'),
      value: moneySchema.default(0),
      serviceId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await service.createReward(req.body as never))),
);

router.patch(
  '/rewards/:id',
  requirePermission(PERMISSIONS.LOYALTY_MANAGE),
  validate({ params: idParam, body: z.record(z.unknown()) }),
  asyncHandler(async (req, res) => ok(res, await service.updateReward(req.params.id!, req.body as Record<string, unknown>))),
);

router.post(
  '/rewards/redeem',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  validate({ body: z.object({ rewardId: idSchema, customerId: idSchema, invoiceId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await service.redeemReward(req.body as never);
    audit({ action: 'loyalty.reward_redeemed', entity: 'RewardRedemption', entityId: result.redemption.id });
    return created(res, result);
  }),
);

router.get(
  '/customers/:customerId/transactions',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listTransactions(req.params.customerId!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/customers/:customerId/adjust',
  requirePermission(PERMISSIONS.LOYALTY_MANAGE),
  validate({
    body: z.object({
      points: z.coerce.number().int().min(-1_000_000).max(1_000_000),
      reason: z.string().trim().min(1).max(240),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { points, reason } = req.body as { points: number; reason: string };
    const txn = await service.adjustPoints({ customerId: req.params.customerId!, points, reason });
    audit({ action: 'loyalty.adjusted', entity: 'LoyaltyTransaction', entityId: txn.id, after: { points, reason } });
    return created(res, txn);
  }),
);

export default router;
