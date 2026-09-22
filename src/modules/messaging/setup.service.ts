import type { Channel, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { NotFound, BadRequest } from '../../core/errors';
import { resolveProvider } from '../../messaging/providers';
import { sendabilityProblem } from '../../messaging/whatsapp-templates';

/**
 * MESSAGING SETUP AND AUTOMATION TIMING
 *
 * Two things a salon owner needs to control themselves: which accounts their
 * messages go out from, and when the automatic ones fire. Both used to be
 * developer-only.
 */

// ------------------------------------------------------------ credentials --

/** Never return a secret. The last four characters are enough to recognise it. */
function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/**
 * CAN THIS CHANNEL ACTUALLY SEND, RIGHT NOW?
 *
 * Not the same question as "has the salon filled the form in", and the
 * difference is what made the Send test button unusable on a server whose
 * credentials live in the environment: the button was disabled unless the
 * TENANT row said CONNECTED, while the send it triggers goes through
 * resolveProvider, which also accepts the platform's own account. A deployment
 * that could send perfectly well showed a greyed-out button and no explanation.
 *
 * So ask the thing that does the sending, and report what it says.
 */
async function deliveryFor(channel: Channel, tenantId: string) {
  const { live, source, missing, simulated } = await resolveProvider(channel, tenantId);
  return { live, source, missing, simulated: Boolean(simulated) };
}

export async function getMessagingSetup(tenantId: string) {
  const [config, waDelivery, smsDelivery, emailDelivery] = await Promise.all([
    runUnscoped(() => prisma.tenantMessagingConfig.findUnique({ where: { tenantId } })),
    deliveryFor('WHATSAPP', tenantId),
    deliveryFor('SMS', tenantId),
    deliveryFor('EMAIL', tenantId),
  ]);

  return {
    whatsapp: {
      delivery: waDelivery,
      status: config?.waStatus ?? 'NOT_CONNECTED',
      phoneNumberId: config?.waPhoneNumberId ?? null,
      businessId: config?.waBusinessId ?? null,
      displayNumber: config?.waDisplayNumber ?? null,
      accessToken: mask(config?.waAccessToken),
      verifiedAt: config?.waVerifiedAt ?? null,
    },
    sms: {
      delivery: smsDelivery,
      status: config?.smsStatus ?? 'NOT_CONNECTED',
      senderId: config?.smsSenderId ?? null,
      dltEntityId: config?.smsDltEntityId ?? null,
      route: config?.smsRoute ?? null,
      apiKey: mask(config?.smsApiKey),
    },
    email: {
      delivery: emailDelivery,
      status: config?.emailStatus ?? 'NOT_CONNECTED',
      fromName: config?.emailFromName ?? null,
      fromAddress: config?.emailFromAddress ?? null,
      replyTo: config?.emailReplyTo ?? null,
      apiKey: mask(config?.emailApiKey),
    },
  };
}

export interface MessagingSetupInput {
  whatsapp?: { phoneNumberId?: string; businessId?: string; accessToken?: string; displayNumber?: string };
  sms?: { senderId?: string; apiKey?: string; dltEntityId?: string; route?: string };
  email?: { fromName?: string; fromAddress?: string; apiKey?: string; replyTo?: string };
}

/**
 * A channel flips to CONNECTED only when it has everything it needs to send.
 * Half-configured is the same as not configured — the dispatcher falls back to
 * logging rather than throwing inside a customer's journey.
 */
export async function updateMessagingSetup(tenantId: string, input: MessagingSetupInput) {
  const existing = await runUnscoped(() => prisma.tenantMessagingConfig.findUnique({ where: { tenantId } }));

  const data: Prisma.TenantMessagingConfigUncheckedCreateInput = {
    tenantId,
    ...(existing ? {} : {}),
  };

  if (input.whatsapp) {
    const phoneNumberId = input.whatsapp.phoneNumberId ?? existing?.waPhoneNumberId ?? null;
    // An empty string means "leave it alone" — the UI sends back the mask, not
    // the secret, so a blank field must never wipe a working token.
    const accessToken = input.whatsapp.accessToken?.trim()
      ? input.whatsapp.accessToken.trim()
      : (existing?.waAccessToken ?? null);

    data.waPhoneNumberId = phoneNumberId;
    data.waBusinessId = input.whatsapp.businessId ?? existing?.waBusinessId ?? null;
    data.waAccessToken = accessToken;
    data.waDisplayNumber = input.whatsapp.displayNumber ?? existing?.waDisplayNumber ?? null;
    data.waStatus = phoneNumberId && accessToken ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  if (input.sms) {
    const senderId = input.sms.senderId ?? existing?.smsSenderId ?? null;
    const apiKey = input.sms.apiKey?.trim() ? input.sms.apiKey.trim() : (existing?.smsApiKey ?? null);

    data.smsSenderId = senderId;
    data.smsApiKey = apiKey;
    data.smsDltEntityId = input.sms.dltEntityId ?? existing?.smsDltEntityId ?? null;
    data.smsRoute = input.sms.route ?? existing?.smsRoute ?? null;
    data.smsStatus = senderId && apiKey ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  if (input.email) {
    const fromAddress = input.email.fromAddress ?? existing?.emailFromAddress ?? null;
    const apiKey = input.email.apiKey?.trim() ? input.email.apiKey.trim() : (existing?.emailApiKey ?? null);

    data.emailFromAddress = fromAddress;
    data.emailFromName = input.email.fromName ?? existing?.emailFromName ?? null;
    data.emailApiKey = apiKey;
    data.emailReplyTo = input.email.replyTo ?? existing?.emailReplyTo ?? null;
    data.emailStatus = fromAddress && apiKey ? 'CONNECTED' : 'NOT_CONNECTED';
  }

  const saved = await runUnscoped(() =>
    existing
      ? prisma.tenantMessagingConfig.update({ where: { tenantId }, data })
      : prisma.tenantMessagingConfig.create({ data }),
  );

  return { id: saved.id, ...(await getMessagingSetup(tenantId)) };
}

/** Prove a channel works before trusting it with customers. */
export async function sendTestMessage(tenantId: string, channel: Channel, to: string) {
  const { provider, live, source, missing, simulated } = await resolveProvider(channel, tenantId);

  if (!live) {
    // Say what is missing. "Not connected" sends somebody back to a form they
    // have already filled in, to fill it in again the same way.
    throw BadRequest(
      `${channel.toLowerCase()} is not connected yet, so nothing was sent.` +
        (missing ? ` What is missing: ${missing}.` : ' Add the details above and save first.'),
    );
  }

  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  );

  const body = `This is a test message from ${tenant?.name ?? 'your salon'}. If you can read this, your ${channel.toLowerCase()} setup is working.`;

  // WhatsApp will not accept free-form text from a business unless the customer
  // messaged first and the 24-hour service window is still open. On a freshly
  // connected number nobody has messaged anybody, so a plain text test fails
  // with error 131047 — which reads like a broken connection when the
  // connection is in fact fine.
  //
  // `hello_world` is the pre-approved template every WhatsApp Business Account
  // is created with. Sending that proves the token, the phone number ID and the
  // recipient are all good, which is the only thing this button is for. The
  // wording is Meta's, not ours; that is the trade for a test that works on a
  // connection nobody has used yet.
  const result = await provider.send(
    channel === 'WHATSAPP'
      ? { to, channel, body, templateName: 'hello_world', language: 'en_US' }
      : { to, channel, body, subject: 'Test message' },
  );

  return {
    ...result,
    source,
    simulated: Boolean(simulated),
    note: simulated
      ? // The one thing this button must never do is say "sent" when nothing
        // left the building. A simulated success is indistinguishable from a
        // real one on the screen, and somebody who trusts it switches an
        // automation on for real customers.
        'NOTHING WAS SENT. This channel is running the simulator, which records and tracks a message exactly like a real send but delivers nothing. Connect a real account before trusting this.'
      : channel === 'WHATSAPP'
        ? 'Sent as the standard hello_world template. WhatsApp only allows your own wording once the customer has replied — and if the Meta app is still in development mode, only to a number added as a test recipient.'
        : undefined,
  };
}

// ------------------------------------------------------------ automations --

export const TRIGGER_LABELS: Record<string, { label: string; timingLabel: string | null; help: string }> = {
  APPOINTMENT_BOOKED: {
    label: 'When an appointment is booked',
    timingLabel: null,
    help: 'Confirmation goes out immediately.',
  },
  APPOINTMENT_REMINDER: {
    label: 'Before an appointment',
    timingLabel: 'Hours before',
    help: 'The message that cuts no-shows most. 24 hours ahead works best.',
  },
  APPOINTMENT_COMPLETED: {
    label: 'After a visit',
    timingLabel: 'Hours after',
    help: 'Thank-you and review request. Two hours later is the sweet spot.',
  },
  APPOINTMENT_CANCELLED: { label: 'When an appointment is cancelled', timingLabel: null, help: '' },
  FIRST_VISIT: { label: 'After a first visit', timingLabel: 'Days after', help: 'Welcome a new customer properly.' },
  INVOICE_PAID: { label: 'When a bill is paid', timingLabel: null, help: 'Receipt and loyalty points.' },
  NO_VISIT_DAYS: {
    label: 'When a customer stops coming',
    timingLabel: 'Days since last visit',
    help: '90 days is the usual point. Shorter for a barber, longer for colour.',
  },
  MEMBERSHIP_EXPIRING: {
    label: 'Before a membership expires',
    timingLabel: 'Days before',
    help: '15 days gives them time to renew without feeling chased.',
  },
  PACKAGE_EXPIRING: { label: 'Before a package expires', timingLabel: 'Days before', help: '' },
  BIRTHDAY: {
    label: 'On a birthday',
    timingLabel: 'Days before',
    help: 'Zero sends on the day itself. Set 3–7 days if you attach a gift they need time to use.',
  },
  ANNIVERSARY: { label: 'On a visit anniversary', timingLabel: 'Days before', help: '' },
  LEAD_CREATED: {
    label: 'When someone enquires',
    timingLabel: 'Minutes after',
    help: 'Reply within five minutes and you convert several times better.',
  },
  REVIEW_REQUEST: { label: 'Asking for a review', timingLabel: 'Hours after', help: '' },
  MANUAL: { label: 'Run by hand', timingLabel: null, help: 'Only runs when you start it.' },
};

/**
 * The triggers a salon can build an automation on, in their own words.
 *
 * Served rather than duplicated in the client, for the same reason the segment
 * fields are: the builder can then never offer a trigger the job runner does
 * not know how to fire.
 */
export function listTriggers() {
  return Object.entries(TRIGGER_LABELS).map(([key, meta]) => ({
    key,
    label: meta.label,
    timingLabel: meta.timingLabel,
    help: meta.help,
    /** Whether this trigger needs a "how many days" number alongside it. */
    needsDays: meta.timingLabel !== null,
  }));
}

export async function listAutomations(tenantId: string) {
  const journeys = await runUnscoped(() =>
    prisma.journey.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      include: {
        steps: {
          orderBy: { sortOrder: 'asc' },
          include: { template: { select: { id: true, name: true, channel: true, category: true } } },
        },
        _count: { select: { runs: true } },
      },
    }),
  );

  return journeys.map((journey) => {
    const meta = TRIGGER_LABELS[journey.trigger] ?? { label: journey.trigger, timingLabel: null, help: '' };
    const config = (journey.triggerConfig as Record<string, unknown>) ?? {};

    return {
      id: journey.id,
      name: journey.name,
      description: journey.description,
      trigger: journey.trigger,
      triggerLabel: meta.label,
      timingLabel: meta.timingLabel,
      help: meta.help,
      isActive: journey.isActive,
      days: typeof config.days === 'number' ? config.days : null,
      sendAfterHour: typeof config.sendAfterHour === 'number' ? config.sendAfterHour : null,
      sendBeforeHour: typeof config.sendBeforeHour === 'number' ? config.sendBeforeHour : null,
      runs: journey._count.runs,
      steps: journey.steps.map((step) => ({
        id: step.id,
        sortOrder: step.sortOrder,
        actionType: step.actionType,
        delayMinutes: step.delayMinutes,
        channel: step.channel,
        template: step.template,
      })),
    };
  });
}

