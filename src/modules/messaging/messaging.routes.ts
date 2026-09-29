import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import * as library from './library.service';
import * as setup from './setup.service';
import * as share from './share.service';
import * as conversations from './conversation.service';

export const messagingRouter = Router();

messagingRouter.use(authenticate);

// ---------------------------------------------------------------- library --

const browseQuery = z.object({
  occasion: z.string().trim().max(40).optional(),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']).optional(),
  q: z.string().trim().max(120).optional(),
});

/** The ready-written templates a salon can install and then edit. */
messagingRouter.get(
  '/library',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: browseQuery }),
  asyncHandler(async (req, res) =>
    ok(res, await library.browseLibrary(req.query as { occasion?: string; channel?: string; q?: string })),
  ),
);

messagingRouter.post(
  '/library/:key/install',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({
    params: z.object({ key: z.string().trim().min(1).max(60) }),
    body: z.object({
      name: z.string().trim().max(120).optional(),
      bodyText: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const template = await library.installTemplate(req.params.key!, req.body as library.InstallOptions);
    audit({ action: 'template.installed', entity: 'MessageTemplate', entityId: template.id, after: { name: template.name } });
    return created(res, template);
  }),
);

/** "Set up all my festival messages" — installs a whole group at once. */
messagingRouter.post(
  '/library/occasions/:occasion/install',
  requirePermission(PERMISSIONS.TEMPLATE_MANAGE),
  validate({ params: z.object({ occasion: z.string().trim().min(1).max(40) }) }),
  asyncHandler(async (req, res) => {
    const result = await library.installOccasion(req.params.occasion!);
    audit({ action: 'template.installed_group', entity: 'MessageTemplate', after: result });
    return created(res, result);
  }),
);

// ------------------------------------------------------------------ share --

const previewSchema = z.object({
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  customerId: z.string().min(1).optional(),
  leadId: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  body: z.string().trim().max(2000).optional(),
  variables: z.record(z.string()).optional(),
  invoiceId: z.string().min(1).optional(),
  appointmentId: z.string().min(1).optional(),
});

/**
 * What this exact customer would receive, before anyone presses send: the
 * rendered text, whether they have consented, whether the channel is actually
 * connected, what allowance is left, and a wa.me link for sending it by hand.
 */
messagingRouter.post(
  '/share/preview',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate({ body: previewSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await share.previewShare(req.auth!.tenantId, req.body as share.SharePreviewInput)),
  ),
);

// ------------------------------------------------------------- automations --

/**
 * What a salon can build an automation on. Served so the builder cannot offer
 * a trigger the job runner has never heard of.
 */
messagingRouter.get(
  '/automation-triggers',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  asyncHandler(async (_req, res) => ok(res, setup.listTriggers())),
);

/** Every automation with its current timing, in the words an owner would use. */
messagingRouter.get(
  '/automations',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  asyncHandler(async (req, res) => ok(res, await setup.listAutomations(req.auth!.tenantId))),
);

const timingSchema = z.object({
  isActive: z.boolean().optional(),
  /** For NO_VISIT_DAYS, MEMBERSHIP_EXPIRING, BIRTHDAY and friends. */
  days: z.coerce.number().int().min(0).max(730).optional(),
  /** Per-step delays, keyed by step id, in minutes. */
  stepDelays: z.record(z.coerce.number().int().min(0).max(60 * 24 * 90)).optional(),
  /** Only send between these hours, so nobody is woken at 6am. */
  sendAfterHour: z.coerce.number().int().min(0).max(23).optional(),
  sendBeforeHour: z.coerce.number().int().min(0).max(23).optional(),
  /** Which channel each step sends on — the salon's choice, per step. */
  stepChannels: z.record(z.enum(['WHATSAPP', 'SMS', 'EMAIL'])).optional(),
  /** Which template each step sends. Null clears it back to free text. */
  stepTemplates: z.record(z.string().min(1).nullable()).optional(),
});

messagingRouter.patch(
  '/automations/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_MANAGE),
  validate({ params: z.object({ id: z.string().min(1) }), body: timingSchema }),
  asyncHandler(async (req, res) => {
    const journey = await setup.updateAutomation(req.params.id!, req.body as setup.AutomationTiming);
    audit({ action: 'journey.timing_changed', entity: 'Journey', entityId: journey.id, after: req.body });
    return ok(res, journey);
  }),
);

// ----------------------------------------------------------------- sending --

/**
 * The salon's own sending accounts. Secrets are write-only: they go in, and the
 * API only ever returns whether something is connected and the last four
 * characters, so a screen-share or a browser cache cannot leak a token.
 */
messagingRouter.get(
  '/setup',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await setup.getMessagingSetup(req.auth!.tenantId))),
);

/**
 * An email field the salon left blank.
 *
 * The form sends every field on every save, so an untouched box arrives as ""
 * -- and z.string().email() refuses "". The result was that filling in the
 * email settings and leaving Reply-to alone, which the form itself labels
 * Optional, failed validation and saved NOTHING. Not the address, not the key.
 * The screen then reported the SERVER's missing variables, because from the
 * database's point of view the salon had configured nothing, which sent
 * everybody looking in the wrong place entirely.
 *
 * So "" means "not provided" here, exactly as an absent field does.
 */
const optionalEmail = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .trim()
    .email('that does not look like an email address — it should read like name@yourdomain.com')
    .max(160)
    .optional(),
);

