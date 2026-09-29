import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { aiReady } from '../../config/env';
import { chat } from '../../core/ai';
import { queueMessage } from '../../messaging/dispatcher';
import { windowIsOpen } from '../../messaging/service-window';
import { salonContext } from './salon-context';
import { MAX_REPLY_CHARS, needsHuman, parseReply, replyPrompt } from './reply-ai';
import { intentPrompt, parseIntent } from './assistant-intent';
import { type SlotOffer, bookOffer, checkAvailability, matchService } from './assistant-tools';

/**
 * REPLYING TO A CUSTOMER, WITHOUT A PERSON READING IT FIRST.
 *
 * This is the only thing in the app that speaks to a customer unsupervised, so
 * it is the only thing with this many refusals in it. Each one is here because
 * of a specific way it could go wrong, and every one of them is cheaper than
 * the thing it prevents.
 *
 * OFF BY DEFAULT, per salon. A salon should decide to let a machine answer for
 * them; it should not discover that it already does.
 */

/** Conversation turns given to the model — enough for context, not a novel. */
const HISTORY = 8;
/** A customer is waiting, so a short leash. */
const TIMEOUT_MS = 9000;
/** Warm enough not to sound like a form letter, cool enough to stay on facts. */
const TEMPERATURE = 0.4;

/**
 * THE STOP ON A LOOP.
 *
 * Every guard below refuses a bad reply. This one refuses a runaway. If
 * anything ever messages this number automatically — another bot, a forwarding
 * rule, a test harness, the salon's own second system — each side answers the
 * other forever, at a cost per message, in the salon's name. A ceiling per
 * customer per day means the worst case is bounded and visible rather than
 * unbounded and discovered on an invoice.
 */
const MAX_REPLIES_PER_CUSTOMER_PER_DAY = 10;

export interface AutoReplyDecision {
  sent: boolean;
  reason: string;
}

