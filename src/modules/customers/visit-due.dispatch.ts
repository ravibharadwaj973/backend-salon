import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { enqueue } from '../../jobs/queue';
import { readVisitDueConfig, selectCrossings, type StageCrossing } from './visit-due';

/**
 * Turn tonight's stage crossings into journey entries.
 *
 * Split from visit-due.ts so the decisions there stay pure and testable: this
 * file only reads journeys, calls selectCrossings and enqueues. Everything
 * that could be wrong about WHO gets messaged lives next door, under test.
 */
export async function dispatchVisitDue(
  crossings: StageCrossing[],
): Promise<{ triggered: number; heldBack: number }> {
  if (crossings.length === 0) return { triggered: 0, heldBack: 0 };

  const byTenant = new Map<string, StageCrossing[]>();
  for (const crossing of crossings) {
    const list = byTenant.get(crossing.tenantId);
    if (list) list.push(crossing);
    else byTenant.set(crossing.tenantId, [crossing]);
  }

  let triggered = 0;
  let heldBack = 0;

  for (const [tenantId, tenantCrossings] of byTenant) {
    const journeys = await runUnscoped(() =>
      prisma.journey.findMany({
        where: { tenantId, trigger: 'VISIT_DUE', isActive: true },
        select: { id: true, name: true, triggerConfig: true },
      }),
    );

    for (const journey of journeys) {
      const config = readVisitDueConfig(journey.triggerConfig);
      const eligible = tenantCrossings.filter((c) => config.stages.includes(c.to));
      const chosen = selectCrossings(tenantCrossings, config);
      const held = Math.max(0, eligible.length - chosen.length);

      if (held > 0) {
        /**
         * Logged loudly rather than silently, because the first night after a
         * salon switches this on the held-back number is the whole book and
         * somebody will ask why only fifty messages went out. The answer is in
         * the log, with the journey's name on it.
         */
        logger.info(
          { tenantId, journey: journey.name, sending: chosen.length, held, cap: config.maxPerRun },
          'visit-due crossings capped for tonight; the rest are picked up on later sweeps',
        );
        heldBack += held;
      }

      for (const crossing of chosen) {
        await enqueue('journey.trigger', {
          tenantId,
          trigger: 'VISIT_DUE',
          customerId: crossing.customerId,
          // Carried so the run records which crossing started it. Without it,
          // a run started by DUE_SOON and one started by AT_RISK are the same
          // row, and the reason a customer was messaged is unrecoverable.
          extra: { stage: crossing.to, daysSince: String(crossing.daysSince) },
        }).catch((err: unknown) =>
          logger.warn({ err, customerId: crossing.customerId }, 'visit-due trigger could not be queued'),
        );
        triggered += 1;
      }
    }
  }

  return { triggered, heldBack };
}
