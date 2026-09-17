import type { Prisma } from '@prisma/client';
import { prisma } from '../core/prisma';
import { getContext, runUnscoped } from '../core/context';
import { logger } from '../core/logger';

export type JobType =
  | 'journey.trigger'
  | 'journey.advance'
  | 'message.send'
  | 'campaign.dispatch'
  | 'campaign.attribute'
  | 'appointment.reminder'
  | 'appointment.no_show_sweep'
  | 'invoice.post_process'
  | 'customer.rollup'
  | 'inventory.consume'
  | 'alerts.generate'
  | 'membership.expiry_sweep'
  | 'package.expiry_sweep'
  | 'loyalty.expiry_sweep'
  | 'lifecycle.sweep'
  | 'segment.recompute'
  | 'winback.sweep'
  | 'birthday.sweep'
  | 'challenge.progress'
  | 'audit.prune'
  | 'subscription.renewal_reminders';

export interface EnqueueOptions {
  /** When to run. Defaults to now. */
  runAt?: Date;
  /** Collapses duplicates — a second enqueue with the same key is ignored. */
  uniqueKey?: string;
  maxAttempts?: number;
  tenantId?: string | null;
}

/**
 * Jobs live in Postgres rather than Redis: one less service to run, and the
 * queue is transactionally consistent with the business data it refers to.
 */
export async function enqueue(
  type: JobType,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<void> {
  const tenantId = options.tenantId !== undefined ? options.tenantId : (getContext()?.tenantId ?? null);

  try {
    await runUnscoped(() =>
      prisma.job.create({
        data: {
          tenantId,
          type,
          payload: payload as Prisma.InputJsonValue,
          runAt: options.runAt ?? new Date(),
          maxAttempts: options.maxAttempts ?? 5,
          uniqueKey: options.uniqueKey ?? null,
        },
      }),
    );
  } catch (err) {
    // A unique-key clash simply means the job is already scheduled.
    const code = (err as { code?: string }).code;
    if (code === 'P2002') return;
    logger.error({ err, type }, 'failed to enqueue job');
    throw err;
  }
}

/** Enqueue without letting a queue failure break the caller's request. */
export function enqueueSafe(type: JobType, payload: Record<string, unknown> = {}, options: EnqueueOptions = {}): void {
  void enqueue(type, payload, options).catch((err: unknown) =>
    logger.warn({ err, type }, 'background job could not be queued'),
  );
}

export async function cancelJobs(uniqueKeyPrefix: string): Promise<number> {
  const result = await runUnscoped(() =>
    prisma.job.deleteMany({ where: { uniqueKey: { startsWith: uniqueKeyPrefix }, status: 'PENDING' } }),
  );
  return result.count;
}
