import type { Prisma } from '@prisma/client';
import { prisma } from '../core/prisma';
import { getContext } from '../core/context';
import { logger } from '../core/logger';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  branchId?: string | null;
  /**
   * THE SALON THIS HAPPENED TO, when the actor is not one of its users.
   *
   * A platform route runs with no tenant in context — that is the whole point of
   * it — so every audit call made from one hit the guard below and wrote nothing
   * at all. Not a warning, not a partial row: silence. Support could reset a
   * locked-out owner's password and leave no trace anywhere in the system, which
   * is the exact opposite of what an audit trail is for.
   *
   * So a platform route names the tenant it acted on. It belongs in that salon's
   * trail — they are the ones entitled to know somebody outside their business
   * touched their account.
   */
  tenantId?: string | null;
}

/**
 * Fire-and-forget audit trail. Never throws into the caller: a failed audit
 * write must not fail the business operation it describes.
 */
export function audit(input: AuditInput): void {
  const ctx = getContext();
  const tenantId = input.tenantId ?? ctx?.tenantId;
  if (!tenantId) return;

  void prisma.auditLog
    .create({
      data: {
        tenantId,
        branchId: input.branchId ?? ctx?.activeBranchId ?? null,
        userId: ctx?.userId ?? null,
        // Who, when "who" does not work for the salon. Both written out, so the
        // trail can still answer the question after the account is deleted.
        platformUserId: ctx?.platformUserId ?? null,
        actorName: ctx?.actorName ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      },
    })
    .catch((err: unknown) => logger.warn({ err, action: input.action }, 'audit log write failed'));
}
