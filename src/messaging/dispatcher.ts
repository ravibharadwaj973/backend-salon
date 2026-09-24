import type { Channel, ConsentStatus, MessageTemplate, Prisma } from '@prisma/client';
import { prisma } from '../core/prisma';
import { runUnscoped } from '../core/context';
import { logger } from '../core/logger';
import { toE164 } from '../core/ids';
import { addDays, dateKey, dayjs } from '../core/dates';
import { formatINR } from '../core/money';
import { resolveProvider } from './providers';
import { enqueue } from '../jobs/queue';
import { rewriteLinks } from './tracked-links';
import { consume, meterFor } from '../modules/quotas/quota.service';
import { tenantHasFeature } from '../modules/quotas/limits.service';
import { FEATURES } from '../core/features';
import { bookingUrl, feedbackUrl, googleReviewUrl } from '../core/public-links';
import { invoiceUrl } from '../core/public-links';
import type { TemplateButton } from './whatsapp-template-format';
import { publicToken } from '../core/ids';

export interface QueueMessageInput {
  tenantId: string;
  branchId?: string | null;
  channel: Channel;
  customerId?: string | null;
  leadId?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  campaignId?: string | null;
  journeyRunId?: string | null;
  /** Extra values merged over the auto-resolved ones. */
  variables?: Record<string, string>;
  /** Used when no template is given (service-window replies). */
  body?: string;
  toAddress?: string;
  attributionWindowDays?: number;
  cost?: number;
  /** Skip the delay and attempt delivery straight away. */
  sendNow?: boolean;
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(VARIABLE_PATTERN, (_match, key: string) => variables[key] ?? '');
}

export function missingVariables(body: string, variables: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const key = match[1]!;
    if (!variables[key]) missing.push(key);
  }
  return [...new Set(missing)];
}

/**
 * Consent gate. Marketing messages need an explicit opt-in; transactional
 * (utility) messages only need the customer not to have opted out. This is the
 * single place that decides, so no send path can bypass it.
 */
export function consentAllows(
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | 'SERVICE',
  consent: ConsentStatus,
): boolean {
  if (category === 'MARKETING') return consent === 'OPTED_IN';
  return consent !== 'OPTED_OUT';
}

function consentForChannel(
  customer: { whatsappConsent: ConsentStatus; smsConsent: ConsentStatus; emailConsent: ConsentStatus },
  channel: Channel,
): ConsentStatus {
  switch (channel) {
    case 'WHATSAPP':
      return customer.whatsappConsent;
    case 'SMS':
      return customer.smsConsent;
    case 'EMAIL':
      return customer.emailConsent;
    default:
      return 'OPTED_IN';
  }
}

/**
 * Resolves the standard merge variables for a message from whatever context is
 * available (customer, appointment, invoice, membership...).
 */
/**
 * The token for this invoice's public link, minted on first use.
 *
 * Issued here rather than when the invoice is created, so a bill nobody ever
 * shared has no public address at all — the smallest number of guessable URLs
 * in existence is the ones that had to exist.
 *
 * Unscoped because the caller has already established which invoice this is,
 * and a token is not tenant data.
 */
async function ensureInvoiceToken(invoiceId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const token = publicToken();
  await runUnscoped(() => prisma.invoice.update({ where: { id: invoiceId }, data: { publicToken: token } }));
  return token;
}

