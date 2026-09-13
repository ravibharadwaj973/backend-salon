import type { AttendanceStatus, LeaveStatus, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { assertBranchAccess, branchFilter, requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, round2, sub } from '../../core/money';
import { dateOnly, diffMinutes, endOfMonth, startOfMonth } from '../../core/dates';

// ---------------------------------------------------------- attendance -----

export async function markAttendance(input: {
  staffId: string;
  date: Date;
  status?: AttendanceStatus;
  checkIn?: Date;
  checkOut?: Date;
  notes?: string;
}) {
  const tenantId = requireTenantId();
  const staff = await prisma.staff.findUnique({ where: { id: input.staffId } });
  if (!staff) throw NotFound('Staff member');
  assertBranchAccess(staff.branchId);

  const date = dateOnly(input.date);
  const workedMinutes =
    input.checkIn && input.checkOut ? Math.max(0, diffMinutes(input.checkOut, input.checkIn)) : 0;

  const existing = await prisma.attendance.findFirst({ where: { staffId: input.staffId, date } });

  const data = {
    status: input.status ?? 'PRESENT',
    checkIn: input.checkIn ?? null,
    checkOut: input.checkOut ?? null,
    workedMinutes,
    notes: input.notes ?? null,
  };

  if (existing) return prisma.attendance.update({ where: { id: existing.id }, data });

  return prisma.attendance.create({
    data: { tenantId, branchId: staff.branchId, staffId: input.staffId, date, ...data },
  });
}

/** Self-service punch in/out for a staff member. */
export async function punch(staffId: string, direction: 'IN' | 'OUT') {
  const tenantId = requireTenantId();
  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw NotFound('Staff member');

  const date = dateOnly(new Date());
  const existing = await prisma.attendance.findFirst({ where: { staffId, date } });

  if (direction === 'IN') {
    if (existing?.checkIn) throw Conflict('Already checked in today');
    if (existing) {
      return prisma.attendance.update({
        where: { id: existing.id },
        data: { checkIn: new Date(), status: 'PRESENT' },
      });
    }
    return prisma.attendance.create({
      data: { tenantId, branchId: staff.branchId, staffId, date, status: 'PRESENT', checkIn: new Date() },
    });
  }

  if (!existing?.checkIn) throw BadRequest('You have not checked in today');
  const checkOut = new Date();
  return prisma.attendance.update({
    where: { id: existing.id },
    data: { checkOut, workedMinutes: Math.max(0, diffMinutes(checkOut, existing.checkIn)) },
  });
}

export async function listAttendance(input: {
  from?: Date;
  to?: Date;
  staffId?: string;
  branchId?: string;
  page?: number;
  pageSize?: number;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.AttendanceWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.from || input.to
      ? {
          date: {
            ...(input.from ? { gte: dateOnly(input.from) } : {}),
            ...(input.to ? { lte: dateOnly(input.to) } : {}),
          },
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.attendance.findMany({
      where,
      skip,
      take,
      orderBy: [{ date: 'desc' }, { staffId: 'asc' }],
      include: { staff: { select: { id: true, displayName: true } } },
    }),
    prisma.attendance.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function attendanceSummary(input: { month: number; year: number; branchId?: string }) {
  const tenantId = requireTenantId();
  const from = dateOnly(new Date(Date.UTC(input.year, input.month - 1, 1)));
  const to = dateOnly(endOfMonth(new Date(Date.UTC(input.year, input.month - 1, 1))));

  const rows = await prisma.attendance.groupBy({
    by: ['staffId', 'status'],
    where: { tenantId, ...branchFilter(input.branchId), date: { gte: from, lte: to } },
    _count: { _all: true },
    _sum: { workedMinutes: true },
  });

  const staffIds = [...new Set(rows.map((r) => r.staffId))];
  const staff = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(staff.map((s) => [s.id, s.displayName]));

  interface AttendanceSummaryRow {
    staffId: string;
    name: string;
    workedMinutes: number;
    counts: Record<AttendanceStatus, number>;
  }

  const summary = new Map<string, AttendanceSummaryRow>();
  for (const row of rows) {
    const entry: AttendanceSummaryRow = summary.get(row.staffId) ?? {
      staffId: row.staffId,
      name: nameById.get(row.staffId) ?? 'Unknown',
      workedMinutes: 0,
      counts: { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, LEAVE: 0, WEEKLY_OFF: 0, HOLIDAY: 0 },
    };
    entry.counts[row.status] = row._count._all;
    entry.workedMinutes += row._sum.workedMinutes ?? 0;
    summary.set(row.staffId, entry);
  }

  return [...summary.values()];
}

// -------------------------------------------------------------- leave ------

export async function requestLeave(input: { staffId: string; fromDate: Date; toDate: Date; reason?: string }) {
  const tenantId = requireTenantId();
  if (input.toDate < input.fromDate) throw BadRequest('Leave end date cannot be before the start date');

  const staff = await prisma.staff.findUnique({ where: { id: input.staffId } });
  if (!staff) throw NotFound('Staff member');

  return prisma.leaveRequest.create({
    data: {
      tenantId,
      staffId: input.staffId,
      fromDate: dateOnly(input.fromDate),
      toDate: dateOnly(input.toDate),
      reason: input.reason ?? null,
    },
  });
}

export async function decideLeave(id: string, status: LeaveStatus, approvedById: string | null) {
  const request = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!request) throw NotFound('Leave request');
  if (request.status !== 'PENDING') throw Conflict('This request has already been decided');

  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: { status, approvedById, decidedAt: new Date() },
  });

  // Approved leave blocks the calendar for those days.
  if (status === 'APPROVED') {
    await prisma.staffTimeOff.create({
      data: {
        tenantId: request.tenantId,
        staffId: request.staffId,
        startAt: request.fromDate,
        endAt: new Date(request.toDate.getTime() + 24 * 60 * 60 * 1000 - 1),
        reason: request.reason ?? 'Approved leave',
      },
    });
  }

  return updated;
}

export async function listLeaveRequests(input: { staffId?: string; status?: LeaveStatus; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.LeaveRequestWhereInput = {
    tenantId,
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.leaveRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { staff: { select: { id: true, displayName: true, branchId: true } } },
    }),
    prisma.leaveRequest.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

// ------------------------------------------------------------ targets ------

export async function setTarget(input: {
  staffId: string;
  periodMonth: number;
  periodYear: number;
  revenueTarget: number;
  serviceCountTarget?: number;
}) {
  const tenantId = requireTenantId();
  const existing = await prisma.staffTarget.findFirst({
    where: { staffId: input.staffId, periodMonth: input.periodMonth, periodYear: input.periodYear },
  });

  if (existing) {
    return prisma.staffTarget.update({
      where: { id: existing.id },
      data: { revenueTarget: input.revenueTarget, serviceCountTarget: input.serviceCountTarget ?? 0 },
    });
  }

  return prisma.staffTarget.create({
    data: {
      tenantId,
      staffId: input.staffId,
      periodMonth: input.periodMonth,
      periodYear: input.periodYear,
      revenueTarget: input.revenueTarget,
      serviceCountTarget: input.serviceCountTarget ?? 0,
    },
  });
}

// -------------------------------------------------------- commissions ------

export async function listCommissions(input: {
  staffId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  isPaid?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.CommissionEntryWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.staffId ? { staffId: input.staffId } : {}),
    ...(input.isPaid !== undefined ? { isPaid: input.isPaid } : {}),
    ...(input.from || input.to
      ? { earnedOn: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  const [items, total, agg] = await Promise.all([
    prisma.commissionEntry.findMany({
      where,
      skip,
      take,
      orderBy: { earnedOn: 'desc' },
      include: {
        staff: { select: { id: true, displayName: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
    }),
    prisma.commissionEntry.count({ where }),
    prisma.commissionEntry.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, page, pageSize, totalAmount: agg._sum.amount ?? 0 };
}

export async function commissionSummary(input: { from?: Date; to?: Date; branchId?: string }) {
  const tenantId = requireTenantId();
  const grouped = await prisma.commissionEntry.groupBy({
    by: ['staffId'],
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      ...(input.from || input.to
        ? { earnedOn: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
        : {}),
    },
    _sum: { amount: true, baseAmount: true },
    _count: { _all: true },
  });

  const staff = await prisma.staff.findMany({
    where: { id: { in: grouped.map((g) => g.staffId) } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(staff.map((s) => [s.id, s.displayName]));

  return grouped
    .map((g) => ({
      staffId: g.staffId,
      name: nameById.get(g.staffId) ?? 'Unknown',
      entries: g._count._all,
      baseAmount: g._sum.baseAmount ?? 0,
      commission: g._sum.amount ?? 0,
    }))
    .sort((a, b) => Number(b.commission) - Number(a.commission));
}

export async function markCommissionsPaid(ids: string[], payrollId?: string) {
  const result = await prisma.commissionEntry.updateMany({
    where: { id: { in: ids }, isPaid: false },
    data: { isPaid: true, payrollId: payrollId ?? null },
  });
  return { updated: result.count };
}

// ------------------------------------------------------------ payroll ------

/**
 * Builds a payroll draft: base salary (pro-rated by attendance) plus unpaid
 * commission for the period, minus any deductions.
 */
export async function generatePayroll(input: {
  branchId: string;
  periodMonth: number;
  periodYear: number;
  incentives?: Record<string, number>;
  deductions?: Record<string, number>;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  const periodStart = startOfMonth(new Date(Date.UTC(input.periodYear, input.periodMonth - 1, 1)));
  const periodEnd = endOfMonth(periodStart);
  const daysInMonth = new Date(input.periodYear, input.periodMonth, 0).getDate();

  const existing = await prisma.payroll.findFirst({
    where: { tenantId, branchId, periodMonth: input.periodMonth, periodYear: input.periodYear },
  });
  if (existing && existing.status !== 'DRAFT') {
    throw Conflict('Payroll for this period has already been approved');
  }

  const staff = await prisma.staff.findMany({ where: { tenantId, branchId, isActive: true } });

  const items = await Promise.all(
    staff.map(async (member) => {
      const [attendanceRows, commissionAgg] = await Promise.all([
        prisma.attendance.groupBy({
          by: ['status'],
          where: { staffId: member.id, date: { gte: periodStart, lte: periodEnd } },
          _count: { _all: true },
        }),
        prisma.commissionEntry.aggregate({
          where: { staffId: member.id, earnedOn: { gte: periodStart, lte: periodEnd }, isPaid: false },
          _sum: { amount: true },
        }),
      ]);

      const present = attendanceRows.find((r) => r.status === 'PRESENT')?._count._all ?? 0;
      const half = attendanceRows.find((r) => r.status === 'HALF_DAY')?._count._all ?? 0;
      const paidLeave = attendanceRows.find((r) => r.status === 'LEAVE')?._count._all ?? 0;
      const weeklyOff = attendanceRows.find((r) => r.status === 'WEEKLY_OFF')?._count._all ?? 0;
      const holiday = attendanceRows.find((r) => r.status === 'HOLIDAY')?._count._all ?? 0;

      const payableDays = present + half * 0.5 + paidLeave + weeklyOff + holiday;
      // No attendance recorded at all: assume a full month rather than paying zero.
      const effectiveDays = attendanceRows.length === 0 ? daysInMonth : payableDays;

      const baseSalary = round2(d(member.baseSalary).times(effectiveDays).dividedBy(daysInMonth));
      const commission = commissionAgg._sum.amount ?? 0;
      const incentive = input.incentives?.[member.id] ?? 0;
      const deduction = input.deductions?.[member.id] ?? 0;
      const netPay = round2(sub(add(baseSalary, commission, incentive), deduction));

      return {
        tenantId,
        staffId: member.id,
        baseSalary,
        commission,
        incentive,
        deductions: deduction,
        netPay,
        daysPresent: present,
      };
    }),
  );

  const totalAmount = items.reduce((acc, i) => add(acc, i.netPay), round2(0));

  return prisma.$transaction(async (tx) => {
    if (existing) await tx.payrollItem.deleteMany({ where: { payrollId: existing.id } });

    const payroll = existing
      ? await tx.payroll.update({ where: { id: existing.id }, data: { totalAmount, generatedAt: new Date() } })
      : await tx.payroll.create({
          data: {
            tenantId,
            branchId,
            periodMonth: input.periodMonth,
            periodYear: input.periodYear,
            totalAmount,
          },
        });

    await tx.payrollItem.createMany({ data: items.map((i) => ({ ...i, payrollId: payroll.id })) });

    return tx.payroll.findUniqueOrThrow({
      where: { id: payroll.id },
      include: { items: { include: { staff: { select: { id: true, displayName: true } } } } },
    });
  });
}

export async function approvePayroll(id: string, markPaid: boolean) {
  const payroll = await prisma.payroll.findUnique({ where: { id }, include: { items: true } });
  if (!payroll) throw NotFound('Payroll');

  const periodStart = startOfMonth(new Date(Date.UTC(payroll.periodYear, payroll.periodMonth - 1, 1)));
  const periodEnd = endOfMonth(periodStart);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.payroll.update({
      where: { id },
      data: { status: markPaid ? 'PAID' : 'APPROVED', paidAt: markPaid ? new Date() : null },
    });

    if (markPaid) {
      await tx.commissionEntry.updateMany({
        where: {
          staffId: { in: payroll.items.map((i) => i.staffId) },
          earnedOn: { gte: periodStart, lte: periodEnd },
          isPaid: false,
        },
        data: { isPaid: true, payrollId: id },
      });
    }

    return updated;
  });
}

export async function listPayrolls(input: { branchId?: string; year?: number; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.PayrollWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.year ? { periodYear: input.year } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.payroll.findMany({
      where,
      skip,
      take,
      orderBy: [{ periodYear: 'desc' }, { periodMonth: 'desc' }],
      include: { _count: { select: { items: true } } },
    }),
    prisma.payroll.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getPayroll(id: string) {
  const payroll = await prisma.payroll.findUnique({
    where: { id },
    include: { items: { include: { staff: { select: { id: true, displayName: true, designation: true } } } } },
  });
  if (!payroll) throw NotFound('Payroll');
  return payroll;
}

// ------------------------------------------------- one person's own view ----

/** Every payslip this person has had, newest first. */
export async function listPayslips(staffId: string, input: { page?: number; pageSize?: number }) {
  const { skip, take, page, pageSize } = pageParams(input);
  const where: Prisma.PayrollItemWhereInput = { staffId };
  const [items, total] = await Promise.all([
    prisma.payrollItem.findMany({
      where,
      skip,
      take,
      orderBy: [{ payroll: { periodYear: 'desc' } }, { payroll: { periodMonth: 'desc' } }],
      include: { payroll: { select: { id: true, periodMonth: true, periodYear: true, status: true, paidAt: true } } },
    }),
    prisma.payrollItem.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/** Days and hours this person put in over a period — the "how much they worked" number. */
export async function attendanceTotals(staffId: string, from: Date, to: Date) {
  const rows = await prisma.attendance.findMany({
    where: { staffId, date: { gte: dateOnly(from), lte: dateOnly(to) } },
    select: { status: true, workedMinutes: true },
  });
  const present = rows.filter((r) => r.status === 'PRESENT' || r.status === 'HALF_DAY').length;
  const minutes = rows.reduce((sum, r) => sum + r.workedMinutes, 0);
  return {
    daysMarked: rows.length,
    daysPresent: present,
    daysAbsent: rows.filter((r) => r.status === 'ABSENT').length,
    onLeave: rows.filter((r) => r.status === 'LEAVE').length,
    hoursWorked: Math.round((minutes / 60) * 10) / 10,
  };
}
