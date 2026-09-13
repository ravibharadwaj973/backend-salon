import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { idParam, idSchema, moneySchema, paginationQuery } from '../../core/validators';
import * as service from './gamification.service';
import type { ChallengeInput } from './gamification.service';

const router = Router();
router.use(authenticate);

const challengeBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(['VISIT_COUNT', 'SPEND_AMOUNT', 'SERVICE_VARIETY', 'REFERRAL_COUNT', 'STREAK']),
  targetValue: moneySchema,
  durationDays: z.coerce.number().int().min(1).max(365).default(30),
  rewardPoints: z.coerce.number().int().min(0).max(100000).default(0),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
});

router.get(
  '/challenges',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  validate({ query: paginationQuery.extend({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; activeOnly?: string };
    const result = await service.listChallenges({ ...q, activeOnly: q.activeOnly === 'true' });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/challenges',
  requirePermission(PERMISSIONS.GAMIFICATION_MANAGE),
  validate({ body: challengeBody }),
  asyncHandler(async (req, res) => created(res, await service.createChallenge(req.body as ChallengeInput))),
);

router.patch(
  '/challenges/:id',
  requirePermission(PERMISSIONS.GAMIFICATION_MANAGE),
  validate({ params: idParam, body: challengeBody.partial().extend({ isActive: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.updateChallenge(req.params.id!, req.body as never))),
);

router.post(
  '/challenges/:id/enroll',
  requirePermission(PERMISSIONS.GAMIFICATION_MANAGE),
  validate({ params: idParam, body: z.object({ customerId: idSchema }) }),
  asyncHandler(async (req, res) => {
    const { customerId } = req.body as { customerId: string };
    return created(res, await service.enroll(req.params.id!, customerId));
  }),
);

router.get(
  '/customers/:customerId/challenges',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.listEnrollments(req.params.customerId!))),
);

router.post(
  '/customers/:customerId/refresh',
  requirePermission(PERMISSIONS.GAMIFICATION_MANAGE),
  asyncHandler(async (req, res) => {
    await service.updateStreak(req.params.customerId!);
    return ok(res, await service.updateProgress(req.params.customerId!));
  }),
);

router.get(
  '/referrals/leaderboard',
  requirePermission(PERMISSIONS.LOYALTY_VIEW),
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await service.referralLeaderboard(req.query as never))),
);

router.get(
  '/engagement',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.engagementSummary(req.branchId))),
);

export default router;