export async function buildVariables(input: {
  tenantId: string;
  customerId?: string | null;
  leadId?: string | null;
  appointmentId?: string | null;
  invoiceId?: string | null;
  membershipId?: string | null;
  packagePurchaseId?: string | null;
  extra?: Record<string, string>;
}): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { name: true, slug: true, phone: true },
  });
  if (tenant) {
    vars.salon_name = tenant.name;
    vars.salon_phone = tenant.phone;
    vars.booking_link = bookingUrl(tenant.slug);
  }

  if (input.customerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { firstName: true, lastName: true, loyaltyPoints: true, lastVisitAt: true, totalVisits: true, phone: true },
    });
    if (customer) {
      vars.customer_name = customer.firstName;
      vars.customer_full_name = `${customer.firstName} ${customer.lastName ?? ''}`.trim();
      vars.points_balance = String(customer.loyaltyPoints);
      vars.total_visits = String(customer.totalVisits);
      if (customer.lastVisitAt) {
        vars.last_visit_date = dateKey(customer.lastVisitAt);
        vars.days_since_visit = String(dayjs().diff(dayjs(customer.lastVisitAt), 'day'));
      }
    }
  }

  if (input.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, select: { name: true } });
    if (lead) vars.lead_name = lead.name;
  }

  if (input.appointmentId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: input.appointmentId },
      include: {
        branch: { select: { name: true, addressLine: true, city: true, timezone: true } },
        services: { include: { service: { select: { name: true } }, staff: { select: { displayName: true } } } },
      },
    });
    if (appointment) {
      const tz = appointment.branch.timezone;
      vars.appointment_date = dayjs(appointment.startAt).tz(tz).format('DD MMM YYYY');
      vars.appointment_time = dayjs(appointment.startAt).tz(tz).format('h:mm A');
      vars.appointment_day = dayjs(appointment.startAt).tz(tz).format('dddd');
      vars.services = appointment.services.map((s) => s.service.name).join(', ');
      vars.staff_name = appointment.services.find((s) => s.staff)?.staff?.displayName ?? 'our team';
      vars.branch_name = appointment.branch.name;
      vars.branch_address = [appointment.branch.addressLine, appointment.branch.city].filter(Boolean).join(', ');
      vars.feedback_link = feedbackUrl(appointment.id);
      // Routed through the app so the tap is recorded before Google opens.
      vars.google_review_link = googleReviewUrl(appointment.id);
    }
  }

  if (input.invoiceId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: input.invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        grandTotal: true,
        dueAmount: true,
        publicToken: true,
        items: { select: { name: true } },
      },
    });
    if (invoice) {
      vars.invoice_number = invoice.invoiceNumber;
      vars.amount = formatINR(invoice.grandTotal);
      vars.due_amount = formatINR(invoice.dueAmount);
      // Deliberately no pay-online link: money is only ever collected at the
      // counter and recorded by hand. See "Payments" in the README. The link
      // below is the bill to read, not a bill to pay.
      const token = await ensureInvoiceToken(invoice.id, invoice.publicToken);
      vars.invoice_link = invoiceUrl(token);
      // The same thing without the origin, for a WhatsApp URL button — Meta
      // stores the base and appends only this. Putting the full link there
      // produces an address with the origin in it twice.
      vars.invoice_token = token;
      if (!vars.services) vars.services = invoice.items.map((i) => i.name).join(', ');
      vars.last_service = invoice.items[0]?.name ?? 'visit';
    }
  }

  if (input.membershipId) {
    const membership = await prisma.membershipSubscription.findUnique({
      where: { id: input.membershipId },
      include: { plan: { select: { name: true } } },
    });
    if (membership) {
      vars.plan_name = membership.plan.name;
      vars.expiry_date = dateKey(membership.endAt);
      vars.days_left = String(Math.max(0, dayjs(membership.endAt).diff(dayjs(), 'day')));
    }
  }

  if (input.packagePurchaseId) {
    const purchase = await prisma.packagePurchase.findUnique({
      where: { id: input.packagePurchaseId },
      include: { template: { select: { name: true } }, items: true },
    });
    if (purchase) {
      vars.package_name = purchase.template.name;
      vars.expiry_date = dateKey(purchase.expiresAt);
      vars.sessions_left = String(purchase.items.reduce((acc, i) => acc + (i.totalQty - i.usedQty), 0));
    }
  }

  return { ...vars, ...(input.extra ?? {}) };
}

/**
 * Creates the message log row and schedules delivery. Nothing is sent inline:
 * the worker owns delivery so retries and rate limits are handled in one place.
 */
