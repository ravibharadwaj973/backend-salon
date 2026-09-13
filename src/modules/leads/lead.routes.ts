import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, paginationQuery, phoneSchema, searchQuery } from '../../core/validators';
import * as service from './lead.service';
import type { LeadInput } from './lead.service';
import type { LeadSource, LeadStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const sourceSchema = z.enum([
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'GOOGLE',
  'WEBSITE',
  'PHONE',
  'WALK_IN',
  'REFERRAL',
  'MANUAL',
  'CSV_IMPORT',
  'CAMPAIGN',
  'OTHER',
]);

const statusSchema = z.enum(['NEW', 'CONTACTED', 'INTERESTED', 'APPOINTMENT_BOOKED', 'VISITED', 'CONVERTED', 'LOST']);

router.get(
  '/',
  requirePermission(PERMISSIONS.LEAD_VIEW),
  validate({
    query: searchQuery.extend({
      status: statusSchema.optional(),
      source: sourceSchema.optional(),
      assignedToId: idSchema.optional(),
      branchId: idSchema.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      dueOnly: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as Record<string, unknown> & { dueOnly?: string };
    const result = await service.listLeads({
      ...(q as Parameters<typeof service.listLeads>[0]),
      dueOnly: q.dueOnly === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      phone: phoneSchema,
      email: z.string().email().optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
      branchId: idSchema.optional(),
      source: sourceSchema.default('MANUAL'),
      sourceDetail: z.string().trim().max(120).optional(),
      campaignId: idSchema.optional(),
      assignedToId: idSchema.optional(),
      interestedServiceIds: z.array(idSchema).max(20).default([]),
      notes: z.string().trim().max(1000).optional(),
      followUpAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const lead = await service.createLead(req.body as LeadInput);
    audit({ action: 'lead.created', entity: 'Lead', entityId: lead.id });
    return created(res, lead);
  }),
);

router.get(
  '/funnel',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.leadFunnel(req.query as never))),
);

router.post(
  '/import',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({
    body: z.object({
      rows: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(120),
            phone: z.string().trim().min(6).max(20),
            email: z.string().trim().max(160).optional(),
            source: sourceSchema.optional(),
            notes: z.string().trim().max(500).optional(),
          }),
        )
        .min(1)
        .max(10000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = req.body as { rows: { name: string; phone: string; source?: LeadSource }[] };
    return ok(res, await service.importLeads(rows));
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.LEAD_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getLead(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().max(120).optional(),
      phone: phoneSchema.optional(),
      email: z.string().email().optional(),
      status: statusSchema.optional(),
      assignedToId: idSchema.optional(),
      followUpAt: z.coerce.date().optional(),
      notes: z.string().trim().max(1000).optional(),
      lostReason: z.string().trim().max(240).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const lead = await service.updateLead(req.params.id!, req.body as Partial<LeadInput> & { status?: LeadStatus });
    audit({ action: 'lead.updated', entity: 'Lead', entityId: lead.id, after: req.body });
    return ok(res, lead);
  }),
);

router.post(
  '/:id/activities',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      type: z.enum(['CALL', 'WHATSAPP', 'NOTE', 'STATUS_CHANGE', 'APPOINTMENT']),
      notes: z.string().trim().max(1000).optional(),
      followUpAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await service.addActivity(req.params.id!, req.body as never))),
);

router.post(
  '/:id/convert',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({
    params: idParam,
    body: z.object({ branchId: idSchema.optional(), preferredStaffId: idSchema.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const customer = await service.convertLead(req.params.id!, req.body as never);
    audit({ action: 'lead.converted', entity: 'Lead', entityId: req.params.id!, after: { customerId: customer.id } });
    return ok(res, customer);
  }),
);

router.post(
  '/:id/lost',
  requirePermission(PERMISSIONS.LEAD_MANAGE),
  validate({ params: idParam, body: z.object({ reason: z.string().trim().min(1).max(240) }) }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body as { reason: string };
    return ok(res, await service.markLost(req.params.id!, reason));
  }),
);

export default router;
