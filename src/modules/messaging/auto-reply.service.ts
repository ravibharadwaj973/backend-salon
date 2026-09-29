import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { aiReady } from '../../config/env';
import { chat } from '../../core/ai';
import { queueMessage } from '../../messaging/dispatcher';
import { windowIsOpen } from '../../messaging/service-window';
import { salonContext } from './salon-context';
import { MAX_REPLY_CHARS, needsHuman, parseReply, replyPrompt } from './reply-ai';

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
