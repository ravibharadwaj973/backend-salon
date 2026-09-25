import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, localDateTime, moneySchema, paginationQuery } from '../../core/validators';
import { BadRequest, NotFound } from '../../core/errors';
import * as segments from './segment.service';
import { FIELD_GROUPS, SEGMENT_FIELDS, SEGMENT_PRESETS } from './segment-fields';
import * as campaigns from './campaign.service';
import * as journeys from './journey.service';
import * as journeyAnalytics from './journey-analytics.service';
import * as templates from './template.service';
import * as templateMeta from './template-meta.service';
import { prisma } from '../../core/prisma';
import type { SegmentRules } from './segment.service';
import type { CampaignInput } from './campaign.service';
import type { JourneyInput } from './journey.service';
import type { TemplateInput } from './template.service';
import type { Channel, MessageStatus, TemplateCategory } from '@prisma/client';
import { parseStatusFilter } from './message-filter';
import { campaignReadiness } from '../../messaging/template-variables';
import { OBJECTIVES, WINDOW_CHOICES } from './attribution';
import { campaignAudienceCounts } from './campaign-audiences';

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

/**
 * What you can segment on, and the ready-made lists. Served rather than
 * duplicated in the client, so the builder can never offer a field the rule
 * compiler does not understand.
 */
segmentRouter.get(
  '/fields',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  asyncHandler(async (_req, res) =>
    ok(res, { fields: SEGMENT_FIELDS, groups: FIELD_GROUPS, presets: SEGMENT_PRESETS }),
  ),
);

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

segmentRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await segments.getSegment(req.params.id!))),
);

/**
 * Hand-picked membership.
 *
 * Rules answer "everyone who has not been in for 60 days". They cannot answer
 * "these nine, because I know them", and that list is the one a salon owner
 * most often has in their head. Only a segment created as hand-picked accepts
 * these; on a rule the service refuses and says why, rather than accepting an
 * edit the next run would silently undo.
 */
segmentRouter.post(
  '/:id/members',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      customerId: idSchema.optional(),
      customerIds: z.array(idSchema).min(1).max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { customerId?: string; customerIds?: string[] };
    if (body.customerIds?.length) {
      return ok(res, await segments.addSegmentMembers(req.params.id!, body.customerIds));
    }
    if (!body.customerId) throw BadRequest('Name a customer to add.');
    return ok(res, await segments.addSegmentMember(req.params.id!, body.customerId));
  }),
);

segmentRouter.delete(
  '/:id/members/:customerId',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam.extend({ customerId: idSchema }) }),
  asyncHandler(async (req, res) =>
    ok(res, await segments.removeSegmentMember(req.params.id!, req.params.customerId!)),
  ),
);

/**
 * What a saved segment can actually reach, per channel.
 *
 * Separate from the segment's own size because they are different numbers and
 * the difference is the whole point: a 2,400-customer segment might be 2,380
 * on WhatsApp and 900 on email. The confirmation before a send asks this, so
 * the figure shown is the figure that goes out.
 */
segmentRouter.get(
  '/:id/reach',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    params: idParam,
    query: z.object({
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']).default('MARKETING'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { category } = req.query as unknown as { category: TemplateCategory };
    return ok(res, await segments.segmentReach(req.params.id!, category));
  }),
);

/**
 * The people a segment matches. A count nobody can look behind is a count
 * nobody trusts, and a rule that is subtly wrong is invisible until you read
 * the names it picked.
 */
