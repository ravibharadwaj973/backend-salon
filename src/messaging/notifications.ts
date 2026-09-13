import type { Channel, Customer, TemplateCategory } from '@prisma/client';
import { prisma } from '../core/prisma';
import { runUnscoped } from '../core/context';
import { logger } from '../core/logger';
import { buildVariables, consentAllows, queueMessage } from './dispatcher';
import { resolveProvider } from './providers';

/**
 * WHAT THE REST OF THE APP TALKS TO.
 *
 * The layering, outermost first:
 *
 *   appointment / billing / membership / campaign service
 *        ↓  notify('appointmentReminder', { appointmentId })
 *   notifications.ts   ← named operations; picks channel, template, variables
 *        ↓  queueMessage(...)
 *   dispatcher.ts      ← consent gate, metering, logging, retries
 *        ↓  resolveProvider(channel, tenantId)
 *   providers/         ← Resend, WhatsApp Cloud, MSG91
 *        ↓
 *   the customer
 *
 * A calling module names the EVENT — "this appointment was confirmed" — and
 * knows nothing about templates, channels, consent or providers. That is the
 * point: swapping Resend for SES, or sending a reminder on SMS instead of
 * WhatsApp, changes this file and nothing above it.
 *
 * Deliberately NOT an EmailService. This product sends on three channels and
 * the same event goes out on whichever one reaches the customer, so an
 * email-only service would force every caller to ask "email or WhatsApp?" —
 * exactly the decision they should not be making. Channel is picked here.
 */

export interface NotificationDefinition {
  /** Template name seeded per tenant; see modules/messaging/defaults.ts. */
  template: string;
  category: TemplateCategory;
  /** Tried in order; the first the customer consented to and that is connected wins. */
  channels: readonly Channel[];
}

const TRANSACTIONAL: readonly Channel[] = ['WHATSAPP', 'SMS', 'EMAIL'];
/** Bills and statements read better as email when the customer has one. */
const DOCUMENT: readonly Channel[] = ['WHATSAPP', 'EMAIL', 'SMS'];
const PROMOTIONAL: readonly Channel[] = ['WHATSAPP', 'EMAIL'];

/**
 * Every message the app sends of its own accord. Adding one here is what makes
 * it callable; a typo in a template name is a compile error at the call site
 * rather than a message that silently never goes out.
 */
export const NOTIFICATIONS = {
  appointmentConfirmation: { template: 'appointment_confirmation', category: 'UTILITY', channels: TRANSACTIONAL },
  appointmentReminder24h: { template: 'appointment_reminder_24h', category: 'UTILITY', channels: TRANSACTIONAL },
  appointmentReminder2h: { template: 'appointment_reminder_2h', category: 'UTILITY', channels: TRANSACTIONAL },
  appointmentCancelled: { template: 'appointment_cancelled', category: 'UTILITY', channels: TRANSACTIONAL },
  invoiceSent: { template: 'invoice_sent', category: 'UTILITY', channels: DOCUMENT },
  paymentReminder: { template: 'payment_reminder', category: 'UTILITY', channels: DOCUMENT },
  thankYou: { template: 'thank_you', category: 'UTILITY', channels: TRANSACTIONAL },
  /** "How was it?" — the private ask that decides which branch follows. */
  feedbackRequest: { template: 'review_request', category: 'UTILITY', channels: TRANSACTIONAL },
  /** Only ever after 4-5 stars. */
  googleReviewRequest: { template: 'google_review_request', category: 'UTILITY', channels: TRANSACTIONAL },
  /** Only ever after 1-3 stars. No link, no offer. */
  feedbackApology: { template: 'feedback_apology', category: 'UTILITY', channels: TRANSACTIONAL },
  reviewRequest: { template: 'review_request', category: 'MARKETING', channels: PROMOTIONAL },
  rebookingReminder: { template: 'rebooking_reminder', category: 'MARKETING', channels: PROMOTIONAL },
  winBack: { template: 'winback_offer', category: 'MARKETING', channels: PROMOTIONAL },
  birthday: { template: 'birthday_wish', category: 'MARKETING', channels: PROMOTIONAL },
  membershipExpiring: { template: 'membership_expiring', category: 'UTILITY', channels: DOCUMENT },
  packageExpiring: { template: 'package_expiring', category: 'UTILITY', channels: DOCUMENT },
  leadWelcome: { template: 'lead_welcome', category: 'UTILITY', channels: TRANSACTIONAL },
  loyaltyPointsEarned: { template: 'loyalty_points_earned', category: 'UTILITY', channels: TRANSACTIONAL },
} as const satisfies Record<string, NotificationDefinition>;

export type NotificationKey = keyof typeof NOTIFICATIONS;

export interface NotifyInput {
  tenantId: string;
  branchId?: string | null;
  customerId?: string | null;
  leadId?: string | null;
  /** Entities the message talks about; their values are resolved for you. */
  appointmentId?: string | null;
  invoiceId?: string | null;
  membershipId?: string | null;
  packagePurchaseId?: string | null;
  /** Merged over the resolved values — use for anything the resolver cannot know. */
  variables?: Record<string, string>;
  /** Force a channel instead of letting this file choose. */
  channel?: Channel;
  journeyRunId?: string | null;
  campaignId?: string | null;
  sendNow?: boolean;
}

