import type { AlertSeverity, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { branchFilter, optionalBranchFilter } from '../../core/scope';
import { pageParams } from '../../core/http';
import { add, d, formatINR } from '../../core/money';
import { addDays, dateOnly, dayjs, endOfDay, startOfDay } from '../../core/dates';
import { logger } from '../../core/logger';

interface AlertDraft {
  type: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  data?: Record<string, unknown>;
  branchId?: string | null;
}

/**
 * Builds the owner's alert list — the "what needs attention today" panel. Each
 * alert is upserted once per type per day so the list never duplicates.
 */
export async function generateAlerts(tenantId: string, branchId?: string | null) {
  const today = dateOnly(new Date());
  const drafts: AlertDraft[] = [];

  const branchWhere = branchId ? { branchId } : {};
  const optionalBranch = branchId ? { branchId } : {};

  const [
    lapsed,
    expiringMemberships,
    unconfirmedTomorrow,
    lowStock,
    outstandingAgg,
    expiringPackages,
    unresolvedComplaints,
    idleStaff,
  ] = await Promise.all([
    prisma.customer.count({
      where: { tenantId, ...optionalBranch, isActive: true, lastVisitAt: { lte: addDays(new Date(), -45), not: null } },
    }),
    prisma.membershipSubscription.count({
      where: { tenantId, ...branchWhere, status: 'ACTIVE', endAt: { gte: new Date(), lte: addDays(new Date(), 7) } },
    }),
    prisma.appointment.count({
      where: {
        tenantId,
        ...branchWhere,
        status: 'BOOKED',
        startAt: { gte: startOfDay(addDays(new Date(), 1)), lte: endOfDay(addDays(new Date(), 1)) },
      },
    }),
    prisma.stock.findMany({
      where: { tenantId, ...branchWhere, product: { isActive: true, reorderLevel: { gt: 0 } } },
      include: { product: { select: { name: true, reorderLevel: true } } },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, ...branchWhere, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueAmount: { gt: 0 } },
      _sum: { dueAmount: true },
      _count: { _all: true },
    }),
    prisma.packagePurchase.count({
      where: { tenantId, ...branchWhere, status: 'ACTIVE', expiresAt: { gte: new Date(), lte: addDays(new Date(), 15) } },
    }),
    prisma.feedback.count({ where: { tenantId, ...branchWhere, isComplaint: true, resolvedAt: null } }),
    prisma.staff.findMany({
      where: { tenantId, ...branchWhere, isActive: true, isBookable: true },
      select: {
        id: true,
        displayName: true,
        appointmentServices: {
          where: { startAt: { gte: addDays(new Date(), -7) }, appointment: { status: { in: ['COMPLETED', 'CHECKED_IN'] } } },
          select: { durationMin: true },
        },
      },
    }),
  ]);

  if (lapsed > 0) {
    drafts.push({
      type: 'LAPSED_CUSTOMERS',
      title: `${lapsed} customers haven't visited in 45 days`,
      body: 'Send a win-back offer before they go somewhere else.',
      severity: lapsed > 40 ? 'WARNING' : 'INFO',
      data: { count: lapsed, days: 45 },
      branchId,
    });
  }

  if (expiringMemberships > 0) {
    drafts.push({
      type: 'MEMBERSHIPS_EXPIRING',
      title: `${expiringMemberships} memberships expire this week`,
      body: 'Renewal reminders go out automatically, but a call converts better.',
      severity: 'WARNING',
      data: { count: expiringMemberships },
      branchId,
    });
  }

  if (unconfirmedTomorrow > 0) {
    drafts.push({
      type: 'UNCONFIRMED_APPOINTMENTS',
      title: `${unconfirmedTomorrow} appointments tomorrow are unconfirmed`,
      body: 'Confirm them today to reduce no-shows.',
      severity: unconfirmedTomorrow > 5 ? 'WARNING' : 'INFO',
      data: { count: unconfirmedTomorrow },
      branchId,
    });
  }

  const lowStockItems = lowStock.filter((s) => d(s.quantity).lessThanOrEqualTo(s.product.reorderLevel));
  if (lowStockItems.length > 0) {
    drafts.push({
      type: 'LOW_STOCK',
      title: `${lowStockItems.length} products are low in stock`,
      body: lowStockItems
        .slice(0, 5)
        .map((s) => `${s.product.name} (${s.quantity.toString()} left)`)
        .join(', '),
      severity: lowStockItems.length > 5 ? 'WARNING' : 'INFO',
      data: { count: lowStockItems.length, products: lowStockItems.slice(0, 10).map((s) => s.productId) },
      branchId,
    });
  }

  const outstanding = outstandingAgg._sum.dueAmount ?? d(0);
  if (outstanding.greaterThan(0)) {
    drafts.push({
      type: 'OUTSTANDING_PAYMENTS',
      title: `${formatINR(outstanding)} outstanding`,
      body: `Across ${outstandingAgg._count._all} unpaid invoices.`,
      severity: outstanding.greaterThan(20000) ? 'WARNING' : 'INFO',
      data: { amount: outstanding.toString(), invoices: outstandingAgg._count._all },
      branchId,
    });
  }

  if (expiringPackages > 0) {
    drafts.push({
      type: 'PACKAGES_EXPIRING',
      title: `${expiringPackages} packages expire within 15 days`,
      body: 'Customers with unused sessions are the easiest bookings to make.',
      severity: 'INFO',
      data: { count: expiringPackages },
      branchId,
    });
  }

  if (unresolvedComplaints > 0) {
    drafts.push({
      type: 'UNRESOLVED_COMPLAINTS',
      title: `${unresolvedComplaints} unresolved complaints`,
      body: 'Low ratings left unanswered turn into public reviews.',
      severity: 'CRITICAL',
      data: { count: unresolvedComplaints },
      branchId,
    });
  }

  // Underutilised stylists: less than 40% of the team's average booked minutes.
  const workload = idleStaff.map((s) => ({
    id: s.id,
    name: s.displayName,
    minutes: s.appointmentServices.reduce((acc, a) => acc + a.durationMin, 0),
  }));
  const averageMinutes = workload.length
    ? workload.reduce((acc, w) => acc + w.minutes, 0) / workload.length
    : 0;
  const under = workload.filter((w) => averageMinutes > 60 && w.minutes < averageMinutes * 0.4);

  for (const staff of under.slice(0, 3)) {
    drafts.push({
      type: `STAFF_UNDERUTILISED_${staff.id}`,
      title: `${staff.name} is underutilised`,
      body: `Booked for ${Math.round(staff.minutes / 60)}h in the last 7 days against a team average of ${Math.round(averageMinutes / 60)}h.`,
      severity: 'INFO',
      data: { staffId: staff.id, minutes: staff.minutes, averageMinutes },
      branchId,
    });
  }

  let created = 0;
  for (const draft of drafts) {
    const existing = await prisma.businessAlert.findFirst({
      where: { tenantId, branchId: draft.branchId ?? null, type: draft.type, forDate: today },
    });

    if (existing) {
      await prisma.businessAlert.update({
        where: { id: existing.id },
        data: { title: draft.title, body: draft.body, severity: draft.severity, data: (draft.data ?? {}) as Prisma.InputJsonValue },
      });
      continue;
    }

    await prisma.businessAlert
      .create({
        data: {
          tenantId,
          branchId: draft.branchId ?? null,
          type: draft.type,
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          data: (draft.data ?? {}) as Prisma.InputJsonValue,
          forDate: today,
        },
      })
      .then(() => {
        created += 1;
      })
      .catch((err: unknown) => logger.warn({ err, type: draft.type }, 'alert creation failed'));
  }

  return { generated: drafts.length, created };
}