export async function queueMessage(input: QueueMessageInput) {
  let template: MessageTemplate | null = null;

  if (input.templateId) {
    template = await prisma.messageTemplate.findUnique({ where: { id: input.templateId } });
  } else if (input.templateName) {
    template = await prisma.messageTemplate.findFirst({
      where: { tenantId: input.tenantId, name: input.templateName, channel: input.channel },
    });
  }

  const [customer, lead] = await Promise.all([
    input.customerId ? prisma.customer.findUnique({ where: { id: input.customerId } }) : null,
    input.leadId ? prisma.lead.findUnique({ where: { id: input.leadId } }) : null,
  ]);

  // Trimmed, because a field that was typed into and cleared can hold " ",
  // which is truthy and would be handed to the provider as a recipient.
  const raw =
    input.toAddress ??
    (input.channel === 'EMAIL' ? (customer?.email ?? lead?.email ?? '') : (customer?.phone ?? lead?.phone ?? ''));

  const trimmed = raw.trim();
  const toAddress = !trimmed ? '' : input.channel === 'EMAIL' ? trimmed : toE164(trimmed);

  // No address, no message. Returning before the log row is created is what
  // keeps this free: nothing is recorded, nothing is metered, and the salon is
  // not charged for a customer who never had an email address in the first
  // place. Campaigns count these as skipped, which is what they are.
  if (!toAddress) {
    logger.debug(
      { channel: input.channel, customerId: input.customerId, leadId: input.leadId },
      'no address on this channel — nothing queued',
    );
    return null;
  }

  /**
   * The plan gate, and the only one that matters.
   *
   * A salon without the marketing feature sends nothing promotional, on any
   * channel, however the send was started — a campaign, a journey step, a
   * manual push, an API call. It sits above metering deliberately: quota,
   * purchased credits and the overdraft all come later, so none of them can be
   * used to get an offer out on a plan that does not include offers.
   *
   * Recorded rather than thrown. The caller is usually a background job
   * working through a list, and a salon that upgrades should be able to see
   * exactly what was held back and why.
   *
   * WHICH CATEGORY THIS GATE READS, AND WHY IT IS NOT THE SAME ONE AS CONSENT.
   *
   * `category` holds META's verdict, rewritten by every sync. `requestedCategory`
   * holds ours. Three things read a category and they do not want the same
   * answer:
   *
   *   consent  -> Meta's. If Meta calls it marketing, it needs an opt-in.
   *   quota    -> Meta's. That is the conversation Meta bills.
   *   the plan -> OURS. What a plan includes is our promise to the salon.
   *
   * Reading Meta's answer here would let Meta change what a plan includes.
   * A Starter salon's review flow is service by our reckoning and marketing by
   * theirs, and the day they re-filed it every one of those sends would have
   * started failing with PLAN_NO_MARKETING — a feature withdrawn from a paying
   * salon by a third party, with nothing in the app to say why.
   */
  const sellsSomething = template && (template.requestedCategory ?? template.category) === 'MARKETING';

  if (template && sellsSomething && !(await tenantHasFeature(input.tenantId, FEATURES.MARKETING))) {
    logger.info(
      { tenantId: input.tenantId, template: template.name, channel: input.channel },
      'marketing message blocked: plan does not include marketing',
    );
    return prisma.messageLog.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId ?? null,
        channel: input.channel,
        customerId: input.customerId ?? null,
        leadId: input.leadId ?? null,
        campaignId: input.campaignId ?? null,
        journeyRunId: input.journeyRunId ?? null,
        templateId: template.id,
        toAddress,
        status: 'SKIPPED',
        errorCode: 'PLAN_NO_MARKETING',
        errorMessage: 'Marketing messages are not included in this plan. Move to Grow to send offers and campaigns.',
        payload: (input.variables ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  // Consent is checked at queue time so opted-out contacts never enter the queue.
  if (customer && template) {
    const consent = consentForChannel(customer, input.channel);
    if (!consentAllows(template.category, consent)) {
      return prisma.messageLog.create({
        data: {
          tenantId: input.tenantId,
          branchId: input.branchId ?? null,
          channel: input.channel,
          customerId: input.customerId ?? null,
          leadId: input.leadId ?? null,
          campaignId: input.campaignId ?? null,
          journeyRunId: input.journeyRunId ?? null,
          templateId: template.id,
          toAddress,
          status: 'SKIPPED',
          errorCode: 'NO_CONSENT',
          errorMessage: `Customer has not opted in to ${input.channel.toLowerCase()} ${template.category.toLowerCase()} messages`,
          payload: (input.variables ?? {}) as Prisma.InputJsonValue,
        },
      });
    }
  }

  const variables = {
    ...(await buildVariables({
      tenantId: input.tenantId,
      customerId: input.customerId,
      leadId: input.leadId,
    })),
    ...(input.variables ?? {}),
  };

  const body = template ? renderTemplate(template.bodyText, variables) : (input.body ?? '');
  if (!body) {
    logger.warn({ templateId: input.templateId }, 'message has no body');
    return null;
  }

  // Metering sits beside the consent gate, in the one place every send passes
  // through, so no campaign, journey or job can spend an allowance it does not
  // have. The charge happens before the message is queued — a queued message is
  // one that has already been paid for.
  const category = template?.category ?? 'UTILITY';
  const meter = meterFor(input.channel, category);

  // A send that belongs to a campaign or a journey already under way may
  // overdraw in order to finish. Everything else — manual sends, fresh
  // campaigns — is refused the moment the allowance is gone.
  const committed = Boolean(input.campaignId || input.journeyRunId);
  const charge = await consume(input.tenantId, meter, 1, { committed });

  if (!charge.allowed) {
    return prisma.messageLog.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId ?? null,
        channel: input.channel,
        category,
        meter,
        customerId: input.customerId ?? null,
        leadId: input.leadId ?? null,
        campaignId: input.campaignId ?? null,
        journeyRunId: input.journeyRunId ?? null,
        templateId: template?.id ?? null,
        toAddress,
        renderedBody: body,
        payload: variables as Prisma.InputJsonValue,
        status: 'SKIPPED',
        errorCode: 'QUOTA_EXCEEDED',
        errorMessage: charge.reason ?? 'Message allowance exhausted',
      },
    });
  }

  const log = await prisma.messageLog.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId ?? null,
      channel: input.channel,
      category,
      meter,
      customerId: input.customerId ?? null,
      leadId: input.leadId ?? null,
      campaignId: input.campaignId ?? null,
      journeyRunId: input.journeyRunId ?? null,
      templateId: template?.id ?? null,
      toAddress,
      renderedBody: body,
      payload: variables as Prisma.InputJsonValue,
      status: 'QUEUED',
      cost: input.cost ?? 0,
      attributionUntil: addDays(new Date(), input.attributionWindowDays ?? 14),
    },
  });

  await enqueue('message.send', { messageLogId: log.id }, { tenantId: input.tenantId });
  return log;
}

