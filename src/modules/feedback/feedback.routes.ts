import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, paginationQuery } from '../../core/validators';
import * as service from './feedback.service';
import type { FeedbackInput } from './feedback.service';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission(PERMISSIONS.FEEDBACK_VIEW),
  validate({
    query: paginationQuery.extend({
      branchId: idSchema.optional(),
      staffId: idSchema.optional(),
      minRating: z.coerce.number().int().min(1).max(5).optional(),
      maxRating: z.coerce.number().int().min(1).max(5).optional(),
      complaintsOnly: z.enum(['true', 'false']).optional(),
      unresolvedOnly: z.enum(['true', 'false']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as Record<string, unknown> & { complaintsOnly?: string; unresolvedOnly?: string };
    const result = await service.listFeedback({
      ...(q as Parameters<typeof service.listFeedback>[0]),
      complaintsOnly: q.complaintsOnly === 'true',
      unresolvedOnly: q.unresolvedOnly === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.FEEDBACK_VIEW),
  validate({
    body: z.object({
      appointmentId: idSchema.optional(),
      customerId: idSchema.optional(),
      staffId: idSchema.optional(),
      branchId: idSchema.optional(),
      rating: z.coerce.number().int().min(1).max(5),
      serviceRating: z.coerce.number().int().min(1).max(5).optional(),
      ambienceRating: z.coerce.number().int().min(1).max(5).optional(),
      staffRating: z.coerce.number().int().min(1).max(5).optional(),
      waitRating: z.coerce.number().int().min(1).max(5).optional(),
      npsScore: z.coerce.number().int().min(0).max(10).optional(),
      comment: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await service.submitFeedback(req.body as FeedbackInput))),
);

router.get(
  '/summary',
  requirePermission(PERMISSIONS.FEEDBACK_VIEW),
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await service.reputationSummary(req.query as never))),
);

router.post(
  '/:id/resolve',
  requirePermission(PERMISSIONS.FEEDBACK_MANAGE),
  validate({ params: idParam, body: z.object({ note: z.string().trim().min(1).max(1000) }) }),
  asyncHandler(async (req, res) => {
    const { note } = req.body as { note: string };
    const feedback = await service.resolveComplaint(req.params.id!, note);
    audit({ action: 'feedback.resolved', entity: 'Feedback', entityId: feedback.id });
    return ok(res, feedback);
  }),
);

export default router;
