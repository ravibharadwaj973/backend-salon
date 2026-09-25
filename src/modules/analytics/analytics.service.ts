import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { branchFilter, optionalBranchFilter } from '../../core/scope';
import { add, d, div, pctChange, pctOf, round2, sub } from '../../core/money';
import {
  addDays,
  dateKey,
  dayjs,
  endOfDay,
  endOfMonth,
  previousRange,
  resolveRange,
  startOfDay,
  startOfMonth,
  type DateRange,
} from '../../core/dates';

/**
 * The owner's command centre. One call returns the numbers that matter today,
 * each with the change against the equivalent previous period.
 */
/**
 * WHICH DAY THE DASHBOARD CAN ACTUALLY ANSWER FOR.
 *
 * A day before the salon existed has no takings, no appointments and no
 * customers — but asked for it, the dashboard renders zeros, and zeros are
 * indistinguishable from a terrible Tuesday. Somebody scrolling back through
 * the calendar would meet a wall of empty days with no way to tell "we took
 * nothing" from "we did not exist yet".
 *
 * Clamped rather than refused: a stale bookmark or a hand-typed URL is not
 * worth an error page. The caller is told it happened, so the screen can say
 * which day it answered for instead of quietly answering a different question.
 */
export function dayInRange(
  asked: Date,
  accountCreated: Date,
  now: Date = new Date(),
): { date: Date; clamped: boolean } {
  const floor = startOfDay(accountCreated);
  const day = startOfDay(asked);

  if (day < floor) return { date: floor, clamped: true };
  // A day that has not happened cannot have takings. "Today" rather than the
  // start of today, so the rest of the call keeps its time-of-day precision.
  if (day > startOfDay(now)) return { date: now, clamped: true };
  return { date: asked, clamped: false };
}

export async function dashboard(input: { date?: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  /**
   * WHICH DAYS THERE CAN BE AN ANSWER FOR.
   *
   * A day before the salon existed has no takings, no appointments and no
   * customers — but a dashboard asked for it would render zeros, and zeros are
   * indistinguishable from "a terrible Tuesday". Somebody looking back through
   * the calendar would find a wall of empty days and have no way to tell the
   * two apart.
   *
   * So the floor is the day the account was created and the ceiling is today,
   * and both are sent to the client so the calendar can grey out the rest
   * rather than letting a date be picked and then explained away.
   */
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { createdAt: true } });
  const earliest = startOfDay(tenant?.createdAt ?? new Date());

  const asked = input.date ?? new Date();
  const { date, clamped } = dayInRange(asked, earliest);

  const range: DateRange = { from: startOfDay(date), to: endOfDay(date) };
  const previous = previousRange(range);
  const branch = branchFilter(input.branchId);

  const [current, prior] = await Promise.all([periodSnapshot(tenantId, range, branch), periodSnapshot(tenantId, previous, branch)]);

  /**
   * The previous day can fall before the salon existed, and a -100% against a
   * day that never happened is worse than no comparison: it reads as a
   * collapse. Withheld instead.
   */
  const comparable = startOfDay(previous.from) >= earliest;

  return {
    date: dateKey(date),
    /** The first day this salon can be asked about — the calendar's floor. */
    earliestDate: dateKey(earliest),
    /** Today, in the salon's own reckoning — the calendar's ceiling. */
    latestDate: dateKey(new Date()),
    /** True when the caller asked for a day outside those bounds. */
    clamped,
    isToday: dateKey(date) === dateKey(new Date()),
    comparable,
    today: current,
    comparison: comparable
      ? {
          revenueChangePct: pctChange(current.revenue, prior.revenue),
          appointmentsChangePct: pctChange(current.appointments, prior.appointments),
          newCustomersChangePct: pctChange(current.newCustomers, prior.newCustomers),
          averageBillChangePct: pctChange(current.averageBill, prior.averageBill),
        }
      : null,
    previous: prior,
  };
}

