import type { Channel } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { NotFound } from '../../core/errors';
import { toE164 } from '../../core/ids';
import { buildVariables, renderTemplate, missingVariables, consentAllows } from '../../messaging/dispatcher';
import { resolveProvider } from '../../messaging/providers';
import { meterFor, usageSummary } from '../quotas/quota.service';

/**
 * SHARING WITH ONE CUSTOMER
 *
 * The difference between this and a campaign is that a human is standing at the
 * counter deciding to send it. So it shows them exactly what the customer will
 * receive, warns before rather than after, and offers a way to send even when
 * the salon has not connected anything yet.
 *
 * Two routes out:
 *
 *  1. **Through the app** — metered, logged, delivery tracked, works unattended.
 *     Needs the salon's WhatsApp or SMS account connected.
 *  2. **Through the staff member's own WhatsApp** — a `wa.me` link that opens
 *     WhatsApp with the message already typed. Nothing is sent by us, nothing is
 *     metered, and it works on day one with no setup at all.
 *
 * The second matters more than it looks. A salon that has just signed up has no
 * WhatsApp Business account yet, and "you can use this in three weeks once Meta
 * approves you" is how a new customer loses interest. This makes the software
 * useful the same afternoon.
 */

/**
 * What to tell someone whose message will be recorded but not delivered.
 *
 * The old sentence said "your salon has not connected email yet" and then
 * offered to send it "from your own WhatsApp" — on the email tab, where there
 * is no such button. It was written for WhatsApp and reused for everything.
 *
 * It also said nothing about WHY. Half-configured looks identical to
 * unconfigured from here, so somebody who has just pasted an API key reads
 * "not connected", assumes it did not save, and pastes it again.
 */
export function notLiveReason(channel: Channel, missing: string | null): string {
  const detail = missing ? ` What is missing: ${missing}.` : '';

  if (channel === 'WHATSAPP') {
    return (
      'Your salon’s WhatsApp is not connected yet, so this would be recorded but not delivered. ' +
      `You can still send it from your own WhatsApp below.${detail}`
    );
  }

  const what = channel === 'EMAIL' ? 'Email' : 'SMS';
  return (
    `${what} is not connected yet, so this would be recorded but not delivered — ` +
    `it will show in Messages as skipped.${detail} Set it up in Settings → Messaging.`
  );
}

export interface SharePreviewInput {
  channel: Channel;
  customerId?: string;
  leadId?: string;
  templateId?: string;
  body?: string;
  variables?: Record<string, string>;
  /** Attach context so {{invoice_number}}, {{appointment_date}} etc. resolve. */
  invoiceId?: string;
  appointmentId?: string;
}

export interface SharePreview {
  channel: Channel;
  to: string | null;
  toLabel: string | null;
  body: string;
  subject: string | null;
  templateName: string | null;
  /** Variables the template wanted but nothing could fill — shown as gaps. */
  unresolved: string[];
  consent: { allowed: boolean; status: string; reason: string | null };
  delivery: { live: boolean; source: string; reason: string | null; simulated: boolean };
  quota: { meter: string | null; available: number | null };
  /** Opens WhatsApp with the message typed in. Null when there is no number. */
  whatsappLink: string | null;
  /** Links that resolved for this customer, invoice or appointment. */
  quickLinks: { label: string; url: string }[];
}

function consentFor(
  customer: { whatsappConsent: string; smsConsent: string; emailConsent: string } | null,
  channel: Channel,
): string {
  if (!customer) return 'UNKNOWN';
  if (channel === 'WHATSAPP') return customer.whatsappConsent;
  if (channel === 'SMS') return customer.smsConsent;
  if (channel === 'EMAIL') return customer.emailConsent;
  return 'OPTED_IN';
}

export async function previewShare(tenantId: string, input: SharePreviewInput): Promise<SharePreview> {
  const [customer, lead, template] = await Promise.all([
    input.customerId ? prisma.customer.findUnique({ where: { id: input.customerId } }) : null,
    input.leadId ? prisma.lead.findUnique({ where: { id: input.leadId } }) : null,
    input.templateId ? prisma.messageTemplate.findUnique({ where: { id: input.templateId } }) : null,
  ]);

  if (input.customerId && !customer) throw NotFound('Customer');

  const variables = {
    ...(await buildVariables({
      tenantId,
      customerId: input.customerId,
      leadId: input.leadId,
      invoiceId: input.invoiceId,
      appointmentId: input.appointmentId,
    })),
    ...(input.variables ?? {}),
  };

  const rawBody = template?.bodyText ?? input.body ?? '';
  const body = renderTemplate(rawBody, variables);
  const unresolved = missingVariables(rawBody, variables);

  const phone = customer?.phone ?? lead?.phone ?? null;
  const emailAddress = customer?.email ?? lead?.email ?? null;
  const to = input.channel === 'EMAIL' ? emailAddress : phone ? toE164(phone) : null;

  // Consent, checked here so the staff member is warned before they press send
  // rather than discovering a SKIPPED row afterwards.
  const category = template?.category ?? 'UTILITY';
  const consentStatus = consentFor(customer, input.channel);
  const consentOk = consentAllows(category, consentStatus as never);

  const { live, source, missing, simulated } = await resolveProvider(input.channel, tenantId);

  const meter = meterFor(input.channel, category);
  let available: number | null = null;
  if (meter) {
    const usage = await usageSummary(tenantId);
    available = usage.meters.find((m) => m.meter === meter)?.available ?? 0;
  }

  // wa.me wants a bare international number with no plus sign.
  const waNumber = phone ? toE164(phone).replace(/[^0-9]/g, '') : null;
  const whatsappLink =
    input.channel === 'WHATSAPP' && waNumber && body
      ? `https://wa.me/${waNumber}?text=${encodeURIComponent(body)}`
      : null;

  return {
    channel: input.channel,
    to,
    toLabel: input.channel === 'EMAIL' ? emailAddress : phone,
    body,
    subject: template?.headerText ?? null,
    templateName: template?.name ?? null,
    unresolved,
    consent: {
      allowed: consentOk,
      status: consentStatus,
      reason: consentOk
        ? null
        : category === 'MARKETING'
          ? 'This customer has not opted in to marketing messages, so a promotional message cannot be sent to them.'
          : 'This customer has opted out of messages on this channel.',
    },
    delivery: {
      live,
      source,
      reason: simulated
        ? 'Simulated: this is recorded and tracked exactly like a real send, but no message leaves the building. Connect a real sender before using this with customers.'
        : live
          ? null
          : notLiveReason(input.channel, missing),
      simulated: Boolean(simulated),
    },
    quota: { meter, available },
    whatsappLink,
    /**
     * The links this particular message could carry, already resolved.
     *
     * Writing a message by hand is the common case -- "No template, write it
     * myself" is the first option in the picker -- and the one thing that is
     * hard to type by hand is the invoice address: it ends in a 24-character
     * token nobody can read off a screen. So the ones that resolved for THIS
     * customer, invoice or appointment are handed over for the sheet to offer
     * as one-press inserts. A link that did not resolve is not offered, rather
     * than offered and broken.
     */
    quickLinks: [
      { label: 'Invoice', url: variables.invoice_link },
      { label: 'Booking page', url: variables.booking_link },
      { label: 'Feedback form', url: variables.feedback_link },
      { label: 'Google review', url: variables.google_review_link },
    ].filter((link): link is { label: string; url: string } => Boolean(link.url)),
  };
}
