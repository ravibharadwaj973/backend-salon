import type { CommissionType, Gender, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { assertBranchAccess, branchFilter, requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, div, pctOf, round2 } from '../../core/money';
import { resolveRange, timeToMinutes } from '../../core/dates';

export interface StaffInput {
  branchId: string;
  userId?: string;
  code?: string;
  displayName: string;
  designation?: string;
  phone?: string;
  email?: string;
  gender?: Gender;
  dob?: Date;
  joinedAt?: Date;
  exitedAt?: Date;
  specialities?: string[];
  isBookable?: boolean;
  isActive?: boolean;
  colorHex?: string;
  avatarUrl?: string;
  baseSalary?: number;
  commissionType?: CommissionType;
  commissionRate?: number;
  serviceIds?: string[];
}

export async function listStaff(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  branchId?: string;
  isActive?: string;
  isBookable?: string;
  serviceId?: string;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.StaffWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.isActive ? { isActive: input.isActive === 'true' } : {}),
    ...(input.isBookable ? { isBookable: input.isBookable === 'true' } : {}),
    ...(input.serviceId ? { services: { some: { serviceId: input.serviceId } } } : {}),
    ...(input.q
      ? {
          OR: [
            { displayName: { contains: input.q, mode: 'insensitive' as const } },
            { code: { contains: input.q, mode: 'insensitive' as const } },
            { phone: { contains: input.q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.staff.findMany({
      where,
      skip,
      take,
      orderBy: { displayName: 'asc' },
      include: {
        branch: { select: { id: true, name: true } },
        user: { select: { id: true, email: true, role: true } },
        _count: { select: { services: true } },
      },
    }),
    prisma.staff.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getStaff(id: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, name: true } },
      user: { select: { id: true, email: true, role: true, isActive: true } },
      services: { include: { service: { select: { id: true, name: true, price: true, durationMin: true } } } },
      availability: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      timeOff: { where: { endAt: { gte: new Date() } }, orderBy: { startAt: 'asc' } },
    },
  });
  if (!staff) throw NotFound('Staff member');
  return staff;
}

export async function createStaff(input: StaffInput) {
  const tenantId = requireTenantId();
  assertBranchAccess(input.branchId);

  if (input.code) {
    const clash = await prisma.staff.findFirst({ where: { tenantId, code: input.code } });
    if (clash) throw Conflict(`Staff code "${input.code}" is already used`);
  }
  if (input.userId) {
    const linked = await prisma.staff.findUnique({ where: { userId: input.userId } });
    if (linked) throw Conflict('This login is already linked to another staff profile');
  }

  const { serviceIds, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    const staff = await tx.staff.create({ data: { tenantId, ...rest } });

    if (serviceIds?.length) {
      await tx.staffService.createMany({
        data: serviceIds.map((serviceId) => ({ tenantId, staffId: staff.id, serviceId })),
        skipDuplicates: true,
      });
    }

    // A sensible default week: Tue–Sun, 10:00–20:00, Monday off.
    await tx.staffAvailability.createMany({
      data: [0, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        tenantId,
        staffId: staff.id,
        dayOfWeek,
        startTime: '10:00',
        endTime: '20:00',
      })),
      skipDuplicates: true,
    });

    return staff;
  });
}

export async function updateStaff(id: string, input: Partial<StaffInput>) {
  const staff = await prisma.staff.findUnique({ where: { id } });
  if (!staff) throw NotFound('Staff member');
  assertBranchAccess(staff.branchId);
  if (input.branchId) assertBranchAccess(input.branchId);

  const { serviceIds, ...rest } = input;

  if (serviceIds) await setStaffServices(id, serviceIds.map((serviceId) => ({ serviceId })));

  return prisma.staff.update({ where: { id }, data: rest });
}