async function periodSnapshot(tenantId: string, range: DateRange, branch: { branchId?: string | { in: string[] } }) {
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    tenantId,
    ...branch,
    invoiceDate: { gte: range.from, lte: range.to },
    status: { not: 'VOID' },
  };

  const [invoiceAgg, appointmentCounts, payments, expenses, outstandingAgg, customerRows] = await Promise.all([
    prisma.invoice.aggregate({
      where: invoiceWhere,
      _sum: { grandTotal: true, totalTax: true, billDiscount: true, itemDiscount: true },
      _count: { _all: true },
      _avg: { grandTotal: true },
    }),
    prisma.appointment.groupBy({
      by: ['status'],
      where: { tenantId, ...branch, startAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: { tenantId, ...branch, receivedAt: { gte: range.from, lte: range.to } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { tenantId, ...branch, expenseDate: { gte: startOfDay(range.from), lte: endOfDay(range.to) } },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, ...branch, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueAmount: { gt: 0 } },
      _sum: { dueAmount: true },
    }),
    prisma.invoice.findMany({
      where: { ...invoiceWhere, customerId: { not: null } },
      select: { customerId: true, customer: { select: { firstVisitAt: true } } },
    }),
  ]);

  const statusCounts = Object.fromEntries(appointmentCounts.map((s) => [s.status, s._count._all]));
  const appointments = appointmentCounts.reduce((acc, s) => acc + s._count._all, 0);

  const uniqueCustomers = new Set(customerRows.map((r) => r.customerId));
  const newCustomers = new Set(
    customerRows
      .filter((r) => r.customer?.firstVisitAt && r.customer.firstVisitAt >= range.from && r.customer.firstVisitAt <= range.to)
      .map((r) => r.customerId),
  ).size;

  const revenue = invoiceAgg._sum.grandTotal ?? d(0);
  const expenseTotal = expenses._sum.amount ?? d(0);

  return {
    period: range,
    revenue,
    collected: payments._sum.amount ?? d(0),
    invoices: invoiceAgg._count._all,
    averageBill: round2(invoiceAgg._avg.grandTotal ?? 0),
    tax: invoiceAgg._sum.totalTax ?? d(0),
    discount: add(invoiceAgg._sum.billDiscount ?? 0, invoiceAgg._sum.itemDiscount ?? 0),
    appointments,
    completed: statusCounts.COMPLETED ?? 0,
    cancelled: statusCounts.CANCELLED ?? 0,
    noShows: statusCounts.NO_SHOW ?? 0,
    upcoming: (statusCounts.BOOKED ?? 0) + (statusCounts.CONFIRMED ?? 0),
    customersServed: uniqueCustomers.size,
    newCustomers,
    returningCustomers: uniqueCustomers.size - newCustomers,
    expenses: expenseTotal,
    grossProfit: round2(sub(revenue, expenseTotal)),
    outstanding: outstandingAgg._sum.dueAmount ?? d(0),
  };
}

/** Growth metrics for a longer window. */
export async function growth(input: { from?: Date; to?: Date; branchId?: string }) {
  const tenantId = requireTenantId();
  const range = resolveRange(input.from ?? startOfMonth(new Date()), input.to ?? new Date());
  const previous = previousRange(range);
  const branch = branchFilter(input.branchId);

  const [current, prior] = await Promise.all([
    growthSnapshot(tenantId, range, branch),
    growthSnapshot(tenantId, previous, branch),
  ]);

  return {
    period: range,
    current,
    previous: prior,
    changes: {
      revenuePct: pctChange(current.revenue, prior.revenue),
      newCustomersPct: pctChange(current.newCustomers, prior.newCustomers),
      returningCustomersPct: pctChange(current.returningCustomers, prior.returningCustomers),
      retentionPct: Number((current.retentionPct - prior.retentionPct).toFixed(2)),
      averageBillPct: pctChange(current.averageBill, prior.averageBill),
    },
  };
}

