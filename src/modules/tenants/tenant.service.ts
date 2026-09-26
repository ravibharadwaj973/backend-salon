import type { Prisma, TenantStatus } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { addMonths, dayjs } from '../../core/dates';
import { pageParams } from '../../core/http';
import { invalidateAllIdentities } from '../../middleware/auth';
import { enquiryStats } from './enquiry.service';

export async function listTenants(input: { page?: number; pageSize?: number; q?: string; status?: TenantStatus }) {
  const { skip, take, page, pageSize } = pageParams(input);
  const where: Prisma.TenantWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { slug: { contains: input.q, mode: 'insensitive' as const } },
            { email: { contains: input.q, mode: 'insensitive' as const } },
            { phone: { contains: input.q } },
          ],
        }
      : {}),
  };

  const [items, total] = await runUnscoped(() =>
    Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          plan: { select: { name: true, code: true } },
          _count: { select: { branches: true, users: true, customers: true } },
        },
      }),
      prisma.tenant.count({ where }),
    ]),
  );

  return { items, total, page, pageSize };
}

export async function getTenant(tenantId: string) {
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        plan: true,
        subscriptions: { where: { isActive: true }, orderBy: { startedAt: 'desc' }, take: 1 },
        _count: { select: { branches: true, users: true, customers: true, appointments: true, invoices: true } },
      },
    }),
  );
  if (!tenant) throw NotFound('Tenant');
  return tenant;
}

/**
 * What the console needs to answer "how is this salon actually doing?" without
 * opening their account.
 *
 * Deliberately aggregate. An operator gets the shape of the business — size,
 * activity, what they are using, whether they are still turning up — and not
 * the contents: no customer names, no phone numbers, no bill lines. Support
 * questions are answered by these numbers; nothing here needs a real person's
 * details, so it does not have them.
 */
export async function tenantOverview(tenantId: string) {
  const tenant = await getTenant(tenantId);
  const thirtyDaysAgo = dayjs().subtract(30, 'day').toDate();
  const monthStart = dayjs().startOf('month').toDate();

  const [branches, staff, appointments30, invoices30, revenue30, lastAppointment, lastInvoice, lastLogin, messages30, usage] =
    await runUnscoped(() =>
      Promise.all([
        prisma.branch.findMany({
          where: { tenantId },
          select: { id: true, name: true, city: true, isActive: true, _count: { select: { staff: true, appointments: true } } },
          orderBy: { name: 'asc' },
        }),
        prisma.staff.count({ where: { tenantId, isActive: true } }),
        prisma.appointment.count({ where: { tenantId, startAt: { gte: thirtyDaysAgo } } }),
        prisma.invoice.count({ where: { tenantId, invoiceDate: { gte: thirtyDaysAgo }, status: { not: 'VOID' } } }),
        prisma.invoice.aggregate({
          where: { tenantId, invoiceDate: { gte: thirtyDaysAgo }, status: { not: 'VOID' } },
          _sum: { grandTotal: true },
        }),
        prisma.appointment.findFirst({ where: { tenantId }, orderBy: { startAt: 'desc' }, select: { startAt: true } }),
        prisma.invoice.findFirst({ where: { tenantId }, orderBy: { invoiceDate: 'desc' }, select: { invoiceDate: true } }),
        prisma.user.findFirst({
          where: { tenantId, lastLoginAt: { not: null } },
          orderBy: { lastLoginAt: 'desc' },
          select: { lastLoginAt: true, name: true, role: true },
        }),
        prisma.messageLog.groupBy({
          by: ['channel'],
          where: { tenantId, queuedAt: { gte: thirtyDaysAgo } },
          _count: { _all: true },
        }),
        prisma.messageUsage.findMany({
          where: { tenantId, periodStart: { gte: monthStart } },
          select: { meter: true, included: true, used: true, blocked: true },
        }),
      ]),
    );

  return {
    tenant,
    branches,
    /** Is anyone actually using it? The question behind most support calls. */
    activity: {
      staff,
      appointments30,
      invoices30,
      revenue30: revenue30._sum.grandTotal ?? 0,
      lastAppointmentAt: lastAppointment?.startAt ?? null,
      lastInvoiceAt: lastInvoice?.invoiceDate ?? null,
      lastLoginAt: lastLogin?.lastLoginAt ?? null,
      lastLoginBy: lastLogin ? { name: lastLogin.name, role: lastLogin.role } : null,
    },
    messages30: Object.fromEntries(messages30.map((row) => [row.channel, row._count._all])),
    usage,
  };
}

