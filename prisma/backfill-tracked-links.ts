/**
 * BACKFILL: WHAT EVERY LINK ALREADY SENT WAS FOR, AND HOW LONG IT SPEAKS FOR.
 *
 * Two columns arrived on TrackedLink at once, and the defaults on existing rows
 * are both wrong in a way that matters:
 *
 *  - `destination` defaults to OTHER, so every link the salon has ever sent
 *    reads as "something". The new per-destination figures would open on the
 *    whole of history filed under one bucket, which is worse than no history
 *    because it looks like an answer.
 *
 *  - `identifiesUntil` defaults to NULL, and NULL means FOREVER. So every link
 *    sent before today would go on crediting its customer indefinitely — the
 *    precise thing the column exists to stop. A gallery link from March,
 *    forwarded to a friend in December, would file the friend's browsing under
 *    the customer's name and then feed it to a segment.
 *
 * The destination is not re-derived here by hand. It goes through the same
 * destinationOf() the live path uses, so the backfill and the send path cannot
 * drift — which is the whole reason this is a script and not SQL with a second
 * copy of the regex in it.
 *
 * INVOICE links are deliberately left at NULL. A customer opens their March
 * bill in October, and nothing is inferred from an invoice view anyway, so
 * there is nothing to misattribute.
 *
 * Safe to run more than once, and safe to run late: it only touches rows still
 * at their defaults, and a link whose thirty days have already passed simply
 * gets a date in the past, which is the correct answer.
 *
 *   docker run --rm --network salon --env-file .env api:migrate \
 *     npx tsx prisma/backfill-tracked-links.ts
 */
import { PrismaClient } from '@prisma/client';
import { destinationOf, identifiesUntil } from '../src/modules/engagement/engagement';

const prisma = new PrismaClient();

const PAGE = 500;

async function main() {
  let scanned = 0;
  const byDestination = new Map<string, number>();
  let dated = 0;

  /**
   * NO CURSOR. The filter is the cursor.
   *
   * Cursor pagination was wrong here and quietly so: every row on a page stops
   * matching `where` the moment it is updated, so the cursor row is no longer
   * in the filtered set and the next page comes back empty. The script would
   * have processed exactly 500 links per run and reported itself finished.
   *
   * Taking the first page of whatever still matches is both simpler and
   * correct, because the work itself is what advances the query.
   */
  for (let guard = 0; guard < 10_000; guard += 1) {
    const rows = await prisma.trackedLink.findMany({
      where: { destination: 'OTHER', identifiesUntil: null },
      select: { id: true, targetUrl: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: PAGE,
    });

    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const destination = destinationOf(row.targetUrl);

      /**
       * Dated from when the link was SENT, not from now.
       *
       * Dating from now would hand every link in the archive a fresh thirty
       * days, which is the opposite of what this is for: a link from March
       * should already be past its window, and running the backfill should not
       * be what revives it.
       */
      const until = identifiesUntil(destination, row.createdAt);

      /**
       * Always written, even when the destination stays OTHER.
       *
       * The write is what makes the row stop matching the query above, so
       * skipping any row would leave it there forever and the loop would not
       * terminate. `until` is only ever null for an INVOICE link, and that row
       * still gets its destination — so every row seen here changes.
       */
      await prisma.trackedLink.update({
        where: { id: row.id },
        data: { destination, identifiesUntil: until },
      });

      byDestination.set(destination, (byDestination.get(destination) ?? 0) + 1);
      if (until) dated += 1;
    }

    if (rows.length < PAGE) break;
  }

  // eslint-disable-next-line no-console
  console.log(
    `tracked links: scanned ${scanned}, dated ${dated}, by destination:`,
    Object.fromEntries([...byDestination.entries()].sort()),
  );
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