async function growthSnapshot(tenantId: string, range: DateRange, branch: { branchId?: string | { in: string[] } }) {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId, ...branch, invoiceDate: { gte: range.from, lte: range.to }, status: { not: 'VOID' } },
    select: {
      grandTotal: true,
      customerId: true,
      branchId: true,
      customer: { select: { firstVisitAt: true, totalVisits: true } },
    },
  });

  const revenue = invoices.reduce<Prisma.Decimal>((acc, i) => add(acc, i.grandTotal), d(0));
  const customerIds = new Set(invoices.map((i) => i.customerId).filter(Boolean) as string[]);

  const newCustomers = new Set(
    invoices
      .filter((i) => i.customer?.firstVisitAt && i.customer.firstVisitAt >= range.from)
      .map((i) => i.customerId),
  ).size;

  const returning = customerIds.size - newCustomers;

  // Rebooking: customers served in the window who already have a future booking.
  const rebooked = customerIds.size
    ? await prisma.appointment.findMany({
        where: {
          tenantId,
          customerId: { in: [...customerIds] },
          startAt: { gt: range.to },
          status: { in: ['BOOKED', 'CONFIRMED'] },
        },
        select: { customerId: true },
        distinct: ['customerId'],
      })
    : [];

  // Retention: of customers active in the previous window, how many came back.
  const prior = previousRange(range);
  const priorCustomers = await prisma.invoice.findMany({
    where: { tenantId, ...branch, invoiceDate: { gte: prior.from, lte: prior.to }, status: { not: 'VOID' }, customerId: { not: null } },
    select: { customerId: true },
    distinct: ['customerId'],
  });
  const priorIds = new Set(priorCustomers.map((c) => c.customerId!));
  const retained = [...priorIds].filter((id) => customerIds.has(id)).length;

  const staffCount = await prisma.staff.count({ where: { tenantId, ...branch, isActive: true, isBookable: true } });
  const branchCount = await prisma.branch.count({ where: { tenantId, isActive: true } });

  return {
    revenue,
    invoices: invoices.length,
    averageBill: invoices.length ? round2(div(revenue, invoices.length)) : d(0),
    customersServed: customerIds.size,
    newCustomers,
    returningCustomers: returning,
    retentionPct: pctOf(retained, priorIds.size || 1),
    rebookingPct: pctOf(rebooked.length, customerIds.size || 1),
    revenuePerCustomer: customerIds.size ? round2(div(revenue, customerIds.size)) : d(0),
    revenuePerStaff: staffCount ? round2(div(revenue, staffCount)) : d(0),
    revenuePerBranch: branchCount ? round2(div(revenue, branchCount)) : d(0),
  };
}