export async function updateTenant(tenantId: string, data: Record<string, unknown>) {
  const { settings, ...rest } = data as { settings?: Record<string, unknown>; websiteUrl?: string };
  const current = await runUnscoped(() => prisma.tenant.findUnique({ where: { id: tenantId } }));
  if (!current) throw NotFound('Tenant');

  /**
   * An empty website field means "I do not have one", which has to reach the
   * column as NULL rather than as "". An empty string would build
   * {{gallery_link}} as "/gallery" with no host in front of it — a link that
   * resolves against whatever mail client the customer happens to be reading
   * in, which is nowhere.
   */
  if ('websiteUrl' in rest) {
    (rest as { websiteUrl?: string | null }).websiteUrl = rest.websiteUrl?.trim()
      ? rest.websiteUrl.trim().replace(/\/+$/, '')
      : null;
  }

  return runUnscoped(() =>
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(rest as Prisma.TenantUpdateInput),
        ...(settings
          ? {
              settings: {
                ...((current.settings as Record<string, unknown>) ?? {}),
                ...settings,
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    }),
  );
}

export async function setTenantStatus(tenantId: string, status: TenantStatus) {
  const tenant = await runUnscoped(() => prisma.tenant.update({ where: { id: tenantId }, data: { status } }));
  // Suspension must bite immediately, so drop cached identities.
  invalidateAllIdentities();
  return tenant;
}

/**
 * Records a salon's subscription after you have been paid off-platform (bank
 * transfer, UPI, cheque). No gateway is involved here either: the platform
 * operator enters what was collected and for how long.
 */
export async function assignPlan(tenantId: string, planCode: string, months: number, amount?: number) {
  const plan = await runUnscoped(() => prisma.plan.findUnique({ where: { code: planCode } }));
  if (!plan) throw NotFound('Plan');

  const price = amount ?? Number(plan.pricePerMonth) * months;

  return runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId, isActive: true },
        data: { isActive: false, cancelledAt: new Date() },
      });

      const subscription = await tx.tenantSubscription.create({
        data: {
          tenantId,
          planCode,
          amount: price,
          currentPeriodEnd: addMonths(new Date(), months),
        },
      });

      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: { planId: plan.id, status: 'ACTIVE' },
      });

      return { subscription, tenant };
    }),
  );
}

// ------------------------------------------------------------------ plans --

export async function listPlans(activeOnly = false) {
  return runUnscoped(() =>
    prisma.plan.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { pricePerMonth: 'asc' },
      include: { _count: { select: { tenants: true } } },
    }),
  );
}

export interface PlanInput {
  code: string;
  name: string;
  pricePerMonth: number;
  pricePerYear?: number;
  maxBranches?: number;
  maxStaff?: number;
  maxCustomers?: number;
  waUtilityQuota?: number;
  waMarketingQuota?: number;
  waAuthQuota?: number;
  smsQuota?: number;
  emailQuota?: number;
  maxCampaignsPerMonth?: number;
  extraBranchPrice?: number | null;
  features?: Record<string, unknown>;
  isActive?: boolean;
}

export async function createPlan(input: PlanInput) {
  const existing = await runUnscoped(() => prisma.plan.findUnique({ where: { code: input.code } }));
  if (existing) throw Conflict(`A plan with code "${input.code}" already exists`);

  const { features, ...rest } = input;
  return runUnscoped(() =>
    prisma.plan.create({
      data: { ...rest, features: (features ?? {}) as Prisma.InputJsonValue },
    }),
  );
}

export async function updatePlan(id: string, input: Partial<PlanInput>) {
  const plan = await runUnscoped(() => prisma.plan.findUnique({ where: { id } }));
  if (!plan) throw NotFound('Plan');

  const { features, ...rest } = input;
  return runUnscoped(() =>
    prisma.plan.update({
      where: { id },
      data: {
        ...(rest as Prisma.PlanUpdateInput),
        ...(features ? { features: features as Prisma.InputJsonValue } : {}),
      },
    }),
  );
}

