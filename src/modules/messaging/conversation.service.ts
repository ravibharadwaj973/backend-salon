import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { NotFound } from '../../core/errors';
import { normalizePhone } from '../../core/ids';
import { allowedShape, minutesLeftInWindow, windowIsOpen } from '../../messaging/service-window';
import { queueMessage } from '../../messaging/dispatcher';
import type { Channel, ConversationEventKind, ConversationMode, Prisma } from '@prisma/client';

/**
 * THE THREAD, AND WHO IS ANSWERING IT.
 *
 * Everything a salon and a customer have said to each other, in one place, with
 * one switch deciding whether the assistant or a person replies next.
 *
 * ── What was wrong before ─────────────────────────────────────────────────
 *
 * Nothing joined the two halves. A customer's messages were in
 * `inbound_messages` and the salon's were in `message_logs`, so no screen could
 * render a conversation — and the assistant was answering customers in the
 * salon's name with nobody able to watch it happen.
 *
 * And the only control was a boolean on the tenant. A customer raising
 * something the assistant should not touch could be handled exactly one way:
 * switch the assistant off for every customer that salon has. `mode` on the
 * thread is what replaces that.
 *
 * ── The rule that keeps the two tables honest ─────────────────────────────
 *
 * The thread is ASSEMBLED, never duplicated. Nothing here copies a message into
 * a third table: the reader unions the two that already exist and sorts by
 * time. So a delivery receipt landing on a message_log is visible in the thread
 * immediately, and there is no second copy to drift.
 */

/** What a thread looks like to a screen. One shape for all three speakers. */
export interface ThreadTurn {
  id: string;
  /**
   * Who said it — or, for EVENT, that nobody said anything and the assistant
   * DID something.
   *
   * AI and HUMAN are both the salon talking, and a salon looking at its own
   * thread needs to know which; that is most of why anybody opens this screen.
   * EVENT is a third thing entirely: nothing was sent to anybody, so it must
   * not be drawn as a message the customer could have seen.
   */
  from: 'CUSTOMER' | 'AI' | 'HUMAN' | 'SYSTEM' | 'EVENT';
  /** EVENT only: which kind, so a screen can render the important ones louder. */
  eventKind?: ConversationEventKind;
  /** EVENT only: the particulars, for anyone who wants them. */
  detail?: unknown;
  body: string;
  at: Date;
  /** Outbound only: QUEUED, SENT, DELIVERED, READ, FAILED. */
  status?: string;
  /** Outbound only, and only when it failed — the reason, in Meta's words. */
  error?: string | null;
  messageType?: string;
}

/**
 * Who sent an outbound message, worked out from what it was.
 *
 * The assistant's replies are free-form WHATSAPP messages with purpose OTHER
 * and no template, and so are a staff member's — which is why `sourceRef` is
 * not enough and the log records it explicitly. Anything belonging to a
 * campaign or a journey is the system talking, not a person.
 */
export function speakerFor(row: { campaignId: string | null; journeyRunId: string | null; sentByUserId?: string | null }): 'AI' | 'HUMAN' | 'SYSTEM' {
  if (row.campaignId || row.journeyRunId) return 'SYSTEM';
  return row.sentByUserId ? 'HUMAN' : 'AI';
}

/**
 * The thread for this customer on this channel, creating it if this is the
 * first anybody has heard from them.
 *
 * `mode` is seeded once, from the salon's own default, and never re-read from
 * it afterwards. That is the point: a salon that later switches its default off
 * has not thereby taken over forty open conversations, and a salon that
 * switches it on has not handed back the ones its staff are holding.
 */