/** Revenue trend, bucketed by day or month. */
export async function revenueTrend(input: { from: Date; to: Date; branchId?: string; interval?: 'day' | 'month' }) {
  const tenantId = requireTenantId();
  const interval = input.interval ?? 'day';

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      invoiceDate: { gte: input.from, lte: input.to },
      status: { not: 'VOID' },
    },
    select: { invoiceDate: true, grandTotal: true, customerId: true },
    orderBy: { invoiceDate: 'asc' },
  });

  const buckets = new Map<string, { revenue: Prisma.Decimal; invoices: number; customers: Set<string> }>();

  for (const invoice of invoices) {
    const key = interval === 'month' ? dayjs(invoice.invoiceDate).format('YYYY-MM') : dateKey(invoice.invoiceDate);
    const bucket = buckets.get(key) ?? { revenue: d(0), invoices: 0, customers: new Set<string>() };
    bucket.revenue = add(bucket.revenue, invoice.grandTotal);
    bucket.invoices += 1;
    if (invoice.customerId) bucket.customers.add(invoice.customerId);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([period, bucket]) => ({
      period,
      revenue: bucket.revenue,
      invoices: bucket.invoices,
      customers: bucket.customers.size,
      averageBill: bucket.invoices ? round2(div(bucket.revenue, bucket.invoices)) : d(0),
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** Which services actually make money. */
export async function servicePerformance(input: { from: Date; to: Date; branchId?: string; limit?: number }) {
  const tenantId = requireTenantId();

  const grouped = await prisma.invoiceItem.groupBy({
    by: ['refId', 'name'],
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      itemType: 'SERVICE',
      invoice: { invoiceDate: { gte: input.from, lte: input.to }, status: { not: 'VOID' } },
    },
    _sum: { lineTotal: true, quantity: true },
    _count: { _all: true },
    _avg: { lineTotal: true },
  });

  const totalRevenue = grouped.reduce<Prisma.Decimal>((acc, g) => add(acc, g._sum.lineTotal ?? 0), d(0));

  return grouped
    .map((g) => ({
      serviceId: g.refId,
      name: g.name,
      bookings: g._count._all,
      quantity: g._sum.quantity ?? 0,
      revenue: g._sum.lineTotal ?? d(0),
      averageTicket: round2(g._avg.lineTotal ?? 0),
      shareOfRevenuePct: pctOf(g._sum.lineTotal ?? 0, totalRevenue),
    }))
    .sort((a, b) => Number(b.revenue) - Number(a.revenue))
    .slice(0, input.limit ?? 25);
}

/**
 * Unit economics — the numbers that turn "salon software" into business
 * visibility.
 */
export async function unitEconomics(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();
  const branch = branchFilter(input.branchId);
  const days = Math.max(1, dayjs(input.to).diff(dayjs(input.from), 'day') + 1);

  const [invoiceAgg, invoices, expenseRows, marketingSpend, commissionAgg, consumptionAgg, chairs, newCustomerCount] =
    await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId, ...branch, invoiceDate: { gte: input.from, lte: input.to }, status: { not: 'VOID' } },
        _sum: { grandTotal: true, taxableAmount: true, totalTax: true },
        _count: { _all: true },
      }),
      prisma.invoice.findMany({
        where: { tenantId, ...branch, invoiceDate: { gte: input.from, lte: input.to }, status: { not: 'VOID' }, customerId: { not: null } },
        select: { customerId: true, grandTotal: true },
      }),
      prisma.expense.groupBy({
        by: ['categoryId'],
        where: { tenantId, ...branch, expenseDate: { gte: startOfDay(input.from), lte: endOfDay(input.to) } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: {
          tenantId,
          ...branch,
          expenseDate: { gte: startOfDay(input.from), lte: endOfDay(input.to) },
          category: { name: { contains: 'Marketing', mode: 'insensitive' } },
        },
        _sum: { amount: true },
      }),
      prisma.commissionEntry.aggregate({
        where: { tenantId, ...branch, earnedOn: { gte: input.from, lte: input.to } },
        _sum: { amount: true },
      }),
      prisma.stockMovement.findMany({
        where: {
          tenantId,
          ...branch,
          type: { in: ['CONSUMPTION', 'SALE'] },
          createdAt: { gte: input.from, lte: input.to },
        },
        select: { quantity: true, unitCost: true },
      }),
      prisma.resource.count({ where: { tenantId, ...branch, isActive: true } }),
      prisma.customer.count({
        where: { tenantId, ...optionalBranchFilter(input.branchId), firstVisitAt: { gte: input.from, lte: input.to } },
      }),
    ]);

  const revenue = invoiceAgg._sum.grandTotal ?? d(0);
  const expenses = expenseRows.reduce<Prisma.Decimal>((acc, e) => add(acc, e._sum.amount ?? 0), d(0));
  const cogs = consumptionAgg.reduce<Prisma.Decimal>((acc, m) => add(acc, d(m.quantity).abs().times(m.unitCost)), d(0));
  const commission = commissionAgg._sum.amount ?? d(0);
  const marketing = marketingSpend._sum.amount ?? d(0);

  const uniqueCustomers = new Set(invoices.map((i) => i.customerId!));
  const grossProfit = sub(revenue, cogs);
  const operatingProfit = sub(sub(revenue, cogs), expenses);

  // Repeat rate over the window.
  const visitsByCustomer = new Map<string, number>();
  for (const invoice of invoices) {
    visitsByCustomer.set(invoice.customerId!, (visitsByCustomer.get(invoice.customerId!) ?? 0) + 1);
  }
  const repeatCustomers = [...visitsByCustomer.values()].filter((v) => v > 1).length;

  const averageTicket = invoiceAgg._count._all ? round2(div(revenue, invoiceAgg._count._all)) : d(0);
  const visitsPerCustomer = uniqueCustomers.size ? Number(div(invoiceAgg._count._all, uniqueCustomers.size).toFixed(2)) : 0;

  // A pragmatic LTV: average ticket x visit frequency x an assumed 2-year life.
  const annualVisits = (visitsPerCustomer / days) * 365;
  const ltv = round2(d(averageTicket).times(annualVisits * 2));

  return {
    period: { from: input.from, to: input.to, days },
    revenue,
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMarginPct: pctOf(grossProfit, revenue),
    staffCommission: commission,
    operatingExpenses: round2(expenses),
    operatingProfit: round2(operatingProfit),
    operatingMarginPct: pctOf(operatingProfit, revenue),
    averageTicketSize: averageTicket,
    customersServed: uniqueCustomers.size,
    newCustomers: newCustomerCount,
    repeatCustomers,
    repeatRatePct: pctOf(repeatCustomers, uniqueCustomers.size || 1),
    visitsPerCustomer,
    averageCustomerValue: uniqueCustomers.size ? round2(div(revenue, uniqueCustomers.size)) : d(0),
    customerAcquisitionCost: newCustomerCount ? round2(div(marketing, newCustomerCount)) : d(0),
    estimatedLtv: ltv,
    ltvToCacRatio:
      newCustomerCount && Number(marketing) > 0
        ? Number(div(ltv, div(marketing, newCustomerCount)).toFixed(2))
        : null,
    revenuePerChair: chairs ? round2(div(revenue, chairs)) : d(0),
    revenuePerDay: round2(div(revenue, days)),
  };
}

