import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { addDays } from '../../core/dates';
import { type Suggestion, suggestNextService } from './next-service';

/**
 * THE DATABASE HALF OF "WHAT SHOULD WE SHOW THEM NEXT".
 *
 * The judgement lives in next-service.ts and is tested without a database.
 * This only fetches, and the interesting decisions here are all about cost:
 * it runs while a message is being built, and a campaign builds thousands.
 *
 * So it is bounded in three ways. Only a year of history, because what
 * customers paired in 2024 is not evidence about this salon now. Only
 * MAX_HISTORY rows, so a large salon cannot turn one message into a table
 * scan. And it is only called at all when the template actually asks for
 * {{explore_link}} or {{suggested_service}} — see `wants` in buildVariables.
 */

/**
 * Enough to see a pattern, few enough to stay a fast indexed read.
 *
 * A busy salon does perhaps 1,500 services a month, so this is roughly the
 * last three months for the busiest and a full year for everybody else —
 * which is the right bias, because a busy salon's recent habits are better
 * evidence than its old ones.
 */
const MAX_HISTORY = 5000;
const HISTORY_DAYS = 365;

export async function suggestForCustomer(
  tenantId: string,
  customerId: string,
): Promise<Suggestion | null> {
  return runUnscoped(async () => {
    /**
     * What they had last, and the category it belongs to.
     *
     * COMPLETED only: a booking that was cancelled or never turned up is not
     * a thing they had, and suggesting a follow-on to a no-show is a message
     * that reads as though nobody was paying attention.
     */
    const last = await prisma.appointmentService.findFirst({
      where: {
        appointment: { tenantId, customerId, status: 'COMPLETED' },
      },
      orderBy: { appointment: { startAt: 'desc' } },
      select: {
        serviceId: true,
        service: { select: { categoryId: true } },
      },
    });

    if (!last) return null;

    const since = addDays(new Date(), -HISTORY_DAYS);

    const [mine, history, catalogue] = await Promise.all([
      prisma.appointmentService.findMany({
        where: { appointment: { tenantId, customerId, status: 'COMPLETED' } },
        select: { serviceId: true },
        distinct: ['serviceId'],
      }),
      prisma.appointmentService.findMany({
        where: {
          appointment: { tenantId, status: 'COMPLETED', startAt: { gte: since }, customerId: { not: null } },
        },
        select: { serviceId: true, appointment: { select: { customerId: true } } },
        orderBy: { id: 'desc' },
        take: MAX_HISTORY,
      }),
      prisma.service.findMany({
        where: { tenantId },
        select: { id: true, name: true, categoryId: true, isActive: true },
      }),
    ]);

    return suggestNextService({
      lastServiceId: last.serviceId,
      lastCategoryId: last.service.categoryId,
      alreadyHad: mine.map((row) => row.serviceId),
      history: history
        .filter((row) => row.appointment.customerId)
        .map((row) => ({ customerId: row.appointment.customerId!, serviceId: row.serviceId })),
      catalogue,
    });
  });
}
