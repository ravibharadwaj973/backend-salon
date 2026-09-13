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
}

/**
 * Fire-and-forget audit trail. Never throws into the caller: a failed audit
 * write must not fail the business operation it describes.
 */
export function audit(input: AuditInput): void {
  const ctx = getContext();
  if (!ctx?.tenantId) return;

  void prisma.auditLog
    .create({
      data: {
        tenantId: ctx.tenantId,
        branchId: input.branchId ?? ctx.activeBranchId,
        userId: ctx.userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    })
    .catch((err: unknown) => logger.warn({ err, action: input.action }, 'audit log write failed'));
}
