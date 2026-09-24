/**
 * BACKFILL: WHAT EVERY MESSAGE ALREADY SENT WAS FOR.
 *
 * `purpose` is new, so every row written before it exists says OTHER. Left
 * that way the new reports would open on a year of history filed under
 * "Other" — worse than no history, because it looks like an answer.
 *
 * The mapping is not invented here. It is read out of the notification
 * catalogue, which is the same declaration the app now sends with, so the
 * backfill and the live path cannot drift apart. Where a template serves two
 * purposes — review_request is the private "how was it?" as a utility and the
 * public "rate us" as marketing — the message's own snapshotted category
 * decides, which is exactly what distinguished them at the time.
 *
 * Safe to run more than once: it only touches rows still sitting at OTHER,
 * and it never invents a purpose for a row it cannot explain.
 *
 *   docker run --rm --network salon --env-file .env api:migrate \
 *     npx tsx prisma/backfill-purpose.ts
 */
import { PrismaClient, type MessagePurpose, type TemplateCategory } from '@prisma/client';
import { NOTIFICATIONS } from '../src/messaging/notifications';
import { purposeOfTrigger } from '../src/messaging/purpose';

const prisma = new PrismaClient();

/** template name + the category it was sent as → purpose. */
const byTemplateName = new Map<string, Array<{ category: TemplateCategory; purpose: MessagePurpose }>>();
for (const def of Object.values(NOTIFICATIONS)) {
  const list = byTemplateName.get(def.template) ?? [];
  list.push({ category: def.category, purpose: def.purpose });
  byTemplateName.set(def.template, list);
}

async function main() {
  const started = Date.now();
  let touched = 0;

  // 1. Anything with a campaign is a campaign, whatever template it used.
  const campaigns = await prisma.messageLog.updateMany({
    where: { purpose: 'OTHER', campaignId: { not: null } },
    data: { purpose: 'CAMPAIGN' },
  });
  touched += campaigns.count;
  console.log(`campaigns: ${campaigns.count}`);

  // 2. Journey sends take the purpose of the journey's trigger — the same
  //    rule the live path now applies.
  const journeys = await prisma.journey.findMany({ select: { id: true, trigger: true } });
  const runsByPurpose = new Map<MessagePurpose, string[]>();
  for (const journey of journeys) {
    const purpose = purposeOfTrigger(journey.trigger);
    if (purpose === 'OTHER') continue;
    const runs = await prisma.journeyRun.findMany({
      where: { journeyId: journey.id },
      select: { id: true },
    });
    const list = runsByPurpose.get(purpose) ?? [];
    list.push(...runs.map((r) => r.id));
    runsByPurpose.set(purpose, list);
  }
  for (const [purpose, runIds] of runsByPurpose) {
    // Chunked: an id list of unbounded length becomes a query Postgres
    // refuses, and a backfill that dies halfway is worse than a slow one.
    for (let i = 0; i < runIds.length; i += 1_000) {
      const result = await prisma.messageLog.updateMany({
        where: { purpose: 'OTHER', journeyRunId: { in: runIds.slice(i, i + 1_000) } },
        data: { purpose },
      });
      touched += result.count;
    }
    console.log(`journey ${purpose}: ${runIds.length} runs`);
  }

  // 3. Everything else by the template it used, disambiguated by category.
  const templates = await prisma.messageTemplate.findMany({ select: { id: true, name: true } });
  for (const [name, options] of byTemplateName) {
    const ids = templates.filter((t) => t.name === name).map((t) => t.id);
    if (!ids.length) continue;

    const distinct = new Set(options.map((o) => o.purpose));
    if (distinct.size === 1) {
      const result = await prisma.messageLog.updateMany({
        where: { purpose: 'OTHER', templateId: { in: ids } },
        data: { purpose: options[0]!.purpose },
      });
      touched += result.count;
      continue;
    }

    // Same template, two jobs. The category it was sent under tells them apart.
    for (const option of options) {
      const result = await prisma.messageLog.updateMany({
        where: { purpose: 'OTHER', templateId: { in: ids }, category: option.category },
        data: { purpose: option.purpose },
      });
      touched += result.count;
    }
  }

  const left = await prisma.messageLog.count({ where: { purpose: 'OTHER' } });
  console.log(
    `\nbackfilled ${touched} messages in ${Math.round((Date.now() - started) / 1000)}s. ` +
      `${left} remain as Other — one-off sends and templates the salon wrote itself, which is correct.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