export async function openConversation(input: {
  tenantId: string;
  channel: Channel;
  address: string;
  customerId?: string | null;
  branchId?: string | null;
}): Promise<{ id: string; mode: ConversationMode }> {
  const customerAddress = normalizePhone(input.address);

  const existing = await runUnscoped(() =>
    prisma.conversation.findUnique({
      where: {
        tenantId_channel_customerAddress: {
          tenantId: input.tenantId,
          channel: input.channel,
          customerAddress,
        },
      },
      select: { id: true, mode: true, customerId: true },
    }),
  );

  if (existing) {
    /**
     * A thread that started as a stranger's and now has a name.
     *
     * Somebody messages before they are on the book, gets added at the counter
     * an hour later, and the thread should follow them rather than stay
     * anonymous — otherwise the assistant keeps refusing to answer a customer
     * the salon now knows perfectly well.
     */
    if (!existing.customerId && input.customerId) {
      await runUnscoped(() =>
        prisma.conversation.update({
          where: { id: existing.id },
          data: { customerId: input.customerId, branchId: input.branchId ?? undefined },
        }),
      ).catch(() => undefined);
    }
    return { id: existing.id, mode: existing.mode };
  }

  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { settings: true } }),
  );
  const settings = (tenant?.settings as Record<string, unknown> | null) ?? {};
  const mode: ConversationMode = settings.whatsappAutoReply === true ? 'AI' : 'HUMAN';

  try {
    const created = await runUnscoped(() =>
      prisma.conversation.create({
        data: {
          tenantId: input.tenantId,
          channel: input.channel,
          customerAddress,
          customerId: input.customerId ?? null,
          branchId: input.branchId ?? null,
          mode,
        },
        select: { id: true, mode: true },
      }),
    );
    return created;
  } catch (err) {
    /**
     * Two webhooks for the same new customer, arriving together.
     *
     * Meta delivers in parallel and retries, so the first message from somebody
     * can genuinely race itself. The unique index settles it; this reads back
     * the winner rather than failing the message that lost.
     */
    const again = await runUnscoped(() =>
      prisma.conversation.findUnique({
        where: {
          tenantId_channel_customerAddress: {
            tenantId: input.tenantId,
            channel: input.channel,
            customerAddress,
          },
        },
        select: { id: true, mode: true },
      }),
    );
    if (again) return again;
    throw err;
  }
}

/** The customer has just written: the thread reopens and the window restarts. */
export async function noteCustomerMessage(conversationId: string, at: Date): Promise<void> {
  await runUnscoped(() =>
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastCustomerMessageAt: at,
        lastMessageAt: at,
        // A closed thread is not a wall. Somebody writing again has reopened
        // it, whatever the salon decided last week.
        status: 'OPEN',
      },
    }),
  ).catch((err: unknown) => logger.warn({ err, conversationId }, 'conversation not updated'));
}

/** Anybody on the salon's side has spoken. Only the inbox order changes. */
export async function noteOutboundMessage(conversationId: string, at: Date): Promise<void> {
  await runUnscoped(() =>
    prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at } }),
  ).catch(() => undefined);
}

/**
 * Hand the thread to a person.
 *
 * Called by a staff member taking over, and by the assistant itself whenever it
 * refuses something — a complaint, a booking that failed for our own reasons.
 * The assistant flagging a thread is the whole reason `needsAttentionAt`
 * exists: "someone will look at this personally" was a promise with nowhere to
 * land, and this is the place it lands.
 */
export async function handToHuman(input: {
  tenantId: string;
  conversationId: string;
  assignedToId?: string | null;
  reason: string;
}): Promise<void> {
  await runUnscoped(() =>
    prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        mode: 'HUMAN',
        needsAttentionAt: new Date(),
        ...(input.assignedToId ? { assignedToId: input.assignedToId } : {}),
      },
    }),
  ).catch((err: unknown) => logger.warn({ err, ...input }, 'could not hand conversation to a person'));

  logger.info({ conversationId: input.conversationId, reason: input.reason }, 'conversation handed to a person');

  /**
   * In the thread as well as the log, because the log is not where anybody
   * looks. A salon opening a conversation that stopped being answered should be
   * able to see that it was handed over, and why, without asking anybody.
   */
  await recordEvent({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    kind: input.assignedToId ? 'TAKEN_OVER' : 'HANDED_OVER',
    summary: input.assignedToId ? 'Taken over by a person' : `Handed to a person — ${input.reason}`,
    detail: { reason: input.reason },
  });
}