export interface AutomationTiming {
  isActive?: boolean;
  days?: number;
  stepDelays?: Record<string, number>;
  sendAfterHour?: number;
  sendBeforeHour?: number;
  /**
   * Which channel each step sends on, keyed by step id.
   *
   * The salon's choice, not ours. WhatsApp is the default because it is what
   * gets read in India, but a salon whose book is corporate clients may want
   * invoices by email, and one without a WhatsApp number yet needs SMS or
   * nothing at all.
   */
  stepChannels?: Record<string, 'WHATSAPP' | 'SMS' | 'EMAIL'>;
  /** Which template each step sends, keyed by step id. */
  stepTemplates?: Record<string, string | null>;
}

export async function updateAutomation(journeyId: string, input: AutomationTiming) {
  const journey = await prisma.journey.findUnique({ where: { id: journeyId } });
  if (!journey) throw NotFound('Automation');

  const config = { ...((journey.triggerConfig as Record<string, unknown>) ?? {}) };
  if (input.days !== undefined) config.days = input.days;
  if (input.sendAfterHour !== undefined) config.sendAfterHour = input.sendAfterHour;
  if (input.sendBeforeHour !== undefined) config.sendBeforeHour = input.sendBeforeHour;

  if (
    typeof config.sendAfterHour === 'number' &&
    typeof config.sendBeforeHour === 'number' &&
    config.sendAfterHour >= config.sendBeforeHour
  ) {
    throw BadRequest('The "send after" hour must be earlier than the "send before" hour');
  }

  /**
   * A step's channel and its template have to agree.
   *
   * Templates are per channel — a WhatsApp template is registered with Meta
   * and an email one has a subject line. Pointing a step at an email template
   * while it sends on WhatsApp produces a message the provider rejects, hours
   * later, in a log nobody is watching. Cheaper to refuse it here.
   */
  const channelChanges = Object.entries(input.stepChannels ?? {});
  const templateChanges = Object.entries(input.stepTemplates ?? {});

  if (channelChanges.length > 0 || templateChanges.length > 0) {
    const steps = await prisma.journeyStep.findMany({
      where: { journeyId },
      select: { id: true, channel: true, templateId: true },
    });

    for (const step of steps) {
      const channel = (input.stepChannels?.[step.id] ?? step.channel) as Channel | null;
      const templateId =
        step.id in (input.stepTemplates ?? {}) ? input.stepTemplates![step.id] : step.templateId;
      if (!templateId || !channel) continue;

      const template = await prisma.messageTemplate.findUnique({
        where: { id: templateId },
        select: {
          channel: true,
          name: true,
          approvalStatus: true,
          providerTemplateName: true,
          rejectedReason: true,
        },
      });
      if (!template) throw NotFound('Message template');
      if (template.channel !== channel) {
        throw BadRequest(
          `"${template.name}" is a ${template.channel.toLowerCase()} template, so it cannot be sent on ` +
            `${channel.toLowerCase()}. Pick a ${channel.toLowerCase()} template, or change the step's channel.`,
        );
      }

      /**
       * And Meta has to have approved it.
       *
       * Automations are where the Utility templates live — every confirmation
       * and reminder the product exists to send — and nothing checked this at
       * all. An automation switched on against an unapproved template runs
       * happily for weeks, failing one message at a time in a job log, while
       * the salon believes their reminders are going out.
       */
      const problem = sendabilityProblem(template);
      if (problem) throw BadRequest(problem);
    }
  }

  return prisma.$transaction(async (tx) => {
    for (const [stepId, delayMinutes] of Object.entries(input.stepDelays ?? {})) {
      await tx.journeyStep.updateMany({
        where: { id: stepId, journeyId },
        data: { delayMinutes },
      });
    }

    for (const [stepId, channel] of channelChanges) {
      await tx.journeyStep.updateMany({ where: { id: stepId, journeyId }, data: { channel } });
    }

    for (const [stepId, templateId] of templateChanges) {
      await tx.journeyStep.updateMany({ where: { id: stepId, journeyId }, data: { templateId } });
    }

    return tx.journey.update({
      where: { id: journeyId },
      data: {
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        triggerConfig: config as Prisma.InputJsonValue,
      },
      include: { steps: { orderBy: { sortOrder: 'asc' } } },
    });
  });
}
