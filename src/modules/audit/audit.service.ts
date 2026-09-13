import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { pageParams } from '../../core/http';
import { startOfDay, endOfDay, dayjs } from '../../core/dates';

/**
 * READING THE AUDIT TRAIL
 *
 * Writes happen through `middleware/audit.ts`, fire-and-forget, from 59 places
 * across the app. This is the other half: letting an owner actually see them.
 *
 * Gated on `audit.view`, which only OWNER and ADMIN hold. That is deliberate —
 * the trail records who discounted a bill and who voided an invoice, so it must
 * not be readable by the people it is watching.
 */

export interface ListAuditInput {
  page?: number;
  pageSize?: number;
  userId?: string;
  branchId?: string;
  entity?: string;
  entityId?: string;
  /** Exact action, e.g. "invoice.voided". */
  action?: string;
  /** Everything under a prefix, e.g. "invoice" matches invoice.*. */
  group?: string;
  from?: string;
  to?: string;
  q?: string;
}

function buildWhere(tenantId: string, input: ListAuditInput): Prisma.AuditLogWhereInput {
  const from = input.from ? startOfDay(input.from) : undefined;
  const to = input.to ? endOfDay(input.to) : undefined;

  return {
    tenantId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.entity ? { entity: input.entity } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.group ? { action: { startsWith: `${input.group}.` } } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(input.q
      ? {
          OR: [
            { action: { contains: input.q, mode: 'insensitive' as const } },
            { entity: { contains: input.q, mode: 'insensitive' as const } },
            { entityId: { contains: input.q } },
            { user: { name: { contains: input.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
}

export async function listAudit(tenantId: string, input: ListAuditInput) {
  const { skip, take, page, pageSize } = pageParams(input);
  const where = buildWhere(tenantId, input);

  const [items, total] = await runUnscoped(() =>
    Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]),
  );

  return { items, total, page, pageSize };
}

/** Everything that ever happened to one record — an invoice, a customer. */
export async function entityHistory(tenantId: string, entity: string, entityId: string) {
  return runUnscoped(() =>
    prisma.auditLog.findMany({
      where: { tenantId, entity, entityId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, role: true } } },
    }),
  );
}

/**
 * The filter options, built from what this salon has actually done rather than
 * from a hardcoded list — a dropdown of 60 actions most of which never occur
 * here is worse than no dropdown.
 */
export async function auditFacets(tenantId: string) {
  const [actions, users] = await runUnscoped(() =>
    Promise.all([
      prisma.auditLog.groupBy({
        by: ['action'],
        where: { tenantId },
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 80,
      }),
      prisma.auditLog.groupBy({
        by: ['userId'],
        where: { tenantId, userId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 50,
      }),
    ]),
  );

  const userIds = users.map((u) => u.userId).filter((id): id is string => Boolean(id));
  const people = userIds.length
    ? await runUnscoped(() =>
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, role: true },
        }),
      )
    : [];

  const groups = [...new Set(actions.map((a) => a.action.split('.')[0]!))].sort();

  return {
    actions: actions.map((a) => ({ action: a.action, count: a._count._all })),
    groups,
    users: users
      .map((u) => {
        const person = people.find((p) => p.id === u.userId);
        return person ? { ...person, count: u._count._all } : null;
      })
      .filter(Boolean),
  };
}

/**
 * The headline an owner wants: what happened today, and the few actions that
 * are worth a second look. Voids, refunds and discounts are where money leaves
 * a salon quietly, so they are counted separately rather than buried in a list.
 */
export async function auditSummary(tenantId: string, days = 7) {
  const since = startOfDay(dayjs().subtract(days - 1, 'day').toDate());

  const [total, today, byAction, sensitive] = await runUnscoped(() =>
    Promise.all([
      prisma.auditLog.count({ where: { tenantId, createdAt: { gte: since } } }),
      prisma.auditLog.count({ where: { tenantId, createdAt: { gte: startOfDay(new Date()) } } }),
      prisma.auditLog.groupBy({
        by: ['action'],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 8,
      }),
      prisma.auditLog.count({
        where: {
          tenantId,
          createdAt: { gte: since },
          action: { in: ['invoice.voided', 'invoice.refunded', 'loyalty.adjusted', 'user.permission.changed'] },
        },
      }),
    ]),
  );

  return {
    windowDays: days,
    total,
    today,
    needsAttention: sensitive,
    topActions: byAction.map((a) => ({ action: a.action, count: a._count._all })),
  };
}

/**
 * Housekeeping. An audit table grows forever and nobody notices until a backup
 * takes an hour. A year is long enough to settle any dispute a salon will have.
 */
export async function pruneAudit(retentionDays = 365): Promise<number> {
  const cutoff = dayjs().subtract(retentionDays, 'day').toDate();
  const { count } = await runUnscoped(() =>
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  );
  return count;
}
