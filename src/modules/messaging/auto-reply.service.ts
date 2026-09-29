import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { aiReady } from '../../config/env';
import { chat } from '../../core/ai';
import { dateKey } from '../../core/dates';
import { queueMessage } from '../../messaging/dispatcher';
import { windowIsOpen } from '../../messaging/service-window';
import { salonContext } from './salon-context';
import {
  type HandoffReason,
  MAX_REPLY_CHARS,
  handoffReply,
  needsHuman,
  parseReply,
  replyPrompt,
} from './reply-ai';
import { BURST_WINDOW_MINUTES, replyCeiling } from './reply-limits';
import { type ParsedIntent, carryOverContext, intentPrompt, parseIntent } from './assistant-intent';
import { type SlotOffer, bookOffer, checkAvailability, matchService } from './assistant-tools';
import {
  BRANCH_PENDING,
  type PendingBranchChoice,
  matchBranch,
  pendingBranchPayload,
  readPendingBranch,
  resolveBranch,
} from './assistant-branch';

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

/* The ceilings, and why they are shaped the way they are, live in reply-limits. */

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

  const branchId = message.customer.branchId ?? message.branchId;

  /**
   * Read before the refusals below, not after, because they need it.
   *
   * A refusal now sends a short handoff naming the salon's number, and a handoff
   * that cannot name the number is not one. This was the last thing in the
   * function that still ended in silence.
   */
  const salon = await salonContext(input.tenantId, branchId);
  if (!salon) return { sent: false, reason: 'no salon details to answer from' };

  /**
   * One fixed sentence, or null when the salon has given us nothing to point at.
   *
   * DELIBERATELY DOES NOT MARK THE MESSAGE HANDLED.
   *
   * A reply that answers the question is handled; a handoff is the opposite of
   * handled — it is the assistant saying it cannot deal with this and a person
   * must. Stamping handledAt here would tell the customer "someone will look at
   * this personally" and, in the same breath, take the message out of the queue
   * where somebody would have found it.
   *
   * Which is worst exactly where it matters most: a burn, a refund, a complaint.
   * Those take this path by design, and marking them done would have buried the
   * few messages in the whole system that a human genuinely must read.
   */
  const handOver = async (reason: HandoffReason, decision: string): Promise<AutoReplyDecision> => {
    const text = handoffReply(salon, reason);
    if (!text) return { sent: false, reason: `${decision} (nothing to hand over to)` };
    await send(input.tenantId, branchId, message.customer!.id, text);
    return { sent: true, reason: decision };
  };

  /**
   * A complaint, a burn, a refund. The model is not asked — that was always
   * right — but the customer is no longer ignored. Being told a person will look
   * at it is the whole point of handing over; saying nothing is indistinguishable
   * from the message never arriving.
   */
  if (needsHuman(message.body)) {
    return handOver('PERSON', 'handed to a person: subject needs one');
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const burstSince = new Date(Date.now() - BURST_WINDOW_MINUTES * 60 * 1000);

  const countReplies = (since: Date) =>
    runUnscoped(() =>
      prisma.messageLog.count({
        where: {
          tenantId: input.tenantId,
          customerId: message.customer!.id,
          channel: 'WHATSAPP',
          // Our own automatic replies, which is what a runaway consists of.
          // A campaign or a booking confirmation is not part of this count.
          purpose: 'OTHER',
          queuedAt: { gte: since },
        },
      }),
    );

  const [repliesInBurst, repliesToday] = await Promise.all([
    countReplies(burstSince),
    countReplies(startOfToday),
  ]);

  const limit = replyCeiling({ inBurst: repliesInBurst, today: repliesToday });

  if (limit) {
    logger.warn(
      {
        tenantId: input.tenantId,
        customerId: message.customer.id,
        limit: limit.which,
        action: limit.action,
        repliesInBurst,
        repliesToday,
      },
      `auto-reply stopped: ${limit.which} ceiling for this customer reached`,
    );

    if (limit.action === 'HAND_OVER') {
      return handOver('ENOUGH_FOR_TODAY', `${limit.which} ceiling reached — handed to a person`);
    }
    return { sent: false, reason: `${limit.which} reply ceiling reached, already handed over` };
  }

  /**
   * STEP ONE: WHAT DID THEY MEAN?
   *
   * The model reads the sentence and reports an intent. It touches nothing.
   * Everything it says is a proposal the code below either verifies against
   * the database or refuses.
   */
  const offerHeld = readHeldOffer(message.customer.assistantOffer, message.customer.assistantOfferAt);
  const branchPending = readPendingBranch(
    message.customer.assistantOffer,
    message.customer.assistantOfferAt,
    OFFER_STALE_MINUTES,
  );

  /**
   * "BANDRA." — THE SHORTEST USEFUL MESSAGE THERE IS.
   *
   * If we asked which location and this message names one of them, the customer
   * has finished a booking request they started in the previous message. The
   * request itself was parked when we asked, so it is picked up here rather than
   * re-derived: this message contains one word and no model could recover a
   * service or a date from it.
   *
   * Which is also why this runs BEFORE the model is called at all. Sending "2"
   * to be classified wastes a call and, worse, invites an answer: a model asked
   * what "2" means will happily decide it is two o'clock.
   */
  const resumed = branchPending ? resumeBranchChoice(branchPending, message.body) : null;
  if (resumed) await clearOffer(message.customer.id);

  /**
   * Their side of the conversation, newest first.
   *
   * Read once and used twice — the intent step needs the messages before this
   * one to make sense of a half-finished request, and the answer path needs the
   * whole thread including this message.
   */
  const thread = await runUnscoped(() =>
    prisma.inboundMessage.findMany({
      where: { tenantId: input.tenantId, customerId: message.customer!.id },
      orderBy: { receivedAt: 'desc' },
      take: HISTORY,
      select: { id: true, body: true, receivedAt: true },
    }),
  );

  /**
   * The salon's own day, which is the one "tomorrow" is relative to.
   *
   * Was `toISOString().slice(0, 10)`, which is the day in UTC. Between midnight
   * and 05:30 in India that is yesterday — so a customer messaging at 1am asking
   * for "tomorrow" was offered today, and one asking for "today" was offered a
   * day that had already finished.
   */
  const salonToday = dateKey(new Date());

  let intent: ParsedIntent;

  if (resumed) {
    intent = resumed.intent;
  } else {
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
      today: salonToday,
      outstandingOffer: offerHeld ? describeOffer(offerHeld) : null,
      recent: carryOverContext(thread, message),
    });

    const intentRaw = await chat(intentCall.system, intentCall.user, {
      timeoutMs: TIMEOUT_MS,
      // Reading a sentence is not a creative task, and the same message should
      // mean the same thing twice.
      temperature: 0,
      maxTokens: 300,
    });
    intent = intentRaw
      ? parseIntent(intentRaw, { today: salonToday })
      : { intent: 'ANSWER', service: null, date: null, time: null, staff: null };
  }

  if (intent.intent === 'HUMAN') {
    return handOver('PERSON', 'handed to a person: the model read it as one for a person');
  }

  /**
   * STEP TWO: THE ONLY PLACE ANYTHING IS WRITTEN.
   *
   * A confirmation, against an offer we actually made, that has not gone
   * stale. The slot is not trusted from the offer — createAppointment checks
   * conflicts inside its transaction, which is the only check that can settle
   * two customers saying yes to 6pm at the same moment.
   */
  /**
   * The branch the offer was MADE against, not the one we would pick now.
   *
   * A customer with no branch on file was asked which location, answered, and
   * was offered a time at the shop they chose. Re-deriving the branch here
   * would lose that answer and book them somewhere else — so it travels with
   * the offer. `branchId` remains the fallback for offers held before this
   * existed, which carry no branch of their own.
   */
  const confirmBranchId = offerHeld?.branchId ?? branchId;

  if (intent.intent === 'CONFIRM' && offerHeld && confirmBranchId) {
    const booked = await bookOffer({
      tenantId: input.tenantId,
      branchId: confirmBranchId,
      customerId: message.customer.id,
      offer: offerHeld,
    });

    await clearOffer(message.customer.id);

    const text = booked.ok
      ? `Done — ${offerHeld.serviceName} on ${humanWhen(offerHeld.startAt)}${offerHeld.staffName ? ` with ${offerHeld.staffName}` : ''}. See you then.`
      : `Sorry — that time has just gone. Would another time suit you? You can also see what is free here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`;

    await send(input.tenantId, confirmBranchId, message.customer.id, text);
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
  if (intent.intent === 'BOOK') {
    const service = await matchService(input.tenantId, intent.service);

    if (service && intent.date) {
      /**
       * WHICH SHOP — ASKED HERE, AND ONLY HERE.
       *
       * Deliberately after the service and the date are known. Asking "which
       * location?" of somebody who has not yet said what they want or when is an
       * interrogation, and it parks a request too vague to resume; by this point
       * there is a real booking waiting on one word.
       *
       * The customer's own message is handed to the resolver so a branch named
       * in the same breath — "can I come to Bandra tomorrow at 6" — is used
       * without a second round trip.
       */
      const where = resumed
        ? ({ kind: 'RESOLVED', branchId: resumed.branchId, branchName: resumed.branchName } as const)
        : await resolveBranch({
            tenantId: input.tenantId,
            customerBranchId: message.customer.branchId,
            messageBranchId: message.branchId,
            said: message.body,
          });

      if (where.kind === 'ASK') {
        /**
         * The request is parked, not abandoned. Held in the same column an
         * outstanding slot offer uses — they are the same kind of thing, a
         * conversation waiting on a reply, and only one can be outstanding at a
         * time by definition.
         */
        await holdPendingBranch(
          message.customer.id,
          pendingBranchPayload({
            branches: where.branches,
            service: intent.service,
            date: intent.date,
            time: intent.time,
            staff: intent.staff,
          }),
        );
        await send(input.tenantId, null, message.customer.id, where.question);
        await markHandled(message.id);
        return { sent: true, reason: 'asked which location' };
      }

      if (where.kind === 'NONE') {
        // No active branch anywhere: there is nothing to book into and nothing
        // to ask about. Falls through to the plain answer, which at least does
        // not promise a time.
        logger.warn(
          { tenantId: input.tenantId },
          'a customer asked to book but this salon has no active branch',
        );
      } else {
        const bookAt = where.branchId;

        /**
         * Named back to them only when they have just chosen it, which is the
         * moment it is worth confirming — a customer who answered "2" wants to
         * see that we heard the right shop before they agree to a time.
         */
        const atBranch = resumed ? ` at ${where.branchName}` : '';

        const slots = await checkAvailability({
          tenantId: input.tenantId,
          branchId: bookAt,
          serviceId: service.id,
          serviceName: service.name,
          date: new Date(`${intent.date}T00:00:00`),
          time: intent.time,
        });

        if (slots.length > 0) {
          const offer = slots[0]!;
          await holdOffer(message.customer.id, offer, bookAt);
          const alternatives = slots.slice(1, 4).map((s) => s.label);
          const text = intent.time
            ? `Yes — ${offer.serviceName} at ${offer.label} on ${humanWhen(offer.startAt)}${offer.staffName ? ` with ${offer.staffName}` : ''}${atBranch} is free. Shall I book it?`
            : `For ${offer.serviceName} on ${humanWhen(offer.startAt)}${atBranch} we have ${[offer.label, ...alternatives].join(', ')}. Shall I book ${offer.label}?`;
          await send(input.tenantId, bookAt, message.customer.id, text);
          await markHandled(message.id);
          return { sent: true, reason: 'offered a slot' };
        }

        // Asked for a specific time that is taken: say so, and offer the day.
        const sameDay = intent.time
          ? await checkAvailability({
              tenantId: input.tenantId,
              branchId: bookAt,
              serviceId: service.id,
              serviceName: service.name,
              date: new Date(`${intent.date}T00:00:00`),
            })
          : [];

        const text = sameDay.length
          ? `${intent.time} is taken that day${atBranch}, but we have ${sameDay.slice(0, 3).map((s) => s.label).join(', ')}. Shall I book one of those?`
          : `We have nothing free for ${service.name} on that day${atBranch}. You can see the other days here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`;

        if (sameDay.length) await holdOffer(message.customer.id, sameDay[0]!, bookAt);
        await send(input.tenantId, bookAt, message.customer.id, text);
        await markHandled(message.id);
        return { sent: true, reason: 'offered alternatives' };
      }
    }
  }

  const { system, user } = replyPrompt({
    salon,
    // Their side of it, oldest first. The salon's outbound copy is not needed to
    // answer. Already read above, because the intent step needed it too.
    conversation: [...thread]
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

  /**
   * The model was unreachable, slow, or said something it was told not to.
   *
   * All three used to end here in silence, and from the customer's side the three
   * are indistinguishable from each other and from the salon ignoring them. The
   * handoff is fixed text precisely because the thing that generates text is what
   * just failed.
   */
  if (!raw) {
    return handOver('CANNOT_ANSWER', 'model did not answer — handed over');
  }

  const parsed = parseReply(raw);
  if ('refused' in parsed) {
    logger.warn(
      { tenantId: input.tenantId, reason: parsed.refused },
      'auto-reply discarded: the model broke a rule it was given',
    );
    return handOver('CANNOT_ANSWER', `reply refused (${parsed.refused}) — handed over`);
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

/**
 * An outstanding slot offer, and the shop it was made at.
 *
 * `branchId` is nullable only because offers held before it existed do not have
 * one; everything written now carries it.
 */
type HeldOffer = SlotOffer & { branchId: string | null };

function readHeldOffer(raw: unknown, at: Date | null): HeldOffer | null {
  if (!raw || !at) return null;
  if (Date.now() - at.getTime() > OFFER_STALE_MINUTES * 60 * 1000) return null;

  const row = raw as Partial<SlotOffer> & { startAt?: string; kind?: string; branchId?: string | null };

  /**
   * One column, two kinds of held conversation.
   *
   * A parked "which location?" question lives here too, and reading it as a slot
   * offer would let a customer's "yes" confirm an appointment that was never
   * offered. A slot offer written before the branch question existed has no
   * `kind` at all, so absence means slot offer and anything else is not ours.
   */
  if (row.kind === BRANCH_PENDING) return null;

  if (!row.serviceId || !row.serviceName || !row.startAt) return null;
  return {
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    startAt: new Date(row.startAt),
    staffId: row.staffId ?? null,
    staffName: row.staffName ?? null,
    label: row.label ?? '',
    branchId: row.branchId ?? null,
  };
}

/**
 * A parked branch question turned back into the booking request it came from.
 *
 * Returns null when the message is not an answer to it — the customer may have
 * changed the subject entirely, and then this message deserves the ordinary
 * reading rather than being forced into a booking they have moved on from.
 */
function resumeBranchChoice(
  pending: PendingBranchChoice,
  body: string,
): { branchId: string; branchName: string; intent: ParsedIntent } | null {
  const chosen = matchBranch(pending.branches, body);
  if (!chosen) return null;

  return {
    branchId: chosen.id,
    branchName: chosen.name,
    /**
     * BOOK, not CONFIRM. Naming a shop is not agreeing to a time — the times
     * have not been offered yet. This goes back through the same check-then-offer
     * path any booking request takes, so the slot is read from the diary at this
     * moment and the customer still has to say yes.
     */
    intent: {
      intent: 'BOOK',
      service: pending.service,
      date: pending.date,
      time: pending.time,
      staff: pending.staff,
    },
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

async function holdOffer(customerId: string, offer: SlotOffer, branchId: string): Promise<void> {
  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      data: {
        // The branch travels with the offer so that confirming it cannot land in
        // a different shop than the one the times were read from.
        assistantOffer: { ...offer, startAt: offer.startAt.toISOString(), branchId },
        assistantOfferAt: new Date(),
      },
    }),
  ).catch(() => undefined);
}

/**
 * Park the "which location?" question with the request that is waiting on it.
 *
 * Shares the column and the clock with a slot offer, which is safe because only
 * one of them can be outstanding: we are either waiting to hear which shop, or
 * waiting to hear yes to a time at a shop we already know.
 */
async function holdPendingBranch(customerId: string, pending: PendingBranchChoice): Promise<void> {
  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      data: {
        assistantOffer: pending as unknown as Prisma.InputJsonObject,
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