const consentForChannel = (customer: Customer, channel: Channel) =>
  channel === 'WHATSAPP' ? customer.whatsappConsent : channel === 'SMS' ? customer.smsConsent : customer.emailConsent;

const addressForChannel = (customer: Customer, channel: Channel) =>
  channel === 'EMAIL' ? customer.email : customer.phone;

/**
 * The first channel that can actually carry this message: the customer agreed
 * to it, we have an address, and the salon has that channel connected.
 *
 * Falls back to the first channel the customer merely consented to when none
 * is connected — the dispatcher then logs it through the console provider
 * rather than throwing, so a half-set-up salon records what it would have sent
 * instead of losing it.
 */
export async function pickChannel(
  tenantId: string,
  customer: Customer,
  definition: NotificationDefinition,
): Promise<Channel | null> {
  const eligible = definition.channels.filter(
    (channel) =>
      Boolean(addressForChannel(customer, channel)) &&
      consentAllows(definition.category, consentForChannel(customer, channel)),
  );
  if (eligible.length === 0) return null;

  for (const channel of eligible) {
    const { live } = await resolveProvider(channel, tenantId);
    if (live) return channel;
  }
  return eligible[0]!;
}

/**
 * Send one named notification. Resolves the customer, picks the channel,
 * builds the template variables, and hands the rest to the dispatcher — which
 * still owns consent, metering and the send itself.
 */
export async function notify(key: NotificationKey, input: NotifyInput) {
  const definition = NOTIFICATIONS[key];

  const customer = input.customerId
    ? await runUnscoped(() => prisma.customer.findUnique({ where: { id: input.customerId! } }))
    : null;

  if (input.customerId && !customer) {
    logger.warn({ key, customerId: input.customerId }, 'notification skipped: customer not found');
    return null;
  }

  let channel = input.channel ?? null;
  if (!channel && customer) channel = await pickChannel(input.tenantId, customer, definition);
  if (!channel && input.leadId) channel = definition.channels[0]!;

  if (!channel) {
    logger.info({ key, customerId: input.customerId }, 'notification skipped: no consented channel with an address');
    return null;
  }

  const variables = await buildVariables({
    tenantId: input.tenantId,
    customerId: input.customerId,
    leadId: input.leadId,
    appointmentId: input.appointmentId,
    invoiceId: input.invoiceId,
    membershipId: input.membershipId,
    packagePurchaseId: input.packagePurchaseId,
    extra: input.variables,
  });

  return queueMessage({
    tenantId: input.tenantId,
    branchId: input.branchId ?? null,
    channel,
    customerId: input.customerId ?? null,
    leadId: input.leadId ?? null,
    templateName: definition.template,
    campaignId: input.campaignId ?? null,
    journeyRunId: input.journeyRunId ?? null,
    variables,
    sendNow: input.sendNow,
  });
}

// -------------------------------------------------------- named operations --
// Thin wrappers so a caller passes the id it already has, not a bag of ids.

/** An appointment was booked or confirmed. */
export async function sendAppointmentConfirmation(appointmentId: string) {
  return fromAppointment('appointmentConfirmation', appointmentId);
}

/** The day-before or two-hour nudge. */
export async function sendAppointmentReminder(appointmentId: string, kind: '24h' | '2h' = '24h') {
  return fromAppointment(kind === '2h' ? 'appointmentReminder2h' : 'appointmentReminder24h', appointmentId);
}

export async function sendAppointmentCancellation(appointmentId: string) {
  return fromAppointment('appointmentCancelled', appointmentId);
}

/** The bill, once it has been raised. */
export async function sendInvoice(invoiceId: string) {
  return fromInvoice('invoiceSent', invoiceId);
}

/** A nudge for an unpaid balance. */
export async function sendPaymentReminder(invoiceId: string) {
  return fromInvoice('paymentReminder', invoiceId);
}

export async function sendMembershipExpiring(subscriptionId: string) {
  const subscription = await runUnscoped(() =>
    prisma.membershipSubscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, tenantId: true, branchId: true, customerId: true },
    }),
  );
  if (!subscription) return null;
  return notify('membershipExpiring', {
    tenantId: subscription.tenantId,
    branchId: subscription.branchId,
    customerId: subscription.customerId,
    membershipId: subscription.id,
  });
}

async function fromAppointment(key: NotificationKey, appointmentId: string) {
  const appointment = await runUnscoped(() =>
    prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, tenantId: true, branchId: true, customerId: true },
    }),
  );
  if (!appointment?.customerId) return null;
  return notify(key, {
    tenantId: appointment.tenantId,
    branchId: appointment.branchId,
    customerId: appointment.customerId,
    appointmentId: appointment.id,
  });
}

async function fromInvoice(key: NotificationKey, invoiceId: string) {
  const invoice = await runUnscoped(() =>
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, tenantId: true, branchId: true, customerId: true },
    }),
  );
  if (!invoice?.customerId) return null;
  return notify(key, {
    tenantId: invoice.tenantId,
    branchId: invoice.branchId,
    customerId: invoice.customerId,
    invoiceId: invoice.id,
  });
}