export async function maybeAutoReply(input: {
  tenantId: string;
  inboundMessageId: string;
}): Promise<AutoReplyDecision> {
  if (!aiReady) return { sent: false, reason: 'no AI key configured' };

  /**
   * OFF UNTIL A SALON TURNS IT ON.
   *
   * A salon should decide to let a machine answer for them. Discovering that
   * it already has been — in their name, to their customers, with their prices
   * — is not a thing that should be possible, however good the answers are.
   *
   * Stored on the tenant's settings blob rather than a column, because it is a
   * preference and not a fact about the business, and because it wants to be
   * one push away from existing on a database with no migration history.
   */
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { settings: true } }),
  );
  const settings = (tenant?.settings as Record<string, unknown> | null) ?? {};
  if (settings.whatsappAutoReply !== true) {
    return { sent: false, reason: 'auto-reply is off for this salon' };
  }

  const message = await runUnscoped(() =>
    prisma.inboundMessage.findUnique({
      where: { id: input.inboundMessageId },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            branchId: true,
            lastInboundAt: true,
            whatsappConsent: true,
            assistantOffer: true,
            assistantOfferAt: true,
          },
        },
      },
    }),
  );

  if (!message) return { sent: false, reason: 'message not found' };

  /**
   * A stranger gets nothing automatic.
   *
   * With no customer record there is no consent, no history and no branch —
   * and an unknown number messaging a salon is as likely to be a wrong number
   * or a scam as a customer. A person should look at it.
   */
  if (!message.customer) return { sent: false, reason: 'not a known customer' };

  if (message.customer.whatsappConsent === 'OPTED_OUT') {
    return { sent: false, reason: 'customer has opted out' };
  }

  /**
   * The window governs the SHAPE of a reply, and free text is the only shape
   * this can produce. Outside it, Meta refuses the send — so there is nothing
   * to do here but leave it for a person, who can pick an approved template.
   */
  if (!windowIsOpen(message.customer.lastInboundAt)) {
    return { sent: false, reason: 'outside the 24-hour service window' };
  }

  if (needsHuman(message.body)) {
    return { sent: false, reason: 'subject needs a person' };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const repliesToday = await runUnscoped(() =>
    prisma.messageLog.count({
      where: {
        tenantId: input.tenantId,
        customerId: message.customer!.id,
        channel: 'WHATSAPP',
        purpose: 'OTHER',
        queuedAt: { gte: today },
      },
    }),
  );
  if (repliesToday >= MAX_REPLIES_PER_CUSTOMER_PER_DAY) {
    logger.warn(
      { tenantId: input.tenantId, customerId: message.customer.id, repliesToday },
      'auto-reply stopped: daily ceiling for this customer reached',
    );
    return { sent: false, reason: 'daily reply ceiling reached' };
  }

  const salon = await salonContext(input.tenantId, message.customer.branchId ?? message.branchId);
  if (!salon) return { sent: false, reason: 'no salon details to answer from' };

  const branchId = message.customer.branchId ?? message.branchId;

  /**
   * STEP ONE: WHAT DID THEY MEAN?
   *
   * The model reads the sentence and reports an intent. It touches nothing.
   * Everything it says is a proposal the code below either verifies against
   * the database or refuses.
   */
  const offerHeld = readHeldOffer(message.customer.assistantOffer, message.customer.assistantOfferAt);

  const services = await runUnscoped(() =>
    prisma.service.findMany({
      where: { tenantId: input.tenantId, isActive: true, onlineBookable: true },
      select: { name: true },
      take: 80,
    }),
  );

  const intentCall = intentPrompt({
    message: message.body,
    serviceNames: services.map((s) => s.name),
    staffNames: [],
    today: new Date().toISOString().slice(0, 10),
    outstandingOffer: offerHeld ? describeOffer(offerHeld) : null,
  });

  const intentRaw = await chat(intentCall.system, intentCall.user, {
    timeoutMs: TIMEOUT_MS,
    // Reading a sentence is not a creative task, and the same message should
    // mean the same thing twice.
    temperature: 0,
    maxTokens: 300,
  });
  const intent = intentRaw ? parseIntent(intentRaw) : { intent: 'ANSWER' as const, service: null, date: null, time: null, staff: null };

  if (intent.intent === 'HUMAN') {
    return { sent: false, reason: 'intent needs a person' };
  }

  /**
   * STEP TWO: THE ONLY PLACE ANYTHING IS WRITTEN.
   *
   * A confirmation, against an offer we actually made, that has not gone
   * stale. The slot is not trusted from the offer — createAppointment checks
   * conflicts inside its transaction, which is the only check that can settle
   * two customers saying yes to 6pm at the same moment.
   */
  if (intent.intent === 'CONFIRM' && offerHeld && branchId) {
    const booked = await bookOffer({
      tenantId: input.tenantId,
      branchId,
      customerId: message.customer.id,
      offer: offerHeld,
    });

    await clearOffer(message.customer.id);

    const text = booked.ok
      ? `Done — ${offerHeld.serviceName} on ${humanWhen(offerHeld.startAt)}${offerHeld.staffName ? ` with ${offerHeld.staffName}` : ''}. See you then.`
      : `Sorry — that time has just gone. Would another time suit you? You can also see what is free here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`;

    await send(input.tenantId, branchId, message.customer.id, text);
    await markHandled(message.id);
    return { sent: true, reason: booked.ok ? 'booked' : 'slot taken' };
  }

  if (intent.intent === 'DECLINE' && offerHeld) await clearOffer(message.customer.id);

  /**
   * STEP THREE: A BOOKING REQUEST BECOMES AN OFFER, NEVER AN APPOINTMENT.
   *
   * Real times from the real diary, and the customer has to say yes. A model
   * reading "maybe Tuesday?" as agreement is the failure this shape exists to
   * make impossible.
   */
  if (intent.intent === 'BOOK' && branchId) {
    const service = await matchService(input.tenantId, intent.service);

    if (service && intent.date) {
      const slots = await checkAvailability({
        tenantId: input.tenantId,
        branchId,
        serviceId: service.id,
        serviceName: service.name,
        date: new Date(`${intent.date}T00:00:00`),
        time: intent.time,
      });

      if (slots.length > 0) {
        const offer = slots[0]!;
        await holdOffer(message.customer.id, offer);
        const alternatives = slots.slice(1, 4).map((s) => s.label);
        const text = intent.time
          ? `Yes — ${offer.serviceName} at ${offer.label} on ${humanWhen(offer.startAt)}${offer.staffName ? ` with ${offer.staffName}` : ''} is free. Shall I book it?`
          : `For ${offer.serviceName} on ${humanWhen(offer.startAt)} we have ${[offer.label, ...alternatives].join(', ')}. Shall I book ${offer.label}?`;
        await send(input.tenantId, branchId, message.customer.id, text);
        await markHandled(message.id);
        return { sent: true, reason: 'offered a slot' };
      }

      // Asked for a specific time that is taken: say so, and offer the day.
      const sameDay = intent.time
        ? await checkAvailability({
            tenantId: input.tenantId,
            branchId,
            serviceId: service.id,
            serviceName: service.name,
            date: new Date(`${intent.date}T00:00:00`),
          })
        : [];

      const text = sameDay.length
        ? `${intent.time} is taken that day, but we have ${sameDay.slice(0, 3).map((s) => s.label).join(', ')}. Shall I book one of those?`
        : `We have nothing free for ${service.name} on that day. You can see the other days here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`;

      if (sameDay.length) await holdOffer(message.customer.id, sameDay[0]!);
      await send(input.tenantId, branchId, message.customer.id, text);
      await markHandled(message.id);
      return { sent: true, reason: 'offered alternatives' };
    }
  }

  /** Their side of it. The salon's outbound copy is not needed to answer. */
  const history = await runUnscoped(() =>
    prisma.inboundMessage.findMany({
      where: { tenantId: input.tenantId, customerId: message.customer!.id },
      orderBy: { receivedAt: 'desc' },
      take: HISTORY,
      select: { body: true },
    }),
  );

  const { system, user } = replyPrompt({
    salon,
    conversation: history
      .reverse()
      .filter((row) => row.body.trim())
      .map((row) => ({ from: 'CUSTOMER' as const, body: row.body })),
    /**
     * Empty for now, and the prompt is explicit about what that means: the
     * assistant says it will check rather than inventing a time. Feeding real
     * slots needs a service and a date parsed out of the message first, and a
     * wrong guess there offers a customer a time that is not free — worse than
     * saying "let me look".
     */
    availability: [],
    customerName: message.customer.firstName ?? null,
  });

  const raw = await chat(system, user, { timeoutMs: TIMEOUT_MS, temperature: TEMPERATURE, maxTokens: 800 });
  if (!raw) return { sent: false, reason: 'model did not answer' };

  const parsed = parseReply(raw);
  if ('refused' in parsed) {
    logger.warn(
      { tenantId: input.tenantId, reason: parsed.refused },
      'auto-reply discarded: the model broke a rule it was given',
    );
    return { sent: false, reason: `reply refused: ${parsed.refused}` };
  }

  await queueMessage({
    tenantId: input.tenantId,
    branchId: message.customer.branchId ?? message.branchId ?? undefined,
    customerId: message.customer.id,
    channel: 'WHATSAPP',
    // No template: a free-form reply, which is exactly what the open window
    // permits and nothing else does.
    body: parsed.text.slice(0, MAX_REPLY_CHARS),
  });

  await runUnscoped(() =>
    prisma.inboundMessage.update({
      where: { id: message.id },
      data: { handledAt: new Date(), handledBy: 'assistant' },
    }),
  ).catch(() => undefined);

  return { sent: true, reason: 'replied' };
}