segmentRouter.get(
  '/:id/members',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW, PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const result = await segments.segmentMembers(req.params.id!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
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


/**
 * The campaign objectives, with the window each one starts from.
 *
 * Served rather than hard-coded in the browser so the suggestion, the reason
 * shown beside it and the value actually saved all come from one place.
 */
campaignRouter.get(
  '/objectives',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  asyncHandler(async (_req, res) => ok(res, { objectives: OBJECTIVES, windowChoices: WINDOW_CHOICES })),
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
      // Read in the salon's timezone, not the server's: a datetime-local
      // field carries no timezone, and reading it as UTC sent every scheduled
      // campaign five and a half hours late.
      scheduledAt: localDateTime.optional(),
      costPerMessage: moneySchema.default(0),
      variables: z.record(z.string()).optional(),
      objective: z
        .enum(['REMINDER', 'REBOOKING', 'AWARENESS', 'WINBACK', 'BIRTHDAY', 'RENEWAL', 'FESTIVAL', 'REACTIVATION', 'OTHER'])
        .optional(),
      // Capped at half a year. Past that the window stops measuring a campaign
      // and starts collecting every visit a customer was going to make anyway.
      attributionWindowDays: z.coerce.number().int().min(1).max(180).optional(),
      conversionEvents: z.array(z.enum(['BOOKING', 'VISIT', 'REVENUE'])).min(1).optional(),
      /** Follow up on an earlier campaign's recipients instead of a segment. */
      followUpOfId: idSchema.optional(),
      followUpAudience: z.enum(['NOT_DELIVERED', 'DELIVERED_NOT_READ', 'READ_NOT_ENGAGED', 'ENGAGED_NOT_BOOKED', 'BOOKED_NOT_VISITED', 'VISITED']).optional(),
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
  validate({ params: idParam, body: z.object({ sendAt: localDateTime.optional() }) }),
  asyncHandler(async (req, res) => {
    const { sendAt } = req.body as { sendAt?: Date };
    const campaign = await campaigns.launchCampaign(req.params.id!, sendAt);
    audit({ action: 'campaign.launched', entity: 'Campaign', entityId: campaign.id, after: { sendAt } });
    return ok(res, campaign);
  }),
);

/**
 * Send it again — as a copy.
 *
 * A finished campaign's numbers belong to one send, so re-running the row
 * would mix two attempts into one ROI figure, which is the only figure the
 * campaigns screen exists to show. The copy is a DRAFT: the audience and the
 * wording usually want a look before a second send, and a button that quietly
 * messages a few hundred people is the wrong button to build.
 */
campaignRouter.post(
  '/:id/duplicate',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const campaign = await campaigns.duplicateCampaign(req.params.id!);
    audit({ action: 'campaign.duplicated', entity: 'Campaign', entityId: campaign.id, after: { from: req.params.id } });
    return created(res, campaign);
  }),
);

campaignRouter.post(
  '/:id/pause',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await campaigns.pauseCampaign(req.params.id!))),
);


/**
 * WHAT EACH RECIPIENT DID, GROUPED.
 *
 * Computed live rather than read from the campaign's stored attribution, which
 * only runs once the window closes — a day-3 follow-up would otherwise see
 * zeros everywhere and treat the people who converted fastest as the ones most
 * in need of chasing.
 */
campaignRouter.get(
  '/:id/audiences',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await campaignAudienceCounts(req.params.id!))),
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

/**
 * Registered ABOVE '/:id' on purpose: Express matches in order, so a route
 * added below it would be read as a journey whose id is the literal word
 * "overview".
 */
journeyRouter.get(
  '/overview',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    return ok(res, await journeyAnalytics.journeyOverview(q));
  }),
);

journeyRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await journeys.getJourney(req.params.id!))),
);

journeyRouter.get(
  '/:id/performance',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam, query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    const result = await journeyAnalytics.journeyPerformance(req.params.id!, q);
    if (!result) throw NotFound('Automation');
    return ok(res, result);
  }),
);

journeyRouter.get(
  '/:id/messages',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: idParam, query: paginationQuery.extend({ status: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; status?: string };
    const result = await journeyAnalytics.journeyMessages(req.params.id!, q);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
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

/**
 * A template's buttons, shaped rather than waved through.
 *
 * Shared by create and update on purpose: update validated the whole body as
 * z.record(z.unknown()), so a button create would have refused could be written
 * by editing the same template a moment later. The send path reads `variable`
 * and `url` off these, and a malformed one becomes a template Meta approves and
 * a link that opens nothing.
 */
const templateButtonsSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('URL'),
        text: z.string().trim().min(1).max(25),
        url: z.string().trim().url().max(2000),
        variable: z.string().trim().max(40).nullable().optional(),
      }),
      z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25) }),
      z.object({
        type: z.literal('PHONE_NUMBER'),
        text: z.string().trim().min(1).max(25),
        phone: z.string().trim().min(8).max(20),
      }),
    ]),
  )
  .max(10);

export const templateRouter = Router();
templateRouter.use(authenticate);

templateRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: paginationQuery.extend({
      channel: channelSchema.optional(),
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']).optional(),
      // Archived templates are hidden unless asked for. A query string carries
      // strings, so "true" is the value that arrives.
      includeArchived: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
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
      buttons: templateButtonsSchema.optional(),
      variables: z.array(z.string().max(40)).max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await templates.createTemplate(req.body as TemplateInput))),
);

