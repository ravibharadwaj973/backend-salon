import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './prisma';
import { logger } from './logger';

/**
 * IS THE DATABASE BEHIND THE CODE?
 *
 * ── The failure this exists to make impossible ────────────────────────────
 *
 * A deploy shipped code that wrote to `feedback.invoiceId`, to
 * `feedback.reviewDraft`, and to a `feedback_service_ratings` table. The
 * migrations that create those had not been run. Everything still LOOKED
 * fine: the feedback page rendered, because reading only touches columns that
 * have existed for months. It was writing that died — so the one thing that
 * broke was a customer pressing Send, which is the one path nobody exercises
 * while checking a deploy went out.
 *
 * In production the customer saw "Something went wrong. Please try again."
 * and the salon owner saw nothing at all, because a rating that fails to save
 * leaves no trace by definition. Days went into looking at the API key, the
 * model name and the prompt — none of which were ever the problem.
 *
 * ── Why it is checked here rather than trusted to a deploy step ───────────
 *
 * `prisma migrate deploy` belongs in the release pipeline, and it is there.
 * But a pipeline step can be skipped, reordered, or silently fail on a
 * platform that restarts the container anyway, and the application is the
 * last place that can still notice. It costs one query at boot.
 *
 * Nothing is applied automatically. A process that migrates its own database
 * on startup will, the day two containers start at once, run two migrations
 * concurrently against one database. This only ever reports.
 */

/** Null means "cannot tell" — never reported as if it meant zero. */
let lastKnown: string[] | null = null;

/** What the last check found, for /health. Null until the first check. */
export function pendingMigrationsAtBoot(): string[] | null {
  return lastKnown;
}

/**
 * Migration folders on disk that the database has no finished record of.
 *
 * Returns null rather than an empty array when the question cannot be
 * answered — no migrations folder shipped, or no `_prisma_migrations` table
 * because the database is managed some other way. Those are legitimate
 * setups, and an alarm that fires on them is an alarm people learn to ignore.
 */
export async function checkPendingMigrations(): Promise<string[] | null> {
  let onDisk: string[];
  try {
    onDisk = readdirSync(join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    lastKnown = null;
    return null;
  }

  if (onDisk.length === 0) {
    lastKnown = null;
    return null;
  }

  try {
    /**
     * ASK WHETHER THE TABLE EXISTS BEFORE READING IT.
     *
     * Selecting from a missing table raises 42P01, and Prisma logs that at
     * ERROR level through its own logger before this function's catch can
     * swallow it. On a database managed with `db push` there IS no
     * _prisma_migrations table — a legitimate setup — so every boot printed a
     * red line about a condition that is fine.
     *
     * Which was worse than untidy: it filled the one channel somebody greps
     * when a real error is being hunted. A check that cries wolf on a healthy
     * system is a check people learn to scroll past.
     *
     * to_regclass returns NULL rather than raising for a name that does not
     * resolve, so this asks the question without the database objecting.
     */
    const [probe] = await prisma.$queryRaw<{ present: string | null }[]>`
      SELECT to_regclass('public._prisma_migrations')::text AS present
    `;
    if (!probe?.present) {
      lastKnown = null;
      return null;
    }

    /**
     * finished_at, not merely present: a row is written when a migration
     * STARTS. One that crashed halfway is in the table and has not been
     * applied, and treating it as done would report a healthy database that
     * is missing half a table.
     */
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    const applied = new Set(rows.map((row) => row.migration_name));
    lastKnown = onDisk.filter((name) => !applied.has(name));
    return lastKnown;
  } catch {
    lastKnown = null;
    return null;
  }
}

/**
 * Check, and say so loudly enough that it cannot be scrolled past.
 *
 * Deliberately `error` level and deliberately naming every outstanding
 * migration. A warning that says "some migrations are pending" sends somebody
 * to a psql prompt; the list plus the command does not.
 */
export async function reportPendingMigrations(): Promise<void> {
  const pending = await checkPendingMigrations();
  if (pending === null || pending.length === 0) return;

  logger.error(
    { pending, count: pending.length },
    `DATABASE IS BEHIND THE CODE: ${pending.length} migration(s) have not been run. ` +
      'Writes to the new columns will fail with a 500 while reads carry on working, ' +
      'so the app will look healthy. Run `npx prisma migrate deploy`.',
  );
}