/** An offer older than this must be re-checked, not honoured. */
const OFFER_STALE_MINUTES = 60;

function readHeldOffer(raw: unknown, at: Date | null): SlotOffer | null {
  if (!raw || !at) return null;
  if (Date.now() - at.getTime() > OFFER_STALE_MINUTES * 60 * 1000) return null;
  const row = raw as Partial<SlotOffer> & { startAt?: string };
  if (!row.serviceId || !row.serviceName || !row.startAt) return null;
  return {
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    startAt: new Date(row.startAt),
    staffId: row.staffId ?? null,
    staffName: row.staffName ?? null,
    label: row.label ?? '',
  };
}

function describeOffer(offer: SlotOffer): string {
  return `${offer.serviceName} on ${humanWhen(offer.startAt)} at ${offer.label}${offer.staffName ? ` with ${offer.staffName}` : ''}`;
}

/** "Tuesday 30 September" — a salon's customers do not read ISO dates. */
function humanWhen(at: Date): string {
  return at.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Kolkata',
  });
}

async function holdOffer(customerId: string, offer: SlotOffer): Promise<void> {
  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      data: {
        assistantOffer: { ...offer, startAt: offer.startAt.toISOString() },
        assistantOfferAt: new Date(),
      },
    }),
  ).catch(() => undefined);
}

async function clearOffer(customerId: string): Promise<void> {
  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      // Prisma.DbNull, not null: a Json column distinguishes "set to JSON null"
      // from "no value", and only the second one means the offer is gone.
      data: { assistantOffer: Prisma.DbNull, assistantOfferAt: null },
    }),
  ).catch(() => undefined);
}

async function markHandled(inboundId: string): Promise<void> {
  await runUnscoped(() =>
    prisma.inboundMessage.update({
      where: { id: inboundId },
      data: { handledAt: new Date(), handledBy: 'assistant' },
    }),
  ).catch(() => undefined);
}

async function send(
  tenantId: string,
  branchId: string | null,
  customerId: string,
  text: string,
): Promise<void> {
  await queueMessage({
    tenantId,
    ...(branchId ? { branchId } : {}),
    customerId,
    channel: 'WHATSAPP',
    body: text.slice(0, MAX_REPLY_CHARS),
  });
}