/** Called by the worker: hands the message to the channel provider. */
export async function deliver(messageLogId: string) {
  const log = await runUnscoped(() =>
    prisma.messageLog.findUnique({ where: { id: messageLogId }, include: { template: true } }),
  );
  if (!log) return { ok: false, reason: 'not_found' as const };
  if (log.status !== 'QUEUED') return { ok: false, reason: 'already_processed' as const };

  // Resolved per tenant: the salon's own WhatsApp number, SMS header and email
  // domain, falling back to the platform's only in development.
  const { provider, live } = await resolveProvider(log.channel, log.tenantId);

  if (!live) {
    logger.warn(
      { tenantId: log.tenantId, channel: log.channel },
      'no sending account connected for this channel — message logged, not sent',
    );
  }

  const variables = (log.payload as Record<string, string>) ?? {};

  /**
   * Links are rewritten here rather than at queue time, so a message that is
   * queued and never sent — quota gone, no consent, campaign cancelled — does
   * not leave a tracked link behind that nobody will ever click.
   *
   * The stored body is updated to match what actually went out. A salon
   * reading the log later should see the message the customer saw, tracked
   * link and all, not a tidier version of it.
   */
  const body = await runUnscoped(() =>
    rewriteLinks({
      body: log.renderedBody ?? '',
      tenantId: log.tenantId,
      messageLogId: log.id,
      campaignId: log.campaignId,
      customerId: log.customerId,
    }),
  );

  if (body !== log.renderedBody) {
    await runUnscoped(() =>
      prisma.messageLog.update({ where: { id: log.id }, data: { renderedBody: body } }),
    ).catch(() => undefined);
  }

  /**
   * The order Meta numbered the placeholders in, not the order they happen to
   * appear in today's wording.
   *
   * Meta stores {{1}}, {{2}}; we store {{customer_name}}. metaVariableOrder is
   * recorded at submission and is the only record of which is which. Falling
   * back to `variables` (first-appearance order) is right for a template that
   * predates submission, and quietly wrong for one whose sentence was reordered
   * after approval — there, every customer receives another customer's values,
   * with nothing anywhere reporting an error.
   */
  const orderedVariables =
    log.template?.metaVariableOrder?.length ? log.template.metaVariableOrder : (log.template?.variables ?? []);

  /**
   * A value per button, in button order, holes included.
   *
   * Meta addresses a button's parameter by its position among ALL the buttons,
   * so a static button in front of a dynamic one still occupies an index.
   * Compacting this list would send the invoice token to whichever button came
   * first — accepted by Meta, and opening the wrong page.
   */
  const templateButtons = Array.isArray(log.template?.buttons) ? (log.template.buttons as TemplateButton[]) : [];
  const buttonValues = templateButtons.map((button) =>
    button?.type === 'URL' && button.variable ? (variables[button.variable] ?? null) : null,
  );

  /**
   * The same buttons, for a channel that carries the link itself.
   *
   * WhatsApp gets buttonValues, because Meta holds the approved button and we
   * supply only the tail of its URL. Email has no approved anything: whatever
   * we send IS the message, so each button's whole address is built here --
   * the fixed base plus the variable, exactly as toMetaTemplate splits it --
   * and the provider draws a real button around it.
   *
   * A button whose variable did not resolve is dropped rather than sent as a
   * link ending in nothing. A "View invoice" button that opens the invoice
   * index is worse than no button.
   */
  const links =
    log.channel === 'EMAIL'
      ? templateButtons.flatMap((button) => {
          if (button?.type !== 'URL') return [];
          const suffix = button.variable ? variables[button.variable] : '';
          if (button.variable && !suffix) return [];
          return [{ text: button.text, url: `${button.url}${suffix ?? ''}` }];
        })
      : undefined;

  /**
   * The subject line, which until now was never sent at all.
   *
   * Every seeded email template carries one in headerText and the provider
   * defaulted to "A message from your salon" for all of them, so an invoice, a
   * cancellation and a birthday wish arrived under the same heading and none
   * of them could be found again by searching.
   */
  const subject =
    log.channel === 'EMAIL' && log.template?.headerText
      ? renderTemplate(log.template.headerText, variables).trim() || undefined
      : undefined;

  const result = await provider.send({
    to: log.toAddress,
    channel: log.channel,
    body,
    templateName: log.template?.providerTemplateName ?? null,
    language: log.template?.language ?? 'en',
    variables,
    variableOrder: orderedVariables,
    buttonValues,
    links,
    subject,
  });

  await runUnscoped(() =>
    prisma.messageLog.update({
      where: { id: log.id },
      data: result.ok
        ? {
            status: 'SENT',
            sentAt: new Date(),
            providerMessageId: result.providerMessageId ?? null,
            cost: result.cost ?? log.cost,
          }
        : {
            status: 'FAILED',
            errorCode: result.errorCode ?? 'SEND_FAILED',
            errorMessage: result.errorMessage ?? 'Unknown provider error',
          },
    }),
  );

  if (log.campaignId) {
    await runUnscoped(() =>
      prisma.campaign.update({
        where: { id: log.campaignId! },
        data: result.ok ? { sentCount: { increment: 1 } } : { failedCount: { increment: 1 } },
      }),
    );
  }

  return { ok: result.ok, reason: result.errorMessage };
}