/**
 * Give it back to the assistant.
 *
 * DELIBERATELY NEVER AUTOMATIC. A person has just made promises in the salon's
 * name — "I'll look into this myself" — and the assistant reads the history it
 * is resumed into. Handing back on a timer, or when a ticket closes, means a
 * model picking up a thread mid-apology and cheerfully offering a booking. It
 * takes somebody deciding.
 */
export async function resumeAssistant(
  tenantId: string,
  conversationId: string,
  byUserId: string | null,
): Promise<void> {
  await runUnscoped(() =>
    prisma.conversation.update({
      where: { id: conversationId },
      data: { mode: 'AI', needsAttentionAt: null },
    }),
  );
  logger.info({ conversationId, byUserId }, 'assistant resumed on a conversation');

  /**
   * Recorded because it is the most consequential thing a person can do here.
   * Whoever handed a complaint back to a machine, and when, is exactly the
   * question somebody will ask afterwards.
   */
  await recordEvent({
    tenantId,
    conversationId,
    kind: 'ASSISTANT_RESUMED',
    summary: 'Given back to the assistant',
  });
}

/**
 * WHAT A STAFF MEMBER MAY SEND RIGHT NOW.
 *
 * Asked before the reply box is drawn, not after somebody has typed into it.
 * Outside Meta's 24-hour window free text is refused by Meta, not by us — so a
 * screen that offers a box and a Send button outside it is lying to the person
 * using it, and the first they learn of it is a failed send.
 */
export function replyWindow(lastCustomerMessageAt: Date | null): {
  open: boolean;
  shape: 'FREE_FORM' | 'TEMPLATE';
  minutesLeft: number;
} {
  return {
    open: windowIsOpen(lastCustomerMessageAt),
    shape: allowedShape(lastCustomerMessageAt),
    minutesLeft: minutesLeftInWindow(lastCustomerMessageAt),
  };
}

/**
 * The whole thread, oldest first.
 *
 * Two reads and a merge rather than one table, for the reason at the top of
 * this file. `take` is applied to each side and then to the merge, so a thread
 * with four hundred campaign messages and six real ones still shows the six.
 */
export async function threadFor(
  conversationId: string,
  limit = 100,
): Promise<ThreadTurn[]> {
  const [inbound, outbound, events] = await runUnscoped(() =>
    Promise.all([
      prisma.inboundMessage.findMany({
        where: { conversationId },
        orderBy: { receivedAt: 'desc' },
        take: limit,
        select: { id: true, body: true, receivedAt: true, messageType: true },
      }),
      prisma.messageLog.findMany({
        where: { conversationId },
        orderBy: { queuedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          renderedBody: true,
          queuedAt: true,
          status: true,
          errorMessage: true,
          campaignId: true,
          journeyRunId: true,
          sentByUserId: true,
        },
      }),
      /**
       * Three reads, not two. Same reasoning as the other two: the thread is
       * assembled rather than duplicated, so a table holding part of the story
       * is read rather than copied into one holding another part.
       */
      prisma.conversationEvent.findMany({
        where: { conversationId },
        orderBy: { at: 'desc' },
        take: limit,
        select: { id: true, kind: true, summary: true, detail: true, at: true },
      }),
    ]),
  );

  const turns: ThreadTurn[] = [
    ...inbound.map((row) => ({
      id: row.id,
      from: 'CUSTOMER' as const,
      body: row.body,
      at: row.receivedAt,
      messageType: row.messageType,
    })),
    ...outbound.map((row) => ({
      id: row.id,
      from: speakerFor(row),
      body: row.renderedBody ?? '',
      at: row.queuedAt,
      status: row.status,
      error: row.errorMessage,
    })),
    ...events.map((row) => ({
      id: row.id,
      from: 'EVENT' as const,
      body: row.summary,
      at: row.at,
      eventKind: row.kind,
      detail: row.detail,
    })),
  ];

  return turns.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-limit);
}