/**
 * Top the salon up with any starter templates it does not have.
 *
 * Idempotent, and never overwrites: a salon that has rewritten a message keeps
 * its own words. This exists because seeding happens once at signup, so a
 * salon created before the email and SMS starters existed had an empty picker
 * on those tabs with no way to fill it but typing.
 */
templateRouter.post(
  '/restore-defaults',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  asyncHandler(async (_req, res) => {
    const result = await templates.restoreDefaultTemplates();
    audit({ action: 'template.defaults_restored', entity: 'MessageTemplate' });
    return ok(res, result);
  }),
);

/**
 * Send a template to Meta for review, and hand back what Meta said.
 *
 * Deliberately a separate press from saving. Submitting cannot be undone in the
 * way that matters — the name is consumed, a template cannot be renamed
 * afterwards, and deleting one to correct a name restarts review — so it is not
 * something to do on a salon's behalf while they are still typing.
 */
templateRouter.post(
  '/:id/submit-to-meta',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await templateMeta.submitTemplateToMeta(req.params.id!);
    audit({
      action: 'template.submitted_to_meta',
      entity: 'MessageTemplate',
      entityId: req.params.id!,
      after: { ok: result.ok, metaId: result.meta?.id, status: result.meta?.status },
    });
    return ok(res, result);
  }),
);

/**
 * Ask Meta what this token can see, and say which thing is wrong.
 *
 * Read-only. Exists because Meta answers a wrong id, an unassigned asset, a
 * missing scope and a System User in the wrong Business Portfolio with one
 * identical sentence, and will not say which.
 */
templateRouter.get(
  '/meta-access',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  asyncHandler(async (_req, res) => ok(res, await templateMeta.diagnoseWhatsAppAccess())),
);

/**
 * Create a local template from one Meta already holds.
 *
 * The lossy direction: Meta stores {{1}}, we store {{customer_name}}, and
 * nothing in the API records which is which. Positions whose example value has
 * an unambiguous shape are matched; the rest are imported as unmapped and the
 * template is refused by the send guard until somebody names them.
 */
templateRouter.post(
  '/import-from-meta',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(512),
      language: z.string().trim().min(2).max(8),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { name, language } = req.body as { name: string; language: string };
    const result = await templateMeta.importTemplateFromMeta({ name, language });
    audit({
      action: 'template.imported_from_meta',
      entity: 'MessageTemplate',
      entityId: result.templateId,
      after: { name, language, ok: result.ok },
    });
    return ok(res, result);
  }),
);

/** Ask Meta what it decided, for every WhatsApp template on the account. */
templateRouter.post(
  '/sync-from-meta',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  asyncHandler(async (_req, res) => {
    const result = await templateMeta.syncTemplatesFromMeta();
    audit({ action: 'template.synced_from_meta', entity: 'MessageTemplate', after: { updated: result.updated.length } });
    return ok(res, result);
  }),
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
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      channel: channelSchema.optional(),
      category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']).optional(),
      language: z.string().max(8).optional(),
      providerTemplateName: z.string().trim().max(120).optional(),
      headerText: z.string().trim().max(200).nullable().optional(),
      bodyText: z.string().trim().min(1).max(2000).optional(),
      footerText: z.string().trim().max(200).nullable().optional(),
      buttons: templateButtonsSchema.optional(),
      variables: z.array(z.string().max(40)).max(30).optional(),
      approvalStatus: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED']).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await templates.updateTemplate(req.params.id!, req.body as Partial<TemplateInput>))),
);

/**
 * Archive by default; ?permanent=true really deletes.
 *
 * Permanent is refused while Meta still holds the template — see
 * deleteTemplate — so the only things it can destroy are templates Meta does
 * not have.
 */
templateRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({
    params: idParam,
    query: z.object({
      permanent: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
    }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, await templates.deleteTemplate(req.params.id!, { permanent: (req.query as { permanent?: boolean }).permanent })),
  ),
);

/**
 * Put one template back to the wording it ships with.
 *
 * Deliberately per-template and never bulk: it discards whatever the salon
 * wrote there, so it is an answer to "this one is out of date", not a
 * housekeeping job that runs over everything they have edited.
 */
templateRouter.post(
  '/:id/reset',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await templates.resetTemplateToDefault(req.params.id!);
    audit({ action: 'template.reset', entity: 'MessageTemplate', entityId: result.id });
    return ok(res, result);
  }),
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