/** Branch profit and loss. */
export async function branchPnl(input: { from: Date; to: Date }) {
  const tenantId = requireTenantId();
  const filter = branchFilter();

  const branches = await prisma.branch.findMany({
    where: { tenantId, isActive: true, ...(filter.branchId ? { id: filter.branchId } : {}) },
    select: { id: true, name: true, city: true },
  });

  const rows = await Promise.all(
    branches.map(async (branch) => {
      const [revenueAgg, expenseAgg, commissionAgg, consumption] = await Promise.all([
        prisma.invoice.aggregate({
          where: { tenantId, branchId: branch.id, invoiceDate: { gte: input.from, lte: input.to }, status: { not: 'VOID' } },
          _sum: { grandTotal: true },
          _count: { _all: true },
        }),
        prisma.expense.aggregate({
          where: { tenantId, branchId: branch.id, expenseDate: { gte: startOfDay(input.from), lte: endOfDay(input.to) } },
          _sum: { amount: true },
        }),
        prisma.commissionEntry.aggregate({
          where: { tenantId, branchId: branch.id, earnedOn: { gte: input.from, lte: input.to } },
          _sum: { amount: true },
        }),
        prisma.stockMovement.findMany({
          where: {
            tenantId,
            branchId: branch.id,
            type: { in: ['CONSUMPTION', 'SALE'] },
            createdAt: { gte: input.from, lte: input.to },
          },
          select: { quantity: true, unitCost: true },
        }),
      ]);

      const revenue = revenueAgg._sum.grandTotal ?? d(0);
      const cogs = consumption.reduce<Prisma.Decimal>((acc, m) => add(acc, d(m.quantity).abs().times(m.unitCost)), d(0));
      const commission = commissionAgg._sum.amount ?? d(0);
      const expenses = expenseAgg._sum.amount ?? d(0);
      const profit = sub(sub(sub(revenue, cogs), commission), expenses);

      return {
        branchId: branch.id,
        branchName: branch.name,
        city: branch.city,
        revenue,
        invoices: revenueAgg._count._all,
        cogs: round2(cogs),
        staffCommission: commission,
        expenses,
        operatingProfit: round2(profit),
        marginPct: pctOf(profit, revenue),
      };
    }),
  );

  const totals = rows.reduce(
    (acc, r) => ({
      revenue: add(acc.revenue, r.revenue),
      cogs: add(acc.cogs, r.cogs),
      commission: add(acc.commission, r.staffCommission),
      expenses: add(acc.expenses, r.expenses),
      profit: add(acc.profit, r.operatingProfit),
    }),
    { revenue: d(0), cogs: d(0), commission: d(0), expenses: d(0), profit: d(0) },
  );

  return {
    period: input,
    branches: rows.sort((a, b) => Number(b.revenue) - Number(a.revenue)),
    totals: { ...totals, marginPct: pctOf(totals.profit, totals.revenue) },
  };
}