/**
 * How far along the happy path each status is.
 *
 * Providers do not promise ordered delivery of their own callbacks: a click
 * and an open are generated milliseconds apart and can arrive either way
 * round, and a delayed `delivered` can turn up after both. Writing whatever
 * arrived last would walk a message backwards from CLICKED to DELIVERED and
 * quietly corrupt every campaign's open rate.
 *
 * So progress only ever climbs. The endings — bounced, complained, failed —
 * are outside this ladder and handled separately, because they are the truth
 * whenever they arrive.
 */
const PROGRESS: Record<string, number> = {
  QUEUED: 0,
  SENT: 1,
  DELAYED: 2,
  DELIVERED: 3,
  READ: 4,
  CLICKED: 5,
};

/** An ending. Always wins, whatever the row said before. */
const TERMINAL = new Set(['BOUNCED', 'COMPLAINED', 'FAILED']);

/** Provider status callbacks — delivery, opens, clicks, bounces, complaints. */
export async function applyStatusUpdate(input: {
  /**
   * The provider's own id for the message. Empty when the event did not come
   * from a provider — a link click is our own record, found by messageLogId.
   */
  providerMessageId: string;
  /** Used instead of the provider id when we already know which message. */
  messageLogId?: string;
  status: 'DELIVERED' | 'READ' | 'FAILED' | 'CLICKED' | 'DELAYED' | 'BOUNCED' | 'COMPLAINED';
  errorMessage?: string;
  at?: Date;
  /**
   * The salon the webhook was for, worked out from the phone number the event
   * arrived on. A provider message id ought to be globally unique, so this is
   * belt and braces — but it costs one indexed column and it means a forged or
   * misrouted id can never touch another salon's records.
   */
  tenantId?: string;
}) {
  // A blank provider id would otherwise match the first unsent message in the
  // table, so the two ways of identifying a message are kept strictly apart.
  if (!input.messageLogId && !input.providerMessageId) return null;

  const log = await runUnscoped(() =>
    prisma.messageLog.findFirst({
      where: {
        ...(input.messageLogId
          ? { id: input.messageLogId }
          : { providerMessageId: input.providerMessageId }),
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      },
    }),
  );
  if (!log) return null;

  const at = input.at ?? new Date();
  const data: Prisma.MessageLogUpdateInput = {};

  // The timestamps are facts about what happened and are always recorded, even
  // when the headline status does not move. An open that arrives after a click
  // still means they opened it.
  if (input.status === 'DELIVERED') data.deliveredAt = at;
  if (input.status === 'READ') data.readAt = at;
  if (input.status === 'CLICKED') data.clickedAt = at;

  if (TERMINAL.has(input.status)) {
    data.status = input.status;
    data.errorMessage =
      input.errorMessage ??
      (input.status === 'BOUNCED'
        ? 'The receiving server rejected this address'
        : input.status === 'COMPLAINED'
          ? 'The recipient marked this as spam'
          : 'Delivery failed');
  } else if (!TERMINAL.has(log.status)) {
    // Never walk backwards, and never overwrite an ending that already landed.
    const current = PROGRESS[log.status] ?? 0;
    const next = PROGRESS[input.status] ?? 0;
    if (next > current) data.status = input.status;
    if (input.status === 'DELAYED' && input.errorMessage) data.errorMessage = input.errorMessage;
  }

  const updated = await runUnscoped(() => prisma.messageLog.update({ where: { id: log.id }, data }));

  if (log.campaignId) {
    /**
     * Only the FIRST time a message reaches a state moves the campaign's
     * counter.
     *
     * Providers retry webhooks — Meta and Resend both redeliver when our 200
     * is slow — and a customer can open an email five times. Counting each one
     * gives a campaign more opens than it had recipients, which is the kind of
     * number that quietly destroys a salon's trust in the whole screen.
     *
     * The timestamps on the row before this update are the record of what has
     * already been counted.
     */
    const already =
      input.status === 'DELIVERED'
        ? log.deliveredAt
        : input.status === 'READ'
          ? log.readAt
          : input.status === 'CLICKED'
            ? log.clickedAt
            : TERMINAL.has(log.status)
              ? log.queuedAt // a terminal message has already been counted once
              : null;

    if (already) return updated;

    // A delay is not an outcome yet, so it moves no counter — the message is
    // still in flight and will land in one of the others.
    const field =
      input.status === 'DELIVERED'
        ? 'deliveredCount'
        : input.status === 'READ'
          ? 'readCount'
          : input.status === 'CLICKED'
            ? 'clickedCount'
            : input.status === 'DELAYED'
              ? null
              : 'failedCount';
    if (!field) return updated;
    await runUnscoped(() =>
      prisma.campaign.update({ where: { id: log.campaignId! }, data: { [field]: { increment: 1 } } }),
    );
  }

  return updated;
}

/**
 * A customer wrote back.
 *
 * The strongest signal any campaign produces short of a booking: somebody read
 * it, cared enough to answer, and is now sitting in the salon's inbox. It is
 * credited to the most recent message sent to that number, within the window
 * that message was given — a reply three months later is a new conversation,
 * not a response to the September offer.
 */
export async function recordReply(input: { tenantId: string; phone: string; at?: Date }) {
  const at = input.at ?? new Date();

  const log = await runUnscoped(() =>
    prisma.messageLog.findFirst({
      where: {
        tenantId: input.tenantId,
        toAddress: { contains: input.phone },
        repliedAt: null,
        sentAt: { not: null },
        attributionUntil: { gte: at },
      },
      orderBy: { sentAt: 'desc' },
    }),
  );
  if (!log) return null;

  const updated = await runUnscoped(() =>
    prisma.messageLog.update({ where: { id: log.id }, data: { repliedAt: at } }),
  );

  if (log.campaignId) {
    await runUnscoped(() =>
      prisma.campaign.update({ where: { id: log.campaignId! }, data: { repliedCount: { increment: 1 } } }),
    ).catch(() => undefined);
  }

  return updated;
}
