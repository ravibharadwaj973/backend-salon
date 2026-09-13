import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { idParam, idSchema, paginationQuery } from '../../core/validators';
import * as analytics from './analytics.service';
import * as alerts from './alerts.service';

const router = Router();
router.use(authenticate);

const rangeQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  branchId: idSchema.optional(),
});

router.get(
  '/dashboard',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  validate({ query: z.object({ date: z.coerce.date().optional(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await analytics.dashboard(req.query as never))),
);

router.get(
  '/snapshot',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  asyncHandler(async (req, res) => ok(res, await alerts.daySnapshot(req.branchId))),
);

router.get(
  '/growth',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({
    query: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await analytics.growth(req.query as never))),
);

router.get(
  '/revenue-trend',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: rangeQuery.extend({ interval: z.enum(['day', 'month']).default('day') }) }),
  asyncHandler(async (req, res) => ok(res, await analytics.revenueTrend(req.query as never))),
);

router.get(
  '/services',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: rangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(25) }) }),
  asyncHandler(async (req, res) => ok(res, await analytics.servicePerformance(req.query as never))),
);

router.get(
  '/unit-economics',
  requirePermission(PERMISSIONS.REPORT_FINANCIAL),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => ok(res, await analytics.unitEconomics(req.query as never))),
);

router.get(
  '/branch-pnl',
  requirePermission(PERMISSIONS.REPORT_FINANCIAL),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date() }) }),
  asyncHandler(async (req, res) => ok(res, await analytics.branchPnl(req.query as never))),
);

router.get(
  '/retention',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({
    query: z.object({
      months: z.coerce.number().int().min(2).max(24).default(6),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await analytics.retentionCohorts(req.query as never))),
);

router.get(
  '/insights',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  validate({ query: z.object({ branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await analytics.businessInsights(req.query as never))),
);

router.get(
  '/monthly-report',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({
    query: z.object({
      month: z.coerce.number().int().min(1).max(12),
      year: z.coerce.number().int().min(2020).max(2100),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await analytics.monthlyReport(req.query as never))),
);

// ---------------------------------------------------------------- alerts ---

router.get(
  '/alerts',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  validate({ query: paginationQuery.extend({ branchId: idSchema.optional(), unreadOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; branchId?: string; unreadOnly?: string };
    const result = await alerts.listAlerts({ ...q, unreadOnly: q.unreadOnly === 'true' });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/alerts/generate',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  asyncHandler(async (req, res) => ok(res, await alerts.generateAlerts(req.auth!.tenantId, req.branchId ?? null))),
);

router.post(
  '/alerts/:id/read',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await alerts.markAlertRead(req.params.id!))),
);

router.post(
  '/alerts/:id/dismiss',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await alerts.dismissAlert(req.params.id!))),
);

export default router;
