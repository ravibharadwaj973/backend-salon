import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery } from '../../core/validators';
import * as segments from './segment.service';
import * as campaigns from './campaign.service';
import * as journeys from './journey.service';
import * as templates from './template.service';
import { prisma } from '../../core/prisma';
import type { SegmentRules } from './segment.service';
import type { CampaignInput } from './campaign.service';
import type { JourneyInput } from './journey.service';
import type { TemplateInput } from './template.service';
import type { Channel } from '@prisma/client';

const channelSchema = z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP']);

const rulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z
    .array(
      z.object({
        field: z.string().trim().min(1).max(40),
        op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'has', 'between', 'before', 'after', 'isNull', 'notNull']),
        value: z.unknown().optional(),
      }),
    )
    .max(30),
});

// ------------------------------------------------------------- segments ----

export const segmentRouter = Router();
segmentRouter.use(authenticate);

segmentRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const result = await segments.listSegments(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

segmentRouter.post(
  '/',
  requirePermission(PERMISSIONS.SEGMENT_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      rules: rulesSchema,
      isDynamic: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const segment = await segments.createSegment(req.body as { name: string; rules: SegmentRules });
    audit({ action: 'segment.created', entity: 'Segment', entityId: segment.id });
    return created(res, segment);
  }),
);

segmentRouter.post(
  '/preview',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ body: z.object({ rules: rulesSchema, branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { rules, branchId } = req.body as { rules: SegmentRules; branchId?: string };
    return ok(res, await segments.previewSegment(rules, branchId));
  }),
);

segmentRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.SEGMENT_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().max(120).optional(),
      description: z.string().trim().max(500).optional(),
      rules: rulesSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await segments.updateSegment(req.params.id!, req.body as never))),
);

segmentRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.SEGMENT_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await segments.deleteSegment(req.params.id!);
    return noContent(res);
  }),
);

segmentRouter.post(
  '/:id/snapshot',
  requirePermission(PERMISSIONS.SEGMENT_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await segments.snapshotSegment(req.params.id!))),
);

// ------------------------------------------------------------ campaigns ----

export const campaignRouter = Router();
campaignRouter.use(authenticate);

campaignRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: paginationQuery.extend({
      status: z.enum(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
      channel: channelSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await campaigns.listCampaigns(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

campaignRouter.post(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      channel: channelSchema,
      templateId: idSchema.optional(),
      segmentId: idSchema.optional(),
      branchId: idSchema.optional(),
      scheduledAt: z.coerce.date().optional(),
      costPerMessage: moneySchema.default(0),
      attributionWindowDays: z.coerce.number().int().min(1).max(90).default(14),
      variables: z.record(z.string()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.createCampaign(req.body as CampaignInput);
    audit({ action: 'campaign.created', entity: 'Campaign', entityId: campaign.id });
    return created(res, campaign);
  }),
);

campaignRouter.get(
  '/roi',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await campaigns.marketingRoi(req.query as never))),
);

campaignRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await campaigns.getCampaign(req.params.id!))),
);

campaignRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam, body: z.record(z.unknown()) }),
  asyncHandler(async (req, res) => ok(res, await campaigns.updateCampaign(req.params.id!, req.body as never))),
);

campaignRouter.post(
  '/:id/launch',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE, PERMISSIONS.MESSAGE_SEND),
  validate({ params: idParam, body: z.object({ sendAt: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const { sendAt } = req.body as { sendAt?: Date };
    const campaign = await campaigns.launchCampaign(req.params.id!, sendAt);
    audit({ action: 'campaign.launched', entity: 'Campaign', entityId: campaign.id, after: { sendAt } });
    return ok(res, campaign);
  }),
);

campaignRouter.post(
  '/:id/pause',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await campaigns.pauseCampaign(req.params.id!))),
);

campaignRouter.get(
  '/:id/messages',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { page = 1, pageSize = 25 } = req.query as unknown as { page: number; pageSize: number };
    const [items, total] = await Promise.all([
      prisma.messageLog.findMany({
        where: { campaignId: req.params.id! },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { queuedAt: 'desc' },
        include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true } } },
      }),
      prisma.messageLog.count({ where: { campaignId: req.params.id! } }),
    ]);
    return paginated(res, items, total, page, pageSize);
  }),
);

// ------------------------------------------------------------- journeys ----

export const journeyRouter = Router();
journeyRouter.use(authenticate);

const stepSchema = z.object({
  actionType: z.enum([
    'SEND_MESSAGE',
    'ADD_TAG',
    'REMOVE_TAG',
    'ADD_LOYALTY_POINTS',
    'CREATE_TASK',
    'ADD_TO_SEGMENT',
    'WAIT',
    'EXIT_IF_BOOKED',
  ]),
  delayMinutes: z.coerce.number().int().min(0).max(525_600).default(0),
  channel: channelSchema.optional(),
  templateId: idSchema.optional(),
  config: z.record(z.unknown()).optional(),
  condition: z.record(z.unknown()).optional(),
});

journeyRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: paginationQuery.extend({ isActive: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; isActive?: string };
    const result = await journeys.listJourneys({
      page: q.page,
      pageSize: q.pageSize,
      isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

journeyRouter.post(
  '/',
  requirePermission(PERMISSIONS.JOURNEY_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
      trigger: z.enum([
        'APPOINTMENT_BOOKED',
        'APPOINTMENT_REMINDER',
        'APPOINTMENT_COMPLETED',
        'APPOINTMENT_CANCELLED',
        'FIRST_VISIT',
        'INVOICE_PAID',
        'NO_VISIT_DAYS',
        'MEMBERSHIP_EXPIRING',
        'PACKAGE_EXPIRING',
        'BIRTHDAY',
        'ANNIVERSARY',
        'LEAD_CREATED',
        'REVIEW_REQUEST',
        'MANUAL',
      ]),
      triggerConfig: z.record(z.unknown()).optional(),
      audienceRules: rulesSchema.optional(),
      isActive: z.boolean().default(false),
      steps: z.array(stepSchema).min(1).max(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const journey = await journeys.createJourney(req.body as JourneyInput);
    audit({ action: 'journey.created', entity: 'Journey', entityId: journey.id });
    return created(res, journey);
  }),
);

journeyRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await journeys.getJourney(req.params.id!))),
);

journeyRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.JOURNEY_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().max(120).optional(),
      description: z.string().trim().max(500).optional(),
      triggerConfig: z.record(z.unknown()).optional(),
      audienceRules: rulesSchema.optional(),
      steps: z.array(stepSchema).min(1).max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await journeys.updateJourney(req.params.id!, req.body as Partial<JourneyInput>))),
);

journeyRouter.post(
  '/:id/activate',
  requirePermission(PERMISSIONS.JOURNEY_MANAGE),
  validate({ params: idParam, body: z.object({ isActive: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const { isActive } = req.body as { isActive: boolean };
    const journey = await journeys.setJourneyActive(req.params.id!, isActive);
    audit({ action: isActive ? 'journey.activated' : 'journey.paused', entity: 'Journey', entityId: journey.id });
    return ok(res, journey);
  }),
);

journeyRouter.get(
  '/:id/runs',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam, query: paginationQuery.extend({ status: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await journeys.listRuns(req.params.id!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

journeyRouter.post(
  '/runs/:id/cancel',
  requirePermission(PERMISSIONS.JOURNEY_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await journeys.cancelRun(req.params.id!))),
);

// ------------------------------------------------------------ templates ----

export const templateRouter = Router();
templateRouter.use(authenticate);

templateRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: paginationQuery.extend({
      channel: channelSchema.optional(),
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await templates.listTemplates(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

templateRouter.post(
  '/',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(120),
      channel: channelSchema,
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']).default('UTILITY'),
      language: z.string().max(8).default('en'),
      providerTemplateName: z.string().trim().max(120).optional(),
      headerText: z.string().trim().max(200).optional(),
      bodyText: z.string().trim().min(1).max(2000),
      footerText: z.string().trim().max(200).optional(),
      buttons: z.array(z.record(z.unknown())).max(5).optional(),
      variables: z.array(z.string().max(40)).max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await templates.createTemplate(req.body as TemplateInput))),
);

templateRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await templates.getTemplate(req.params.id!))),
);

templateRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({ params: idParam, body: z.record(z.unknown()) }),
  asyncHandler(async (req, res) => ok(res, await templates.updateTemplate(req.params.id!, req.body as Partial<TemplateInput>))),
);

templateRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await templates.deleteTemplate(req.params.id!))),
);

templateRouter.post(
  '/:id/preview',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    params: idParam,
    body: z.object({ customerId: idSchema.optional(), variables: z.record(z.string()).optional() }),
  }),
  asyncHandler(async (req, res) => ok(res, await templates.previewTemplate(req.params.id!, req.body as never))),
);

// -------------------------------------------------------------- messages ---

export const messageRouter = Router();
messageRouter.use(authenticate);

messageRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: paginationQuery.extend({
      customerId: idSchema.optional(),
      channel: channelSchema.optional(),
      status: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      customerId?: string;
      channel?: Channel;
      status?: string;
      from?: Date;
      to?: Date;
    };

    const where = {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.from || q.to ? { queuedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.messageLog.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { queuedAt: 'desc' },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
          template: { select: { id: true, name: true, category: true } },
        },
      }),
      prisma.messageLog.count({ where }),
    ]);

    return paginated(res, items, total, q.page, q.pageSize);
  }),
);

messageRouter.post(
  '/send',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate({
    body: z.object({
      channel: channelSchema,
      customerId: idSchema.optional(),
      leadId: idSchema.optional(),
      templateId: idSchema.optional(),
      body: z.string().trim().max(2000).optional(),
      variables: z.record(z.string()).optional(),
      toAddress: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { queueMessage } = await import('../../messaging/dispatcher');
    const body = req.body as {
      channel: Channel;
      customerId?: string;
      leadId?: string;
      templateId?: string;
      body?: string;
      variables?: Record<string, string>;
      toAddress?: string;
    };
    const log = await queueMessage({ tenantId: req.auth!.tenantId, branchId: req.branchId ?? null, ...body });
    audit({ action: 'message.sent', entity: 'MessageLog', entityId: log?.id ?? null });
    return created(res, log);
  }),
);

export default campaignRouter;