export async function deactivateStaff(id: string) {
  const staff = await prisma.staff.findUnique({ where: { id } });
  if (!staff) throw NotFound('Staff member');
  assertBranchAccess(staff.branchId);

  const upcoming = await prisma.appointmentService.count({
    where: { staffId: id, startAt: { gte: new Date() }, appointment: { status: { in: ['BOOKED', 'CONFIRMED'] } } },
  });
  if (upcoming > 0) {
    throw Conflict(`${upcoming} upcoming appointments are assigned to this person. Reassign them first.`);
  }

  return prisma.staff.update({ where: { id }, data: { isActive: false, isBookable: false, exitedAt: new Date() } });
}

export async function setStaffServices(
  staffId: string,
  services: { serviceId: string; priceOverride?: number; durationOverrideMin?: number }[],
) {
  const tenantId = requireTenantId();
  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw NotFound('Staff member');

  await prisma.$transaction([
    prisma.staffService.deleteMany({ where: { staffId } }),
    ...(services.length
      ? [
          prisma.staffService.createMany({
            data: services.map((s) => ({
              tenantId,
              staffId,
              serviceId: s.serviceId,
              priceOverride: s.priceOverride ?? null,
              durationOverrideMin: s.durationOverrideMin ?? null,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);

  return prisma.staffService.findMany({
    where: { staffId },
    include: { service: { select: { id: true, name: true, price: true, durationMin: true } } },
  });
}

export async function setAvailability(staffId: string, slots: { dayOfWeek: number; startTime: string; endTime: string }[]) {
  const tenantId = requireTenantId();
  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw NotFound('Staff member');

  for (const slot of slots) {
    if (timeToMinutes(slot.endTime) <= timeToMinutes(slot.startTime)) {
      throw BadRequest(`Availability end time must be after start time (day ${slot.dayOfWeek})`);
    }
  }

  await prisma.$transaction([
    prisma.staffAvailability.deleteMany({ where: { staffId } }),
    ...(slots.length
      ? [prisma.staffAvailability.createMany({ data: slots.map((s) => ({ tenantId, staffId, ...s })) })]
      : []),
  ]);

  return prisma.staffAvailability.findMany({
    where: { staffId },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
}

export async function addTimeOff(staffId: string, input: { startAt: Date; endAt: Date; reason?: string }) {
  const tenantId = requireTenantId();
  if (input.endAt <= input.startAt) throw BadRequest('Time off must end after it starts');

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw NotFound('Staff member');

  const clashing = await prisma.appointmentService.count({
    where: {
      staffId,
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
      appointment: { status: { in: ['BOOKED', 'CONFIRMED'] } },
    },
  });
  if (clashing > 0) {
    throw Conflict(`${clashing} booked appointments fall inside this time off. Reassign or cancel them first.`);
  }

  return prisma.staffTimeOff.create({ data: { tenantId, staffId, ...input } });
}

export async function removeTimeOff(id: string) {
  const record = await prisma.staffTimeOff.findUnique({ where: { id } });
  if (!record) throw NotFound('Time off');
  return prisma.staffTimeOff.delete({ where: { id } });
}

/**
 * The staff scorecard: revenue, retention, commission and target achievement.
 */
export async function staffPerformance(staffId: string, from?: Date, to?: Date) {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { branch: { select: { id: true, name: true } } },
  });
  if (!staff) throw NotFound('Staff member');
  assertBranchAccess(staff.branchId);

  const range = resolveRange(from, to);

  const [revenueAgg, appointments, uniqueCustomers, commissionAgg, target, ratings] = await Promise.all([
    prisma.invoiceItem.aggregate({
      where: {
        staffId,
        invoice: { invoiceDate: { gte: range.from, lte: range.to }, status: { not: 'VOID' } },
      },
      _sum: { lineTotal: true },
      _count: { _all: true },
    }),
    prisma.appointmentService.count({
      where: { staffId, startAt: { gte: range.from, lte: range.to }, appointment: { status: 'COMPLETED' } },
    }),
    prisma.appointment.findMany({
      where: {
        services: { some: { staffId } },
        startAt: { gte: range.from, lte: range.to },
        status: 'COMPLETED',
        customerId: { not: null },
      },
      select: { customerId: true },
      distinct: ['customerId'],
    }),
    prisma.commissionEntry.aggregate({
      where: { staffId, earnedOn: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    }),
    prisma.staffTarget.findFirst({
      where: {
        staffId,
        periodMonth: range.from.getMonth() + 1,
        periodYear: range.from.getFullYear(),
      },
    }),
    prisma.feedback.aggregate({
      where: { staffId, createdAt: { gte: range.from, lte: range.to } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  const revenue = revenueAgg._sum.lineTotal ?? 0;
  const serviceCount = revenueAgg._count._all;
  const customerIds = uniqueCustomers.map((a) => a.customerId).filter((id): id is string => Boolean(id));

  // Retention: of the customers this stylist served in the window, how many have
  // been back to the salon since their visit with them.
  const repeatCount = customerIds.length
    ? await prisma.customer.count({
        where: { id: { in: customerIds }, totalVisits: { gt: 1 } },
      })
    : 0;

  return {
    staff: { id: staff.id, name: staff.displayName, branch: staff.branch, avatarUrl: staff.avatarUrl },
    period: range,
    revenue,
    servicesBilled: serviceCount,
    appointments,
    uniqueCustomers: customerIds.length,
    averageBill: serviceCount > 0 ? round2(div(revenue, serviceCount)) : 0,
    retentionPct: pctOf(repeatCount, customerIds.length || 1),
    commission: commissionAgg._sum.amount ?? 0,
    target: target?.revenueTarget ?? null,
    achievementPct: target ? pctOf(revenue, target.revenueTarget) : null,
    averageRating: ratings._avg.rating ?? 0,
    ratingCount: ratings._count._all,
  };
}

/** Leaderboard across the branch or tenant. */
export async function staffLeaderboard(input: { from?: Date; to?: Date; branchId?: string; limit?: number }) {
  const tenantId = requireTenantId();
  const range = resolveRange(input.from, input.to);
  const branch = branchFilter(input.branchId);

  const staffList = await prisma.staff.findMany({
    where: { tenantId, isActive: true, ...branch },
    select: { id: true, displayName: true, branchId: true, avatarUrl: true, avgRating: true },
  });
  if (!staffList.length) return [];

  const grouped = await prisma.invoiceItem.groupBy({
    by: ['staffId'],
    where: {
      staffId: { in: staffList.map((s) => s.id) },
      invoice: { invoiceDate: { gte: range.from, lte: range.to }, status: { not: 'VOID' } },
    },
    _sum: { lineTotal: true },
    _count: { _all: true },
  });

  const byStaff = new Map(grouped.map((g) => [g.staffId, g]));
  const totalRevenue = grouped.reduce((acc, g) => add(acc, g._sum.lineTotal ?? 0), round2(0));

  return staffList
    .map((s) => {
      const stats = byStaff.get(s.id);
      const revenue = stats?._sum.lineTotal ?? 0;
      const count = stats?._count._all ?? 0;
      return {
        staffId: s.id,
        name: s.displayName,
        branchId: s.branchId,
        avatarUrl: s.avatarUrl,
        rating: s.avgRating,
        revenue,
        servicesBilled: count,
        averageBill: count > 0 ? round2(div(revenue, count)) : 0,
        shareOfRevenuePct: pctOf(revenue, totalRevenue),
      };
    })
    .sort((a, b) => Number(b.revenue) - Number(a.revenue))
    .slice(0, input.limit ?? 20);
}

/** Staff bookable for a service at a branch — used by the booking flow. */
export async function bookableStaff(branchId: string, serviceId?: string) {
  const tenantId = requireTenantId();
  requireBranchId(branchId);

  return prisma.staff.findMany({
    where: {
      tenantId,
      branchId,
      isActive: true,
      isBookable: true,
      ...(serviceId ? { services: { some: { serviceId } } } : {}),
    },
    select: {
      id: true,
      displayName: true,
      designation: true,
      avatarUrl: true,
      colorHex: true,
      avgRating: true,
      specialities: true,
    },
    orderBy: { displayName: 'asc' },
  });
}