export async function listAlerts(input: { branchId?: string; unreadOnly?: boolean; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.BusinessAlertWhereInput = {
    tenantId,
    ...optionalBranchFilter(input.branchId),
    isDismissed: false,
    ...(input.unreadOnly ? { isRead: false } : {}),
    forDate: { gte: dateOnly(addDays(new Date(), -7)) },
  };

  const [items, total, unread] = await Promise.all([
    prisma.businessAlert.findMany({ where, skip, take, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }] }),
    prisma.businessAlert.count({ where }),
    prisma.businessAlert.count({ where: { ...where, isRead: false } }),
  ]);

  return { items, total, page, pageSize, unread };
}

export async function markAlertRead(id: string) {
  return prisma.businessAlert.update({ where: { id }, data: { isRead: true } });
}

export async function dismissAlert(id: string) {
  return prisma.businessAlert.update({ where: { id }, data: { isDismissed: true, isRead: true } });
}

/** Nightly sweep across every active tenant. */
export async function generateAlertsForAllTenants() {
  const tenants = await runUnscoped(() =>
    prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true } }),
  );

  let total = 0;
  for (const tenant of tenants) {
    const result = await runUnscoped(() => generateAlerts(tenant.id)).catch((err: unknown) => {
      logger.warn({ err, tenantId: tenant.id }, 'alert generation failed');
      return { generated: 0, created: 0 };
    });
    total += result.created;
  }

  return { tenants: tenants.length, alerts: total };
}

/** Cash and appointment snapshot used by the mobile "day view". */
export async function daySnapshot(branchId?: string) {
  const tenantId = requireTenantId();
  const branch = branchFilter(branchId);
  const from = startOfDay(new Date());
  const to = endOfDay(new Date());

  const [revenue, appointments, collections, alerts] = await Promise.all([
    prisma.invoice.aggregate({
      where: { tenantId, ...branch, invoiceDate: { gte: from, lte: to }, status: { not: 'VOID' } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    }),
    prisma.appointment.groupBy({
      by: ['status'],
      where: { tenantId, ...branch, startAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ['mode'],
      where: { tenantId, ...branch, receivedAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.businessAlert.count({ where: { tenantId, isRead: false, isDismissed: false, forDate: dateOnly(new Date()) } }),
  ]);

  return {
    date: dayjs().format('YYYY-MM-DD'),
    revenue: revenue._sum.grandTotal ?? d(0),
    invoices: revenue._count._all,
    appointments: Object.fromEntries(appointments.map((a) => [a.status, a._count._all])),
    collections: collections.map((c) => ({ mode: c.mode, amount: c._sum.amount ?? d(0) })),
    totalCollected: collections.reduce<Prisma.Decimal>((acc, c) => add(acc, c._sum.amount ?? 0), d(0)),
    unreadAlerts: alerts,
  };
}