/**
 * WRITE DOWN WHAT WAS JUST DONE.
 *
 * Called by the code that did the thing, immediately after doing it — never by
 * the model, never in advance, never as an intention. That is the whole value:
 * an event saying an appointment was booked is written after createAppointment
 * returned an id, by the function holding the id, so it is evidence rather than
 * a claim.
 *
 * Failure is swallowed. A thread that cannot record that it checked the diary
 * must still be able to answer the customer — losing the audit line is a bad
 * day, losing the reply is a lost booking.
 */
export async function recordEvent(input: {
  tenantId: string;
  conversationId: string | null;
  kind: ConversationEventKind;
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  if (!input.conversationId) return;
  await runUnscoped(() =>
    prisma.conversationEvent.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId!,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        ...(input.detail ? { detail: input.detail as Prisma.InputJsonObject } : {}),
      },
    }),
  ).catch((err: unknown) =>
    logger.warn({ err, conversationId: input.conversationId, kind: input.kind }, 'conversation event not recorded'),
  );
}

/**
 * THE INBOX LIST.
 *
 * Ordered by last activity, because a salon opening this screen is looking for
 * whoever spoke most recently, not whoever wrote first. `needsAttention` is
 * surfaced as its own flag rather than a separate list: a thread the assistant
 * has handed over is still the same thread, and splitting them into two screens
 * is how one of them stops being read.
 */
export async function listConversations(input: {
  tenantId: string;
  needsAttentionOnly?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<{ data: ConversationSummary[]; total: number }> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  const where = {
    tenantId: input.tenantId,
    ...(input.needsAttentionOnly ? { needsAttentionAt: { not: null }, status: 'OPEN' as const } : {}),
  };

  const [rows, total] = await runUnscoped(() =>
    Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          mode: true,
          status: true,
          customerAddress: true,
          lastCustomerMessageAt: true,
          lastMessageAt: true,
          needsAttentionAt: true,
          customer: { select: { id: true, firstName: true, lastName: true } },
          assignedTo: { select: { id: true, name: true } },
        },
      }),
      prisma.conversation.count({ where }),
    ]),
  );

  /**
   * The last thing said, and by whom, for the list.
   *
   * One query for the whole page rather than one per row: a list of twenty-five
   * conversations should not be twenty-five round trips, and the preview is the
   * part that makes the list readable.
   */
  const ids = rows.map((row) => row.id);
  const previews = await lastTurnByConversation(ids);

  return {
    total,
    data: rows.map((row) => {
      const preview = previews.get(row.id);
      return {
        id: row.id,
        mode: row.mode,
        status: row.status,
        customerId: row.customer?.id ?? null,
        name:
          [row.customer?.firstName, row.customer?.lastName].filter(Boolean).join(' ') ||
          row.customerAddress,
        address: row.customerAddress,
        /** True when nobody on the book matches this number. */
        stranger: !row.customer,
        assignedTo: row.assignedTo?.name ?? null,
        needsAttention: row.needsAttentionAt != null,
        lastMessageAt: row.lastMessageAt,
        lastCustomerMessageAt: row.lastCustomerMessageAt,
        preview: preview?.body ?? '',
        previewFrom: preview?.from ?? null,
        window: replyWindow(row.lastCustomerMessageAt),
      };
    }),
  };
}

export interface ConversationSummary {
  id: string;
  mode: ConversationMode;
  status: string;
  customerId: string | null;
  name: string;
  address: string;
  stranger: boolean;
  assignedTo: string | null;
  needsAttention: boolean;
  lastMessageAt: Date | null;
  lastCustomerMessageAt: Date | null;
  preview: string;
  previewFrom: ThreadTurn['from'] | null;
  window: { open: boolean; shape: 'FREE_FORM' | 'TEMPLATE'; minutesLeft: number };
}