/**
 * Remove a plan from the catalogue.
 *
 * Deleting is for a plan that was a mistake — a typo, a draft, a tier that
 * never sold. Withdrawing one that salons are actually on is a different
 * operation entirely, and the answer there is to retire it (isActive: false),
 * which keeps every existing salon exactly as it is and only stops the plan
 * being assigned to anyone new. So this refuses rather than cascading: a
 * deleted plan would leave those salons with no limits, no quotas and no
 * features, which reads to them as the product breaking.
 *
 * Credit packs restricted to this plan are not deleted. They lose the
 * restriction and become available to everyone, which is the safe direction —
 * the alternative is silently destroying something a salon may have bought.
 */
export async function deletePlan(id: string) {
  const plan = await runUnscoped(() =>
    prisma.plan.findUnique({ where: { id }, include: { _count: { select: { tenants: true, packs: true } } } }),
  );
  if (!plan) throw NotFound('Plan');

  if (plan._count.tenants > 0) {
    const salons = `${plan._count.tenants} salon${plan._count.tenants === 1 ? ' is' : 's are'}`;
    throw Conflict(
      `${salons} on "${plan.name}", so it cannot be deleted. Retire it instead — existing salons keep it and ` +
        'it stops being offered to anyone new.',
      { tenants: plan._count.tenants, planId: plan.id, suggestion: 'retire' },
    );
  }

  const released = plan._count.packs;
  await runUnscoped(() => prisma.plan.delete({ where: { id } }));

  return { deleted: true, name: plan.name, code: plan.code, packsReleased: released };
}

export async function platformStats() {
  const [tenants, byStatus, branches, customers, invoiceAgg] = await runUnscoped(() =>
    Promise.all([
      prisma.tenant.count(),
      prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.branch.count(),
      prisma.customer.count(),
      prisma.invoice.aggregate({ _sum: { grandTotal: true }, where: { status: { in: ['PAID', 'PARTIALLY_PAID'] } } }),
    ]),
  );

  return {
    tenants,
    tenantsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    branches,
    customers,
    grossTransactionValue: invoiceAgg._sum.grandTotal ?? 0,
    // Salons that have asked to hear from you but are not salons yet. It belongs
    // beside the platform counts because an unanswered enquiry is the one number
    // on this page that costs money while you look at it.
    enquiries: await enquiryStats(),
  };
}

// ---------------------------------------------------------------- settings --

export async function getSettings(tenantId: string, branchId?: string) {
  const rows = await prisma.setting.findMany({
    where: { tenantId, branchId: branchId ?? null },
    orderBy: { key: 'asc' },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });

  return {
    core: (tenant?.settings as Record<string, unknown>) ?? {},
    overrides: Object.fromEntries(rows.map((r) => [r.key, r.value])),
  };
}

export async function upsertSetting(tenantId: string, key: string, value: unknown, branchId?: string) {
  // Prisma types nullable columns in compound unique inputs as non-null, so the
  // tenant-level row (branchId = null) is looked up with findFirst instead.
  const existing = await prisma.setting.findFirst({ where: { tenantId, branchId: branchId ?? null, key } });
  if (existing) {
    return prisma.setting.update({ where: { id: existing.id }, data: { value: value as Prisma.InputJsonValue } });
  }
  return prisma.setting.create({
    data: { tenantId, branchId: branchId ?? null, key, value: value as Prisma.InputJsonValue },
  });
}

/** Read one tenant setting with a fallback, honouring branch overrides. */
export async function settingValue<T>(
  tenantId: string,
  key: string,
  fallback: T,
  branchId?: string | null,
): Promise<T> {
  if (branchId) {
    const branchLevel = await prisma.setting.findFirst({ where: { tenantId, branchId, key } });
    if (branchLevel) return branchLevel.value as T;
  }
  const tenantLevel = await prisma.setting.findFirst({ where: { tenantId, branchId: null, key } });
  if (tenantLevel) return tenantLevel.value as T;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const core = (tenant?.settings as Record<string, unknown>) ?? {};
  return (core[key] as T) ?? fallback;
}
