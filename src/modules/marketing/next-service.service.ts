import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { addDays } from '../../core/dates';
import { type PurchaseRow, type Suggestion, suggestNextService } from './next-service';

/**
 * THE DATABASE HALF OF "WHAT SHOULD WE SHOW THEM NEXT".
 *
 * The judgement lives in next-service.ts and is tested without a database.
 * This only fetches, and its decisions are about two things: cost, and where
 * the salon's history actually lives.
 *
 * ── Two sources, because salons work two ways ─────────────────────────────
 *
 * The obvious source is the appointment book: completed appointments, with
 * their services. It is also only half of many salons. A walk-in is billed
 * straight through the counter and the appointment book is never opened, so
 * the customer has an invoice and no appointment at all — and reading only
 * appointments would silently exclude every one of them, in exactly the
 * salons where walk-ins are most of the trade.
 *
 * So purchases are read from BOTH: completed appointment services, and
 * service lines on invoices. Billing an appointment writes both, which is
 * harmless — suggestNextService counts each customer once per service, so a
 * visit recorded twice is still one piece of evidence.
 *
 * ── Bounded, because this runs while a message is being built ─────────────
 *
 * Only a year, because what customers paired in 2024 is not evidence about
 * this salon now. Only MAX_HISTORY rows per source, so a large salon cannot
 * turn one message into a table scan. And only called at all when the
 * template actually asks for {{explore_link}} or {{suggested_service}} — see
 * `wants` in buildVariables.
 */

const MAX_HISTORY = 5000;
const HISTORY_DAYS = 365;

export async function suggestForCustomer(
  tenantId: string,
  customerId: string,
): Promise<Suggestion | null> {
  return runUnscoped(async () => {
    /**
     * What they had last — from whichever source saw it more recently.
     *
     * COMPLETED and non-draft only: a booking that was cancelled or never
     * turned up is not a thing they had, and suggesting a follow-on to a
     * no-show reads as though nobody was paying attention.
     */
    const [lastAppointment, lastBilled] = await Promise.all([
      prisma.appointmentService.findFirst({
        where: { appointment: { tenantId, customerId, status: 'COMPLETED' } },
        orderBy: { appointment: { startAt: 'desc' } },
        select: { serviceId: true, appointment: { select: { startAt: true } } },
      }),
      prisma.invoiceItem.findFirst({
        where: {
          itemType: 'SERVICE',
          refId: { not: null },
          invoice: { tenantId, customerId, status: { not: 'DRAFT' } },
        },
        orderBy: { invoice: { invoiceDate: 'desc' } },
        select: { refId: true, invoice: { select: { invoiceDate: true } } },
      }),
    ]);

    const candidates = [
      lastAppointment
        ? { serviceId: lastAppointment.serviceId, at: lastAppointment.appointment.startAt }
        : null,
      lastBilled?.refId ? { serviceId: lastBilled.refId, at: lastBilled.invoice.invoiceDate } : null,
    ].filter((row): row is { serviceId: string; at: Date } => row !== null);

    if (candidates.length === 0) return null;

    const last = candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0]!;
    const since = addDays(new Date(), -HISTORY_DAYS);

    const [lastService, mineBooked, mineBilled, bookedHistory, billedHistory, catalogue] =
      await Promise.all([
        prisma.service.findUnique({ where: { id: last.serviceId }, select: { categoryId: true } }),

        prisma.appointmentService.findMany({
          where: { appointment: { tenantId, customerId, status: 'COMPLETED' } },
          select: { serviceId: true },
          distinct: ['serviceId'],
        }),
        prisma.invoiceItem.findMany({
          where: {
            itemType: 'SERVICE',
            refId: { not: null },
            invoice: { tenantId, customerId, status: { not: 'DRAFT' } },
          },
          select: { refId: true },
          distinct: ['refId'],
        }),

        prisma.appointmentService.findMany({
          where: {
            appointment: {
              tenantId,
              status: 'COMPLETED',
              startAt: { gte: since },
              customerId: { not: null },
            },
          },
          select: { serviceId: true, appointment: { select: { customerId: true } } },
          orderBy: { id: 'desc' },
          take: MAX_HISTORY,
        }),
        prisma.invoiceItem.findMany({
          where: {
            itemType: 'SERVICE',
            refId: { not: null },
            invoice: {
              tenantId,
              status: { not: 'DRAFT' },
              invoiceDate: { gte: since },
              customerId: { not: null },
            },
          },
          select: { refId: true, invoice: { select: { customerId: true } } },
          orderBy: { id: 'desc' },
          take: MAX_HISTORY,
        }),

        prisma.service.findMany({
          where: { tenantId },
          select: { id: true, name: true, categoryId: true, isActive: true },
        }),
      ]);

    const history: PurchaseRow[] = [
      ...bookedHistory
        .filter((row) => row.appointment.customerId)
        .map((row) => ({ customerId: row.appointment.customerId!, serviceId: row.serviceId })),
      ...billedHistory
        .filter((row) => row.invoice.customerId && row.refId)
        .map((row) => ({ customerId: row.invoice.customerId!, serviceId: row.refId! })),
    ];

    return suggestNextService({
      lastServiceId: last.serviceId,
      lastCategoryId: lastService?.categoryId ?? null,
      alreadyHad: [
        ...mineBooked.map((row) => row.serviceId),
        ...mineBilled.map((row) => row.refId!).filter(Boolean),
      ],
      history,
      catalogue,
    });
  });
}