/** The most recent turn in each of these threads, from either table. */
async function lastTurnByConversation(
  ids: string[],
): Promise<Map<string, { body: string; from: ThreadTurn['from']; at: Date }>> {
  const out = new Map<string, { body: string; from: ThreadTurn['from']; at: Date }>();
  if (ids.length === 0) return out;

  const [inbound, outbound] = await runUnscoped(() =>
    Promise.all([
      prisma.inboundMessage.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { receivedAt: 'desc' },
        select: { conversationId: true, body: true, receivedAt: true },
      }),
      prisma.messageLog.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { queuedAt: 'desc' },
        select: {
          conversationId: true,
          renderedBody: true,
          queuedAt: true,
          campaignId: true,
          journeyRunId: true,
          sentByUserId: true,
        },
      }),
    ]),
  );

  const consider = (id: string | null, body: string, from: ThreadTurn['from'], at: Date) => {
    if (!id) return;
    const held = out.get(id);
    if (!held || held.at < at) out.set(id, { body, from, at });
  };

  for (const row of inbound) consider(row.conversationId, row.body, 'CUSTOMER', row.receivedAt);
  for (const row of outbound) {
    consider(row.conversationId, row.renderedBody ?? '', speakerFor(row), row.queuedAt);
  }

  return out;
}

/**
 * A PERSON REPLYING, THROUGH THE SAME NUMBER.
 *
 * Refuses outside the window rather than attempting the send. Meta rejects
 * free-form text after 24 hours with error 131047, which arrives asynchronously
 * as a failed delivery — so attempting it would show the staff member a message
 * that looks sent, sitting in the thread, that never arrived. Better to refuse
 * it while they are still looking at what they typed.
 */
export async function sendStaffReply(input: {
  tenantId: string;
  conversationId: string;
  userId: string;
  body: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const conversation = await runUnscoped(() =>
    prisma.conversation.findFirst({
      where: { id: input.conversationId, tenantId: input.tenantId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        customerAddress: true,
        lastCustomerMessageAt: true,
      },
    }),
  );

  if (!conversation) return { sent: false, reason: 'conversation not found' };

  const window = replyWindow(conversation.lastCustomerMessageAt);
  if (!window.open) {
    return {
      sent: false,
      reason:
        'The 24-hour window has closed, so WhatsApp will not deliver a plain message to this ' +
        'customer. Send an approved template instead, or wait until they write again.',
    };
  }

  await queueMessage({
    tenantId: input.tenantId,
    ...(conversation.branchId ? { branchId: conversation.branchId } : {}),
    ...(conversation.customerId ? { customerId: conversation.customerId } : {}),
    toAddress: conversation.customerAddress,
    channel: 'WHATSAPP',
    body: input.body.slice(0, 4000),
    conversationId: conversation.id,
    // The one field that will let the thread call this turn a person's.
    sentByUserId: input.userId,
    sendNow: true,
  });

  await runUnscoped(() =>
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        /**
         * Answering IS attending to it. Leaving the flag up after a person has
         * replied would keep the thread in the queue they opened it from, and a
         * queue that does not empty is one nobody trusts.
         */
        needsAttentionAt: null,
      },
    }),
  ).catch(() => undefined);

  return { sent: true };
}

/**
 * One thread, with everything a screen needs to draw it.
 *
 * The window travels with the messages on purpose. A composer drawn without it
 * lets somebody write a paragraph and learn only on send that Meta will not
 * carry it — and the failure arrives asynchronously as a delivery error, long
 * after they have walked away believing it went.
 */
export async function readConversation(tenantId: string, id: string) {
  const conversation = await runUnscoped(() =>
    prisma.conversation.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        mode: true,
        status: true,
        customerAddress: true,
        lastCustomerMessageAt: true,
        lastMessageAt: true,
        needsAttentionAt: true,
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    }),
  );

  if (!conversation) throw NotFound('Conversation');

  return {
    id: conversation.id,
    mode: conversation.mode,
    status: conversation.status,
    name:
      [conversation.customer?.firstName, conversation.customer?.lastName].filter(Boolean).join(' ') ||
      conversation.customerAddress,
    address: conversation.customerAddress,
    customerId: conversation.customer?.id ?? null,
    stranger: !conversation.customer,
    assignedTo: conversation.assignedTo?.name ?? null,
    needsAttention: conversation.needsAttentionAt != null,
    window: replyWindow(conversation.lastCustomerMessageAt),
    turns: await threadFor(conversation.id),
  };
}