const setupSchema = z.object({
  whatsapp: z
    .object({
      phoneNumberId: z.string().trim().max(60).optional(),
      businessId: z.string().trim().max(60).optional(),
      accessToken: z.string().trim().max(500).optional(),
      displayNumber: z.string().trim().max(24).optional(),
    })
    .optional(),
  sms: z
    .object({
      senderId: z.string().trim().max(12).optional(),
      apiKey: z.string().trim().max(200).optional(),
      dltEntityId: z.string().trim().max(60).optional(),
      route: z.string().trim().max(8).optional(),
    })
    .optional(),
  email: z
    .object({
      fromName: z.string().trim().max(80).optional(),
      fromAddress: optionalEmail,
      apiKey: z.string().trim().max(200).optional(),
      replyTo: optionalEmail,
    })
    .optional(),
});

messagingRouter.put(
  '/setup',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate({ body: setupSchema }),
  asyncHandler(async (req, res) => {
    const result = await setup.updateMessagingSetup(req.auth!.tenantId, req.body as setup.MessagingSetupInput);
    // The values themselves are never audited — only that a change happened.
    audit({ action: 'messaging.setup_changed', entity: 'TenantMessagingConfig', entityId: result.id, after: { channels: Object.keys(req.body as object) } });
    return ok(res, result);
  }),
);

/** Send one message to the owner's own number to prove a channel works. */
messagingRouter.post(
  '/setup/test',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate({
    body: z.object({
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
      to: z.string().trim().min(5).max(160),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { channel, to } = req.body as { channel: 'WHATSAPP' | 'SMS' | 'EMAIL'; to: string };
    return ok(res, await setup.sendTestMessage(req.auth!.tenantId, channel, to));
  }),
);

export default messagingRouter;

// ---------------------------------------------------------- conversations --

/**
 * THE SHARED THREAD.
 *
 * One conversation per customer, which the assistant and the salon's staff both
 * work in. Everything here is about the same rows the webhook and the dispatcher
 * already write — nothing on this router copies a message anywhere.
 *
 * Reading needs CAMPAIGN_VIEW, the same permission that already governs the
 * inbound list, because it is the same customer messages. Speaking needs
 * MESSAGE_SEND, and so does taking a thread over: deciding that a machine stops
 * answering a customer is the same kind of authority as answering them.
 */
const conversationListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  /** The queue that actually gets opened: threads waiting for a person. */
  needsAttentionOnly: z.coerce.boolean().optional(),
});

messagingRouter.get(
  '/conversations',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ query: conversationListQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof conversationListQuery>;
    const result = await conversations.listConversations({
      tenantId: req.ctx!.tenantId!,
      ...q,
    });
    return ok(res, result.data, {
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 25,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / (q.pageSize ?? 25))),
      hasMore: (q.page ?? 1) * (q.pageSize ?? 25) < result.total,
    });
  }),
);

const conversationId = z.object({ id: z.string().min(1) });

/**
 * One thread, with the state a reply box needs.
 *
 * `window` travels with the messages deliberately. A screen that draws a
 * composer without knowing whether Meta will accept free text is a screen that
 * lets somebody write a paragraph and then discover it cannot be sent.
 */
messagingRouter.get(
  '/conversations/:id',
  requirePermission(PERMISSIONS.CAMPAIGN_VIEW),
  validate({ params: conversationId }),
  asyncHandler(async (req, res) => {
    return ok(res, await conversations.readConversation(req.ctx!.tenantId!, req.params.id!));
  }),
);

messagingRouter.post(
  '/conversations/:id/messages',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate({
    params: conversationId,
    body: z.object({ body: z.string().trim().min(1).max(4000) }),
  }),
  asyncHandler(async (req, res) => {
    const result = await conversations.sendStaffReply({
      tenantId: req.ctx!.tenantId!,
      conversationId: req.params.id!,
      userId: req.ctx!.userId!,
      body: (req.body as { body: string }).body,
    });
    audit({
      action: 'conversation.reply',
      entity: 'Conversation',
      entityId: req.params.id!,
      after: { sent: result.sent },
    });
    return created(res, result);
  }),
);

/**
 * Take it over, or give it back.
 *
 * Two routes rather than one with a flag, because they are not symmetrical:
 * taking over is something staff do in a hurry and must always be allowed, and
 * handing back is a decision that deserves its own name in the audit log.
 */
messagingRouter.post(
  '/conversations/:id/take-over',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate({ params: conversationId }),
  asyncHandler(async (req, res) => {
    await conversations.handToHuman({
      conversationId: req.params.id!,
      assignedToId: req.ctx?.userId ?? null,
      reason: 'taken over by staff',
    });
    audit({ action: 'conversation.take_over', entity: 'Conversation', entityId: req.params.id! });
    return ok(res, { mode: 'HUMAN' });
  }),
);

messagingRouter.post(
  '/conversations/:id/resume-assistant',
  requirePermission(PERMISSIONS.MESSAGE_SEND),
  validate({ params: conversationId }),
  asyncHandler(async (req, res) => {
    await conversations.resumeAssistant(req.params.id!, req.ctx?.userId ?? null);
    audit({ action: 'conversation.resume_assistant', entity: 'Conversation', entityId: req.params.id! });
    return ok(res, { mode: 'AI' });
  }),
);
