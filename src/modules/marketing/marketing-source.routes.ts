import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema } from '../../core/validators';
import { env } from '../../config/env';
import * as sources from './marketing-source.service';

/**
 * WHAT WAS SPENT, AND WHAT CAME BACK.
 *
 * Read behind CAMPAIGN_VIEW and written behind CAMPAIGN_MANAGE, matching the
 * messaging campaigns beside it: the same people decide what the salon promotes
 * and are allowed to see what it earned.
 *
 * Deliberately NOT behind the MARKETING plan feature. Tracking what an organic
 * reel produced costs the platform nothing and is most of the value here — a
 * Starter salon that cannot send a campaign can still find out which post fills
 * their Saturdays, and locking that away would be charging for arithmetic.
 */
export const marketingSourceRouter = Router();
marketingSourceRouter.use(authenticate);

const sourceBody = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(32),
  channel: z.enum(['INSTAGRAM', 'MESSENGER', 'WHATSAPP', 'EMAIL', 'SMS', 'IN_APP']).optional(),
  kind: z.enum(['ORGANIC_POST', 'BOOSTED_POST', 'AD', 'QR', 'OTHER']).optional(),
  spend: moneySchema.optional(),
  dailyBudget: moneySchema.nullable().optional(),
  startedOn: z.coerce.date().nullable().optional(),
  endedOn: z.coerce.date().nullable().optional(),
  branchId: idSchema.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

marketingSourceRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: z.object({ branchId: idSchema.optional(), activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as { branchId?: string; activeOnly?: string };
    const rows = await sources.listSources({ branchId: q.branchId, activeOnly: q.activeOnly === 'true' });
    /**
     * The link is built here rather than stored, so it follows the deployment
     * rather than freezing whatever PUBLIC_APP_URL happened to be set to on the
     * day the row was written.
     */
    return ok(
      res,
      rows.map((row) => ({ ...row, link: `${env.PUBLIC_APP_URL.replace(/\/+$/, '')}/go/${row.code}` })),
    );
  }),
);

/** Spend, clicks, DMs, bookings and the money, per source. */
marketingSourceRouter.get(
  '/results',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from: Date; to: Date; branchId?: string };
    return ok(res, await sources.sourceResults(q));
  }),
);

marketingSourceRouter.post(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ body: sourceBody }),
  asyncHandler(async (req, res) => {
    const source = await sources.createSource(req.body as sources.SourceInput);
    audit({ action: 'marketing_source.created', entity: 'MarketingSource', entityId: source.id, after: { code: source.code } });
    return created(res, source);
  }),
);

marketingSourceRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam, body: sourceBody.partial().extend({ isActive: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const before = req.body as Partial<sources.SourceInput>;
    const source = await sources.updateSource(req.params.id!, before);
    /**
     * Audited because `spend` is a number a human types and every figure on the
     * results screen is divided by it. Somebody quietly changing ₹3,000 to ₹300
     * turns a mediocre campaign into a triumph, and without this there would be
     * no way to find out that is what happened.
     */
    audit({ action: 'marketing_source.updated', entity: 'MarketingSource', entityId: source.id, after: before });
    return ok(res, source);
  }),
);

export default marketingSourceRouter;
