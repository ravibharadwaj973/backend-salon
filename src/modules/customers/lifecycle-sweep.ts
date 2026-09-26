import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { DEFAULT_INTERVAL_DAYS, stageFor } from './visit-rhythm';
import { dispatchVisitDue } from './visit-due.dispatch';
import type { StageCrossing } from './visit-due';

/**
 * A customer's stage changes because time passed, not because anything
 * happened.
 *
 * The rollups are recalculated when a bill is raised, which is exactly when a
 * customer is LEAST likely to be overdue. Nobody bills a customer who has
 * stopped coming — so without this sweep, the one group the whole lifecycle
 * exists to find is the one group whose stage never updates. "Due this week"
 * would only ever be right for people who were in that week.
 *
 * So the stage is re-derived nightly from two columns already on the row. The
 * cycle itself is not recomputed: it only changes when a new visit happens,
 * and that already triggers the full rollup. This is the cheap half.
 *
 * It reuses `stageFor` rather than reimplementing the bands in SQL. A single
 * UPDATE would be faster, and it would also be a second copy of the ladder
 * that silently drifts from the first the next time a boundary moves.
 */

const DAY = 24 * 60 * 60 * 1000;
const PAGE = 1000;

/**
 * How many customers may have their cycle computed from scratch in one run.
 *
 * The stage is cheap — two columns and some arithmetic. Learning the cycle in
 * the first place means reading a customer's invoice history, and doing that
 * for an entire book in one night would be a long, pointless spike.
 *
 * So the backfill is bounded and self-healing: a salon with 10,000 customers
 * converges over a few nights with nobody having to remember to run anything,
 * and a salon that installs today is done by tomorrow morning.
 */
const BACKFILL_PER_RUN = 500;

/**
 * How many of tonight's crossings are kept in memory to be offered to the
 * journeys.
 *
 * The sweep pages through the whole book, so on a first run "changed" can be
 * every customer there is. The journeys only ever act on a capped handful, and
 * they want the most overdue of them — which needs the list sorted, which needs
 * it held. Bounded so a 50,000-customer book cannot turn one nightly job into a
 * memory problem; anything past the bound waits for tomorrow's sweep, which is
 * exactly what the cap does to it anyway.
 */
const MAX_CROSSINGS_HELD = 5_000;

export async function sweepLifecycleStages(
  now: Date = new Date(),
): Promise<{ scanned: number; changed: number; filled: number; triggered: number }> {
  let cursor: string | undefined;
  let scanned = 0;
  let changed = 0;
  const crossings: StageCrossing[] = [];

  for (;;) {
    const rows = await runUnscoped(() =>
      prisma.customer.findMany({
        where: { isActive: true },
        select: {
          id: true,
          tenantId: true,
          totalVisits: true,
          lastVisitAt: true,
          visitIntervalDays: true,
          visitIntervalBasis: true,
          lifecycleStage: true,
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }),
    );

    if (rows.length === 0) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const daysSince = row.lastVisitAt
        ? Math.max(0, Math.round((now.getTime() - row.lastVisitAt.getTime()) / DAY))
        : 0;
      const interval = row.visitIntervalDays ?? DEFAULT_INTERVAL_DAYS;
      const ratio = Math.round((daysSince / interval) * 100) / 100;

      const stage = stageFor({ visits: row.totalVisits, daysSince, ratio });
      if (stage === row.lifecycleStage) continue;

      /**
       * The crossing, recorded before the write.
       *
       * This is the moment the whole VISIT_DUE trigger hangs off: a customer
       * passing their own due date is not an event anything else can observe,
       * because nothing happens. Nobody books, nobody is billed, no webhook
       * fires. Time simply passes, and this sweep is the only thing that
       * notices.
       */
      if (crossings.length < MAX_CROSSINGS_HELD) {
        crossings.push({
          customerId: row.id,
          tenantId: row.tenantId,
          from: row.lifecycleStage,
          to: stage,
          daysSince,
          totalVisits: row.totalVisits,
          basedOnIntervals: row.visitIntervalBasis,
        });
      }

      // Only the rows that actually moved are written, so a quiet night is a
      // handful of updates rather than a rewrite of the whole book.
      await runUnscoped(() =>
        prisma.customer.update({ where: { id: row.id }, data: { lifecycleStage: stage } }),
      ).catch((err: unknown) => logger.warn({ err, customerId: row.id }, 'lifecycle stage update failed'));
      changed += 1;
    }

    if (rows.length < PAGE) break;
  }

  const filled = await backfillMissingRhythms();

  // After the stages are written, not during: a journey that reads the
  // customer's stage as part of its audience rules must see the new one.
  const { triggered, heldBack } = await dispatchVisitDue(crossings);

  logger.info({ scanned, changed, filled, triggered, heldBack }, 'lifecycle stages swept');
  return { scanned, changed, filled, triggered };
}

/**
 * Teach the cycle to customers who have never had one worked out.
 *
 * Rollups run when a bill is raised, so every customer who existed before this
 * feature has no rhythm and never will until they next visit — which is
 * exactly the wrong condition, since the customers worth finding are the ones
 * not visiting. This closes that gap without anyone running a script.
 */
async function backfillMissingRhythms(): Promise<number> {
  const pending = await runUnscoped(() =>
    prisma.customer.findMany({
      where: { visitIntervalBasis: 0, totalVisits: { gte: 2 }, isActive: true },
      select: { id: true, tenantId: true },
      take: BACKFILL_PER_RUN,
      orderBy: { lastVisitAt: 'desc' },
    }),
  );

  if (pending.length === 0) return 0;

  const { recalculateCustomerRollups } = await import('./customer.service');
  const { runAsTenant } = await import('../../core/context');

  let filled = 0;
  for (const row of pending) {
    // Per customer rather than in a transaction: one bad row must not stop the
    // rest, and a half-finished sweep is picked up again tomorrow.
    await runAsTenant(row.tenantId, () => recalculateCustomerRollups(row.id))
      .then(() => {
        filled += 1;
      })
      .catch((err: unknown) => logger.warn({ err, customerId: row.id }, 'rhythm backfill failed'));
  }

  return filled;
}
