import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';

/**
 * WHAT CUSTOMERS HAVE WRITTEN IN, AND WHETHER ANYBODY HAS LOOKED.
 *
 * The salon has had an outbound log since the beginning — every message it
 * sent, with delivery receipts. It has never had the other half. A customer
 * replying to a reminder was reaching the server and being discarded, so the
 * question "did anyone answer them?" could not be asked, let alone answered.
 *
 * ── The 24-hour window is why receivedAt matters more than it looks ──────
 *
 * WhatsApp allows a free-form reply only within 24 hours of the customer
 * writing. Outside it, only an approved template will send, and a plain reply
 * comes back 131047 — which the salon experiences as their answer silently not
 * arriving. So every message carries how long is left, and the list leads with
 * the ones about to expire rather than the ones that arrived first.
 */

/** WhatsApp's customer-service window: free-form replies are allowed inside it. */
export const REPLY_WINDOW_HOURS = 24;

export function windowClosesAt(receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + REPLY_WINDOW_HOURS * 60 * 60 * 1000);
}

export function minutesLeft(receivedAt: Date, now = new Date()): number {
  return Math.max(0, Math.round((windowClosesAt(receivedAt).getTime() - now.getTime()) / 60000));
}

export async function listInbound(input: {
  page?: number;
  pageSize?: number;
  customerId?: string;
  unhandledOnly?: boolean;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where = {
    tenantId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.unhandledOnly ? { handledAt: null } : {}),
  };

  const [rows, total, unhandled] = await Promise.all([
    prisma.inboundMessage.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip,
      take,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
    }),
    prisma.inboundMessage.count({ where }),
    // The number worth putting on a badge, always for the whole salon rather
    // than the current filter — a count that changes when you filter is not a
    // count anybody can act on.
    prisma.inboundMessage.count({ where: { tenantId, handledAt: null } }),
  ]);

  const now = new Date();

  return {
    data: rows.map((row) => ({
      id: row.id,
      body: row.body,
      messageType: row.messageType,
      fromAddress: row.fromAddress,
      receivedAt: row.receivedAt,
      handledAt: row.handledAt,
      customer: row.customer,
      /**
       * Minutes until a free-form reply stops being possible. Zero means an
       * approved template is now the only way to answer — the salon should be
       * told that before they type, not after Meta refuses it.
       */
      replyWindowMinutesLeft: minutesLeft(row.receivedAt, now),
    })),
    meta: { page, pageSize, total, unhandled },
  };
}

/** Marks one as dealt with. Idempotent: marking it twice keeps the first time. */
export async function markHandled(id: string, userId: string) {
  const tenantId = requireTenantId();
  const row = await prisma.inboundMessage.findFirst({ where: { id, tenantId } });
  if (!row) throw NotFound('Message');
  if (row.handledAt) return row;

  return prisma.inboundMessage.update({
    where: { id },
    data: { handledAt: new Date(), handledBy: userId },
  });
}