/**
 * Monthly cohort retention: of the customers first seen in month X, what share
 * came back in each following month.
 */
export async function retentionCohorts(input: { months?: number; branchId?: string }) {
  const tenantId = requireTenantId();
  const months = input.months ?? 6;
  const from = startOfMonth(dayjs().subtract(months - 1, 'month').toDate());

  const customers = await prisma.customer.findMany({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      firstVisitAt: { gte: from, not: null },
    },
    select: { id: true, firstVisitAt: true },
  });
  if (!customers.length) return { cohorts: [] };

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      customerId: { in: customers.map((c) => c.id) },
      status: { not: 'VOID' },
      invoiceDate: { gte: from },
    },
    select: { customerId: true, invoiceDate: true },
  });

  const visitsByCustomer = new Map<string, Set<string>>();
  for (const invoice of invoices) {
    const set = visitsByCustomer.get(invoice.customerId!) ?? new Set<string>();
    set.add(dayjs(invoice.invoiceDate).format('YYYY-MM'));
    visitsByCustomer.set(invoice.customerId!, set);
  }

  const cohortMap = new Map<string, string[]>();
  for (const customer of customers) {
    const key = dayjs(customer.firstVisitAt!).format('YYYY-MM');
    cohortMap.set(key, [...(cohortMap.get(key) ?? []), customer.id]);
  }

  const cohorts = [...cohortMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cohort, ids]) => {
      const periods: { monthOffset: number; retained: number; retentionPct: number }[] = [];

      for (let offset = 0; offset < months; offset += 1) {
        const monthKey = dayjs(`${cohort}-01`).add(offset, 'month').format('YYYY-MM');
        if (dayjs(`${monthKey}-01`).isAfter(dayjs())) break;
        const retained = ids.filter((id) => visitsByCustomer.get(id)?.has(monthKey)).length;
        periods.push({ monthOffset: offset, retained, retentionPct: pctOf(retained, ids.length) });
      }

      return { cohort, size: ids.length, periods };
    });

  return { cohorts };
}

/**
 * Plain-language observations. This is what the spec means by "tell the owner
 * something", rather than yet another chart.
 */
