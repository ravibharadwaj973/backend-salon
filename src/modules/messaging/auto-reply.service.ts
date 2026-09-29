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
import { handToHuman, noteOutboundMessage, recordEvent } from './conversation.service';
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
  type BranchChoice,
  type PendingBranchChoice,
  bookableBranches,
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

  const message = await runUnscoped(() =>
    prisma.inboundMessage.findUnique({
      where: { id: input.inboundMessageId },
      include: {
        conversation: { select: { id: true, mode: true } },
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
   * WHO IS ANSWERING THIS THREAD.
   *
   * This used to be one boolean on the tenant, and that was the wrong place for
   * it. A salon whose customer raised something the assistant should not touch
   * had exactly one control available: switch the assistant off for every
   * customer they have. The people most likely to need to take one conversation
   * in hand were the ones made to choose between that and letting a machine
   * answer a complaint.
   *
   * The salon's setting still decides, but only once — it seeds the mode of a
   * thread when the thread is created, in openConversation. After that the
   * conversation owns it, so taking over one customer is taking over one
   * customer, and handing them back is a click on that thread.
   *
   * A message with no conversation cannot be answered automatically. That is
   * not caution, it is the honest reading: without a thread there is nothing to
   * hold a mode, nothing for a person to take over, and nothing anybody could
   * watch it do.
   */
  if (!message.conversation) return { sent: false, reason: 'message has no conversation' };
  if (message.conversation.mode !== 'AI') {
    return { sent: false, reason: 'a person has this conversation' };
  }

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
  /**
   * Write down what was just done, against this thread.
   *
   * Bound to the tenant and conversation once so the call sites read as what
   * happened rather than as plumbing — there are several and the plumbing would
   * otherwise be most of the line.
   */
  const note = (
    kind: Parameters<typeof recordEvent>[0]['kind'],
    summary: string,
    detail?: Record<string, unknown>,
  ) =>
    recordEvent({
      tenantId: input.tenantId,
      conversationId: message.conversation!.id,
      kind,
      summary,
      ...(detail ? { detail } : {}),
    });

  const handOver = async (reason: HandoffReason, decision: string): Promise<AutoReplyDecision> => {
    /**
     * The thread changes hands BEFORE the message goes out, and regardless of
     * whether one can be sent at all.
     *
     * "Someone will look at this personally" was a promise with nowhere to land
     * — nothing recorded that anybody should. Now the conversation moves to
     * HUMAN and is stamped as needing attention, so it appears in the queue
     * staff actually open. A salon with no phone number and no website gets no
     * message to send, and the flag still matters more in that case, not less.
     */
    await handToHuman({
      tenantId: input.tenantId,
      conversationId: message.conversation!.id,
      reason: decision,
    });

    const text = handoffReply(salon, reason);
    if (!text) return { sent: false, reason: `${decision} (nothing to hand over to)` };
    await send(input.tenantId, branchId, message.customer!.id, text, message.conversation!.id);
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
   * "ACTUALLY, THE OTHER ONE."
   *
   * A time has been offered at the shop we worked out from their history, and
   * the customer has answered with a different shop's name. That is not a
   * question and it is not a yes — it is the same booking, moved, and until now
   * it fell through to the model and came back as an apology.
   *
   * Which made the branch a decision nobody could revisit: chosen silently from
   * their past, mentioned in passing, and impossible to change without starting
   * over. Somebody who usually goes to Gomti Nagar may be asking about Saturday
   * precisely because they will be near the other one.
   *
   * Ordinals are refused here, deliberately. With a time already on the table a
   * bare "2" is far likelier to mean two o'clock than shop number two, and
   * reading it as a shop would move a booking nobody asked to move.
   */
  const switched = !resumed && offerHeld ? await branchSwitch(input.tenantId, offerHeld, message.body) : null;
  if (switched) {
    await clearOffer(message.customer.id);
    await recordEvent({
      tenantId: input.tenantId,
      conversationId: message.conversation.id,
      kind: 'BRANCH_SWITCHED',
      summary: `Moved to ${switched.branchName} at the customer's request`,
      detail: { from: offerHeld?.branchName ?? null, to: switched.branchName },
    });
  }

  /** Either way: a branch the customer has just named, and the request to redo. */
  const forced = resumed ?? switched;

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

  if (forced) {
    intent = forced.intent;
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

    /**
     * Three outcomes, not two.
     *
     * Booked, the slot went, or something else went wrong — and the third used
     * to be told the second's story. A customer hearing "that time has just
     * gone" when the real fault was ours goes and finds another time that will
     * fail in exactly the same way, and the salon never hears about it. If we
     * cannot book and cannot say why, the honest thing is to hand them to a
     * person.
     */
    if (booked.ok) {
      await send(
        input.tenantId,
        confirmBranchId,
        message.customer.id,
        `Done — ${offerHeld.serviceName} on ${humanWhen(offerHeld.startAt)}${offerHeld.staffName ? ` with ${offerHeld.staffName}` : ''}${offerHeld.branchName ? ` at ${offerHeld.branchName}` : ''}. See you then.`,
        message.conversation.id,
      );
      await note(
        'APPOINTMENT_BOOKED',
        `Booked ${offerHeld.serviceName} for ${humanWhen(offerHeld.startAt)} at ${offerHeld.label}`,
        {
          appointmentId: booked.appointmentId,
          serviceName: offerHeld.serviceName,
          startAt: offerHeld.startAt.toISOString(),
          branchName: offerHeld.branchName,
          staffName: offerHeld.staffName,
        },
      );
      await markHandled(message.id);
      return { sent: true, reason: 'booked' };
    }

    if (booked.taken) {
      await send(
        input.tenantId,
        confirmBranchId,
        message.customer.id,
        `Sorry — that time has just gone. Would another time suit you? You can also see what is free here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`,
        message.conversation.id,
      );
      await note('BOOKING_FAILED', 'The slot went between the offer and the yes', {
        serviceName: offerHeld.serviceName,
        startAt: offerHeld.startAt.toISOString(),
        reason: booked.reason,
      });
      await markHandled(message.id);
      return { sent: true, reason: 'slot taken' };
    }

    await note('BOOKING_FAILED', 'Could not book, and not because the slot had gone', {
      serviceName: offerHeld.serviceName,
      startAt: offerHeld.startAt.toISOString(),
      reason: booked.reason,
    });
    // Deliberately NOT marked handled: somebody has to finish this booking.
    return handOver('PERSON', 'booking failed for a reason that is ours — handed to a person');
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
      const where = forced
        ? ({
            kind: 'RESOLVED',
            branchId: forced.branchId,
            branchName: forced.branchName,
            // True by construction: we only ask, or switch, when there are several.
            ofMany: true,
            others: forced.others,
          } as const)
        : await resolveBranch({
            tenantId: input.tenantId,
            customerBranchId: message.customer.branchId,
            messageBranchId: message.branchId,
            customerId: message.customer.id,
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
        await send(input.tenantId, null, message.customer.id, where.question, message.conversation.id);
        await note('BRANCH_ASKED', `Asked which location — ${where.branches.map((b) => b.name).join(', ')}`);
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
         * NAMED WHENEVER THE SALON HAS MORE THAN ONE SHOP.
         *
         * It used to be said only when the customer had just chosen it. That
         * covered the one case where we asked and left every other case silent
         * — including the common one, where the branch was worked out from
         * their history and never mentioned. A two-shop salon was sending
         * "Done, see you Tuesday" to somebody who had not been told which
         * address to go to.
         */
        const atBranch = where.ofMany ? ` at ${where.branchName}` : '';
        const branchLabel = where.ofMany ? where.branchName : null;

        /**
         * THE OTHER SHOP, OFFERED RATHER THAN HIDDEN.
         *
         * The branch is worked out from the customer's own history, which is
         * right nearly always and silent when it is wrong. Somebody who usually
         * comes to one shop may be asking about Saturday precisely because they
         * will be near the other, and with nothing said they have no way to know
         * the choice was even made.
         *
         * So the alternative is named in the same breath as the time, and saying
         * it back switches the booking — see branchSwitch. One clause, and the
         * decision stops being ours alone.
         *
         * Capped at two, because a sentence listing six shops is not an offer,
         * it is a menu, and it buries the time it was supposed to be confirming.
         */
        const elsewhere =
          where.ofMany && where.others.length > 0
            ? ` We are also at ${where.others.slice(0, 2).map((b) => b.name).join(' and ')} — just say the word if that suits you better.`
            : '';

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
          await holdOffer(message.customer.id, offer, bookAt, branchLabel);
          const alternatives = slots.slice(1, 4).map((s) => s.label);
          const text =
            (intent.time
              ? `Yes — ${offer.serviceName} at ${offer.label} on ${humanWhen(offer.startAt)}${offer.staffName ? ` with ${offer.staffName}` : ''}${atBranch} is free. Shall I book it?`
              : `For ${offer.serviceName} on ${humanWhen(offer.startAt)}${atBranch} we have ${[offer.label, ...alternatives].join(', ')}. Shall I book ${offer.label}?`) + elsewhere;
          await send(input.tenantId, bookAt, message.customer.id, text, message.conversation.id);
          await note('AVAILABILITY_CHECKED', `Read the diary for ${service.name} on ${humanWhen(offer.startAt)}${atBranch}`, {
            serviceName: service.name,
            date: intent.date,
            free: slots.length,
          });
          await note('SLOT_OFFERED', `Offered ${offer.label} on ${humanWhen(offer.startAt)}${atBranch}`, {
            serviceName: offer.serviceName,
            startAt: offer.startAt.toISOString(),
            staffName: offer.staffName,
          });
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
          ? `${intent.time} is taken that day${atBranch}, but we have ${sameDay.slice(0, 3).map((s) => s.label).join(', ')}. Shall I book one of those?${elsewhere}`
          : // Nothing free HERE is exactly when the other shop is worth knowing
            // about, so it is offered before the link to look elsewhere in time.
              `We have nothing free for ${service.name} on that day${atBranch}.${elsewhere} You can also see other days here: ${salon.bookingUrl ?? salon.websiteUrl ?? 'our website'}`;

        if (sameDay.length) await holdOffer(message.customer.id, sameDay[0]!, bookAt, branchLabel);
        await send(input.tenantId, bookAt, message.customer.id, text, message.conversation.id);
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
    conversationId: message.conversation.id,
  });
  await noteOutboundMessage(message.conversation.id, new Date());

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
type HeldOffer = SlotOffer & {
  branchId: string | null;
  /**
   * Set only at a salon with more than one shop, which is the only time it
   * needs saying. Carried on the offer so the confirmation can name the shop
   * without re-deriving it — and re-deriving it after the customer has agreed
   * would be the one moment it must not change.
   */
  branchName: string | null;
};

function readHeldOffer(raw: unknown, at: Date | null): HeldOffer | null {
  if (!raw || !at) return null;
  if (Date.now() - at.getTime() > OFFER_STALE_MINUTES * 60 * 1000) return null;

  const row = raw as Partial<SlotOffer> & {
    startAt?: string;
    kind?: string;
    branchId?: string | null;
    branchName?: string | null;
  };

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
    branchName: row.branchName ?? null,
  };
}

/**
 * A branch the customer has just named, and the booking to redo there.
 *
 * Produced two ways — answering "which location?", or naming a different shop
 * after a time has been offered — and handled identically from then on, because
 * from the code's point of view they are the same event: this shop, that
 * request, check it again.
 */
interface ForcedBranch {
  branchId: string;
  branchName: string;
  others: BranchChoice[];
  intent: ParsedIntent;
}

/**
 * The same booking, at the shop they just named instead.
 *
 * Reads the service, the day and the time back off the outstanding offer rather
 * than off this message, which contains a place name and nothing else. Returns
 * null when the message names no shop, or names the one the offer is already
 * at — a customer confirming "yes, Gomti Nagar" is agreeing, not moving, and
 * must fall through to CONFIRM.
 */
async function branchSwitch(
  tenantId: string,
  offer: HeldOffer,
  body: string,
): Promise<ForcedBranch | null> {
  const branches = await bookableBranches(tenantId);
  if (branches.length < 2) return null;

  const named = matchBranch(branches, body, { ordinals: false });
  if (!named || named.id === offer.branchId) return null;

  return {
    branchId: named.id,
    branchName: named.name,
    others: branches.filter((row) => row.id !== named.id),
    /**
     * BOOK, not CONFIRM. The times at the other shop are a different diary and
     * nothing has been offered there yet, so this goes back through the same
     * check-then-offer path and the customer still has to say yes.
     */
    intent: {
      intent: 'BOOK',
      service: offer.serviceName,
      date: dateKey(offer.startAt),
      time: offer.label || null,
      staff: null,
    },
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
): ForcedBranch | null {
  const chosen = matchBranch(pending.branches, body);
  if (!chosen) return null;

  return {
    branchId: chosen.id,
    branchName: chosen.name,
    others: pending.branches.filter((row) => row.id !== chosen.id),
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

async function holdOffer(
  customerId: string,
  offer: SlotOffer,
  branchId: string,
  branchName: string | null,
): Promise<void> {
  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      data: {
        // The branch travels with the offer so that confirming it cannot land in
        // a different shop than the one the times were read from.
        assistantOffer: { ...offer, startAt: offer.startAt.toISOString(), branchId, branchName },
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
  conversationId?: string | null,
): Promise<void> {
  await queueMessage({
    tenantId,
    ...(branchId ? { branchId } : {}),
    customerId,
    channel: 'WHATSAPP',
    body: text.slice(0, MAX_REPLY_CHARS),
    // No sentByUserId: nobody typed this. That absence is exactly what the
    // thread reads to label the turn as the assistant rather than a person.
    ...(conversationId ? { conversationId } : {}),
  });
  if (conversationId) await noteOutboundMessage(conversationId, new Date());
}
