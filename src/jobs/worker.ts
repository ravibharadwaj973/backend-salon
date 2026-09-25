import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { env } from '../config/env';
import { prisma, connectDatabase, disconnectDatabase } from '../core/prisma';
import { runUnscoped } from '../core/context';
import { logger } from '../core/logger';
import { dayjs } from '../core/dates';
import { getHandler } from './handlers';
import { enqueue } from './queue';

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

let running = false;
let stopping = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Claims a job by flipping PENDING -> RUNNING. Because the update is filtered on
 * the current status, only one worker can win the row, so several workers can
 * share the queue without a distributed lock.
 */
async function claim(jobId: string): Promise<boolean> {
  const result = await runUnscoped(() =>
    prisma.job.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'RUNNING', lockedAt: new Date(), lockedBy: WORKER_ID, attempts: { increment: 1 } },
    }),
  );
  return result.count === 1;
}

async function runOnce(): Promise<number> {
  const due = await runUnscoped(() =>
    prisma.job.findMany({
      where: { status: 'PENDING', runAt: { lte: new Date() } },
      orderBy: { runAt: 'asc' },
      take: env.JOB_BATCH_SIZE,
      select: { id: true },
    }),
  );
  if (!due.length) return 0;

  let processed = 0;

  for (const { id } of due) {
    if (stopping) break;
    if (!(await claim(id))) continue;

    const job = await runUnscoped(() => prisma.job.findUnique({ where: { id } }));
    if (!job) continue;

    const handler = getHandler(job.type);

    if (!handler) {
      await runUnscoped(() =>
        prisma.job.update({
          where: { id },
          data: { status: 'DEAD', lastError: `No handler registered for "${job.type}"` },
        }),
      );
      logger.error({ type: job.type }, 'no handler for job type');
      continue;
    }

    const startedAt = Date.now();

    try {
      const result = await handler((job.payload as Record<string, unknown>) ?? {}, job);
      await runUnscoped(() =>
        prisma.job.update({ where: { id }, data: { status: 'DONE', lockedAt: null, lockedBy: null } }),
      );
      logger.debug({ type: job.type, ms: Date.now() - startedAt, result }, 'job completed');
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const exhausted = job.attempts >= job.maxAttempts;
      const backoff = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 3600;

      await runUnscoped(() =>
        prisma.job.update({
          where: { id },
          data: {
            status: exhausted ? 'DEAD' : 'PENDING',
            lastError: message,
            lockedAt: null,
            lockedBy: null,
            runAt: exhausted ? job.runAt : dayjs().add(backoff, 'second').toDate(),
          },
        }),
      );

      logger[exhausted ? 'error' : 'warn'](
        { err, type: job.type, attempt: job.attempts, exhausted },
        'job failed',
      );
    }
  }

  return processed;
}

async function loop(): Promise<void> {
  if (running || stopping) return;
  running = true;
  try {
    await runOnce();
  } catch (err) {
    logger.error({ err }, 'worker loop error');
  } finally {
    running = false;
  }
}

/**
 * Recurring sweeps, on the SALON'S clock.
 *
 * node-cron with no timezone uses the container's, which is UTC — so "09:00
 * birthdays" went out at half past two in the afternoon, "06:30 alerts" at
 * noon, and the 01:00 housekeeping at half past six in the morning while the
 * shop was opening. Every time below was written as an Indian salon's hour and
 * silently ran as a London one.
 */
function registerSchedules(): void {
  // Passed to every schedule below. Read from configuration rather than
  // hard-coded: the timezone is the tenant's, and a deployment elsewhere must
  // not have to edit code to keep its own opening hours.
  const opts = { timezone: env.DEFAULT_TIMEZONE };
  // Every 15 minutes: catch appointments that were never checked in.
  cron.schedule('*/15 * * * *', () => void enqueue('appointment.no_show_sweep', {}, { tenantId: null }), opts);

  // 06:30 — build the day's alert list before the salon opens.
  cron.schedule('30 6 * * *', () => void enqueue('alerts.generate', {}, { tenantId: null }), opts);

  // 09:00 — birthdays and anniversaries.
  cron.schedule('0 9 * * *', () => void enqueue('birthday.sweep', {}, { tenantId: null }), opts);

  // 10:00 — lapsed customers enter win-back journeys.
  cron.schedule('0 10 * * *', () => void enqueue('winback.sweep', {}, { tenantId: null }), opts);

  // 11:00 — membership and package expiries.
  cron.schedule('0 11 * * *', () => void enqueue('membership.expiry_sweep', {}, { tenantId: null }), opts);
  cron.schedule('15 11 * * *', () => void enqueue('package.expiry_sweep', {}, { tenantId: null }), opts);

  // 01:00 — housekeeping: loyalty expiry, segment counts, challenge enrolment.
  cron.schedule('0 1 * * *', () => void enqueue('loyalty.expiry_sweep', {}, { tenantId: null }), opts);
  // 01:10 — re-derive where each customer sits in their own visit cycle. Must
  // run BEFORE segment.recompute: every lifecycle segment reads what it writes.
  cron.schedule('10 1 * * *', () => void enqueue('lifecycle.sweep', {}, { tenantId: null }), opts);
  cron.schedule('20 1 * * *', () => void enqueue('segment.recompute', {}, { tenantId: null }), opts);
  cron.schedule('40 1 * * *', () => void enqueue('challenge.progress', {}, { tenantId: null }), opts);
  // 08:00 — renewal reminders, before the salon gets busy. Warns only; nothing
  // is ever switched off by a scheduled job.
  cron.schedule('0 8 * * *', () => void enqueue('subscription.renewal_reminders', {}, { tenantId: null }), opts);

  // 02:00 Sunday — trim audit rows older than a year.
  cron.schedule('0 2 * * 0', () => void enqueue('audit.prune', {}, { tenantId: null }), opts);

  logger.info('scheduled sweeps registered');
}

export function startWorker(): void {
  if (!env.JOB_WORKER_ENABLED) {
    logger.warn('job worker disabled by configuration');
    return;
  }
  registerSchedules();
  timer = setInterval(() => void loop(), env.JOB_POLL_INTERVAL_MS);
  logger.info({ workerId: WORKER_ID, intervalMs: env.JOB_POLL_INTERVAL_MS }, 'job worker started');
}

export async function stopWorker(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  // Give an in-flight job a moment to finish.
  for (let i = 0; i < 20 && running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  logger.info('job worker stopped');
}

/** Re-queues jobs abandoned by a worker that died mid-run. */
export async function reclaimStuckJobs(olderThanMinutes = 15): Promise<number> {
  const result = await runUnscoped(() =>
    prisma.job.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: dayjs().subtract(olderThanMinutes, 'minute').toDate() } },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    }),
  );
  if (result.count) logger.warn({ count: result.count }, 'reclaimed stuck jobs');
  return result.count;
}

/** Standalone entry point: `npm run start:worker`. */
async function main(): Promise<void> {
  await connectDatabase();
  await reclaimStuckJobs();
  startWorker();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    await stopWorker();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    logger.error({ err }, 'worker failed to start');
    process.exit(1);
  });
}