export async function businessInsights(input: { branchId?: string }) {
  const tenantId = requireTenantId();
  const thisMonth = { from: startOfMonth(new Date()), to: endOfDay(new Date()) };
  const lastMonth = {
    from: startOfMonth(dayjs().subtract(1, 'month').toDate()),
    to: endOfMonth(dayjs().subtract(1, 'month').toDate()),
  };

  const insights: { type: string; message: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; data?: unknown }[] = [];

  const [servicesNow, servicesPrior] = await Promise.all([
    servicePerformance({ ...thisMonth, branchId: input.branchId, limit: 100 }),
    servicePerformance({ ...lastMonth, branchId: input.branchId, limit: 100 }),
  ]);
  const priorByName = new Map(servicesPrior.map((s) => [s.name, s.revenue]));

  for (const service of servicesNow.slice(0, 8)) {
    const prior = priorByName.get(service.name);
    if (!prior || Number(prior) === 0) continue;
    const change = pctChange(service.revenue, prior);
    if (Math.abs(change) >= 15) {
      insights.push({
        type: change > 0 ? 'SERVICE_GROWTH' : 'SERVICE_DECLINE',
        message: `${service.name} revenue ${change > 0 ? 'increased' : 'declined'} ${Math.abs(change).toFixed(1)}% this month.`,
        severity: change > 0 ? 'INFO' : 'WARNING',
        data: { serviceId: service.serviceId, change },
      });
    }
  }

  const lapsed = await prisma.customer.count({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      isActive: true,
      lastVisitAt: { lte: addDays(new Date(), -60), not: null },
    },
  });
  if (lapsed > 0) {
    const valuable = await prisma.customer.count({
      where: {
        tenantId,
        ...optionalBranchFilter(input.branchId),
        isActive: true,
        lastVisitAt: { lte: addDays(new Date(), -60), not: null },
        totalSpent: { gte: 5000 },
      },
    });
    insights.push({
      type: 'LAPSED_CUSTOMERS',
      message: `${lapsed} customers haven't visited for more than 60 days${valuable ? `; ${valuable} of them have spent over ₹5,000 historically` : ''}.`,
      severity: lapsed > 50 ? 'WARNING' : 'INFO',
      data: { lapsed, valuable },
    });
  }

  const topStaff = await prisma.invoiceItem.groupBy({
    by: ['staffId'],
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      staffId: { not: null },
      invoice: { invoiceDate: { gte: thisMonth.from, lte: thisMonth.to }, status: { not: 'VOID' } },
    },
    _sum: { lineTotal: true },
    orderBy: { _sum: { lineTotal: 'desc' } },
    take: 1,
  });

  if (topStaff[0]?.staffId) {
    const totalAgg = await prisma.invoiceItem.aggregate({
      where: {
        tenantId,
        ...branchFilter(input.branchId),
        itemType: 'SERVICE',
        invoice: { invoiceDate: { gte: thisMonth.from, lte: thisMonth.to }, status: { not: 'VOID' } },
      },
      _sum: { lineTotal: true },
    });
    const staff = await prisma.staff.findUnique({ where: { id: topStaff[0].staffId }, select: { displayName: true } });
    const share = pctOf(topStaff[0]._sum.lineTotal ?? 0, totalAgg._sum.lineTotal ?? 1);
    if (staff && share > 0) {
      insights.push({
        type: 'STAFF_CONCENTRATION',
        message: `${staff.displayName} generates ${share.toFixed(0)}% of service revenue this month.`,
        severity: share > 40 ? 'WARNING' : 'INFO',
        data: { staffId: topStaff[0].staffId, share },
      });
    }
  }

  const topTicket = servicesNow.slice().sort((a, b) => Number(b.averageTicket) - Number(a.averageTicket))[0];
  if (topTicket) {
    insights.push({
      type: 'TOP_TICKET',
      message: `${topTicket.name} has the highest average ticket at ₹${Number(topTicket.averageTicket).toFixed(0)}.`,
      severity: 'INFO',
      data: { serviceId: topTicket.serviceId },
    });
  }

  // Idle capacity by weekday-hour over the last 4 weeks.
  const recentServices = await prisma.appointmentService.findMany({
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      startAt: { gte: addDays(new Date(), -28) },
      appointment: { status: { in: ['COMPLETED', 'CHECKED_IN', 'IN_PROGRESS'] } },
    },
    select: { startAt: true, durationMin: true },
  });

  if (recentServices.length > 20) {
    const buckets = new Map<string, number>();
    for (const line of recentServices) {
      const key = `${dayjs(line.startAt).format('dddd')}|${dayjs(line.startAt).hour() < 14 ? 'morning' : 'afternoon'}`;
      buckets.set(key, (buckets.get(key) ?? 0) + line.durationMin);
    }
    const sorted = [...buckets.entries()].sort((a, b) => a[1] - b[1]);
    const quietest = sorted[0];
    const busiest = sorted[sorted.length - 1];
    if (quietest && busiest && busiest[1] > 0) {
      const idlePct = 100 - Math.round((quietest[1] / busiest[1]) * 100);
      const [day, part] = quietest[0].split('|');
      insights.push({
        type: 'IDLE_CAPACITY',
        message: `${day} ${part} is your quietest slot — roughly ${idlePct}% less booked than your busiest. Consider an off-peak offer.`,
        severity: 'INFO',
        data: { day, part, idlePct },
      });
    }
  }

  return { generatedAt: new Date(), insights };
}

/** Monthly summary combining every module. */
export async function monthlyReport(input: { month: number; year: number; branchId?: string }) {
  const from = startOfMonth(new Date(Date.UTC(input.year, input.month - 1, 1)));
  const to = endOfMonth(from);

  const [economics, growthData, services, pnl, cohorts] = await Promise.all([
    unitEconomics({ from, to, branchId: input.branchId }),
    growth({ from, to, branchId: input.branchId }),
    servicePerformance({ from, to, branchId: input.branchId, limit: 10 }),
    branchPnl({ from, to }),
    retentionCohorts({ months: 6, branchId: input.branchId }),
  ]);

  return { period: { from, to, month: input.month, year: input.year }, economics, growth: growthData, topServices: services, pnl, cohorts };
}