/**
 * WHAT THIS TEMPLATE WILL NEED BEFORE IT CAN BE SENT TO A LIST.
 *
 * Asked by the campaign composer the moment a template is chosen, so the sender
 * is shown the boxes to fill before picking an audience — rather than finding
 * out afterwards, once per recipient, that nothing went out.
 *
 * Values already entered are posted along, so the answer says what is STILL
 * missing rather than what was ever missing.
 */
templateRouter.post(
  '/:id/campaign-readiness',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    params: idParam,
    body: z.object({ variables: z.record(z.string().max(60), z.string().max(1000)).default({}) }),
  }),
  asyncHandler(async (req, res) => {
    const template = await prisma.messageTemplate.findUnique({ where: { id: req.params.id! } });
    if (!template) throw NotFound('Template');

    const readiness = campaignReadiness(
      [template.bodyText, template.headerText, JSON.stringify(template.buttons ?? [])],
      (req.body as { variables: Record<string, string> }).variables,
    );

    return ok(res, {
      templateId: template.id,
      templateName: template.name,
      channel: template.channel,
      category: template.category,
      ...readiness,
    });
  }),
);

export const messageRouter = Router();
messageRouter.use(authenticate);

messageRouter.get(
  '/',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({
    query: paginationQuery.extend({
      customerId: idSchema.optional(),
      /// Narrow the log to one campaign's sends — the link from a campaign's
      /// page lands here, so the reasons live in one table rather than two.
      campaignId: idSchema.optional(),
      /// The same, for an automation. An automation's messages hang off its
      /// runs rather than off the journey directly, so this filters through
      /// the run — without it the link from an automation's page would have
      /// nowhere to land.
      journeyId: idSchema.optional(),
      channel: channelSchema.optional(),
      /// One status, or several separated by commas — "everything that went
      /// wrong" is BOUNCED,COMPLAINED,FAILED and is one filter to a human.
      /// Parsed here rather than cast, so a typed-in status cannot reach
      /// Prisma as an unknown enum value and turn the page into a 500.
      status: z.string().optional().transform(parseStatusFilter),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      customerId?: string;
      campaignId?: string;
      journeyId?: string;
      channel?: Channel;
      status: MessageStatus[];
      from?: Date;
      to?: Date;
    };

    const where = {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(q.journeyId ? { journeyRun: { journeyId: q.journeyId } } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status.length ? { status: { in: q.status } } : {}),
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
          campaign: { select: { id: true, name: true } },
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
      /**
       * What the message is ABOUT, without which an invoice email is a set of
       * colons with nothing after them.
       *
       * The share sheet has always known the invoice — the preview screen takes
       * it and renders the real numbers — and then sent without it, so what the
       * salon read on screen and what the customer received were two different
       * messages. The preview was right and the send was empty.
       */
      invoiceId: idSchema.optional(),
      appointmentId: idSchema.optional(),
      membershipId: idSchema.optional(),
      templateId: idSchema.optional(),
      body: z.string().trim().max(2000).optional(),
      variables: z.record(z.string()).optional(),
      objective: z
        .enum(['REMINDER', 'REBOOKING', 'AWARENESS', 'WINBACK', 'BIRTHDAY', 'RENEWAL', 'FESTIVAL', 'REACTIVATION', 'OTHER'])
        .optional(),
      // Capped at half a year. Past that the window stops measuring a campaign
      // and starts collecting every visit a customer was going to make anyway.
      attributionWindowDays: z.coerce.number().int().min(1).max(180).optional(),
      conversionEvents: z.array(z.enum(['BOOKING', 'VISIT', 'REVENUE'])).min(1).optional(),
      /** Follow up on an earlier campaign's recipients instead of a segment. */
      followUpOfId: idSchema.optional(),
      followUpAudience: z.enum(['NOT_DELIVERED', 'DELIVERED_NOT_READ', 'READ_NOT_ENGAGED', 'ENGAGED_NOT_BOOKED', 'BOOKED_NOT_VISITED', 'VISITED']).optional(),
      toAddress: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { queueMessage } = await import('../../messaging/dispatcher');
    const body = req.body as {
      channel: Channel;
      customerId?: string;
      leadId?: string;
      invoiceId?: string;
      appointmentId?: string;
      membershipId?: string;
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
