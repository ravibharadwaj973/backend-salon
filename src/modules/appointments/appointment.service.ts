import type { AppointmentStatus, BookingSource, Gender, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, currentUserId } from '../../core/context';
import { branchFilter, requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, round2, sub } from '../../core/money';
import { addDays, addMinutes, dateKey, dayjs, endOfDay, startOfDay } from '../../core/dates';
import { normalizePhone, sequenceNumber } from '../../core/ids';
import { enqueue, enqueueSafe, cancelJobs } from '../../jobs/queue';
import { findConflicts, type ConflictCheckItem } from './availability.service';
import { logger } from '../../core/logger';

export interface ServiceLineInput {
  serviceId: string;
  staffId?: string;
  resourceId?: string;
  startAt?: Date;
  durationMin?: number;
  price?: number;
  discount?: number;
  notes?: string;
}

export interface CreateAppointmentInput {
  branchId?: string;
  customerId?: string;
  walkInName?: string;
  walkInPhone?: string;
  startAt: Date;
  source?: BookingSource;
  /** Which page or code the booking came from. Free text, never trusted. */
  sourceRef?: string;
  notes?: string;
  internalNotes?: string;
  services: ServiceLineInput[];
  force?: boolean;
  sendConfirmation?: boolean;
}

const APPOINTMENT_INCLUDE = {
  customer: {
    select: { id: true, firstName: true, lastName: true, phone: true, tier: true, loyaltyPoints: true, totalVisits: true },
  },
  branch: { select: { id: true, name: true, timezone: true } },
  services: {
    orderBy: { startAt: 'asc' as const },
    include: {
      service: { select: { id: true, name: true, durationMin: true, price: true, taxRatePct: true } },
      staff: { select: { id: true, displayName: true, colorHex: true } },
      resource: { select: { id: true, name: true, type: true } },
    },
  },
  invoice: { select: { id: true, invoiceNumber: true, grandTotal: true, status: true, dueAmount: true } },
  feedback: { select: { id: true, rating: true, comment: true } },
} satisfies Prisma.AppointmentInclude;

/**
 * Turns requested service lines into concrete time slots. Lines without an
 * explicit start are chained one after another from the appointment start,
 * honouring each service's buffer time.
 */
interface BuiltLine extends ConflictCheckItem {
  serviceId: string;
  staffId: string | null;
  resourceId: string | null;
  startAt: Date;
  endAt: Date;
  durationMin: number;
  price: number;
  discount?: number;
  notes?: string;
}

async function buildLines(
  tenantId: string,
  startAt: Date,
  lines: ServiceLineInput[],
): Promise<{ items: BuiltLine[]; endAt: Date; totalDuration: number; estimated: number }> {
  const services = await prisma.service.findMany({
    where: { tenantId, id: { in: lines.map((l) => l.serviceId) } },
  });
  const byId = new Map(services.map((s) => [s.id, s]));

  let cursor = startAt;
  let totalDuration = 0;
  let estimated = round2(0);

  const items = lines.map((line) => {
    const service = byId.get(line.serviceId);
    if (!service) throw BadRequest(`Service ${line.serviceId} not found`);
    if (!service.isActive) throw BadRequest(`${service.name} is no longer offered`);

    const durationMin = line.durationMin ?? service.durationMin;
    const start = line.startAt ?? cursor;
    const end = addMinutes(start, durationMin);

    cursor = addMinutes(end, service.bufferMin);
    totalDuration += durationMin;

    const price = line.price ?? Number(service.price);
    estimated = add(estimated, sub(price, line.discount ?? 0));

    return {
      ...line,
      serviceId: service.id,
      staffId: line.staffId ?? null,
      resourceId: line.resourceId ?? null,
      startAt: start,
      endAt: end,
      durationMin,
      price,
    };
  });

  const endAt = items.reduce((latest, i) => (i.endAt > latest ? i.endAt : latest), startAt);
  return { items, endAt, totalDuration, estimated: Number(estimated) };
}

export async function createAppointment(input: CreateAppointmentInput) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  if (input.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw NotFound('Customer');
    if (customer.isBlacklisted) throw BadRequest('This customer is blacklisted and cannot be booked');
  }

  const { items, endAt, totalDuration, estimated } = await buildLines(tenantId, input.startAt, input.services);

  const conflicts = await findConflicts(branchId, items);
  if (conflicts.length && !input.force) {
    throw Conflict('This slot is not available', { conflicts });
  }

  const appointment = await prisma.$transaction(async (tx) => {
    const created = await tx.appointment.create({
      data: {
        tenantId,
        branchId,
        customerId: input.customerId ?? null,
        walkInName: input.walkInName ?? null,
        walkInPhone: input.walkInPhone ? normalizePhone(input.walkInPhone) : null,
        startAt: input.startAt,
        endAt,
        status: 'BOOKED',
        source: input.source ?? 'RECEPTION',
        sourceRef: input.sourceRef ?? null,
        notes: input.notes ?? null,
        internalNotes: input.internalNotes ?? null,
        totalDurationMin: totalDuration,
        estimatedAmount: estimated,
        createdById: currentUserId(),
      },
    });

    await tx.appointmentService.createMany({
      data: items.map((item) => ({
        tenantId,
        branchId,
        appointmentId: created.id,
        serviceId: item.serviceId,
        staffId: item.staffId ?? null,
        resourceId: item.resourceId ?? null,
        startAt: item.startAt,
        endAt: item.endAt,
        durationMin: item.durationMin,
        price: item.price,
        discount: item.discount ?? 0,
        notes: item.notes ?? null,
      })),
    });

    return created;
  });

  await scheduleAppointmentJobs(appointment.id, appointment.startAt, {
    sendConfirmation: input.sendConfirmation !== false,
    customerId: input.customerId ?? null,
  });

  logger.info({ appointmentId: appointment.id, branchId }, 'appointment booked');
  return getAppointment(appointment.id);
}

/** Confirmation, 24h and 2h reminders, plus the no-show sweep. */
async function scheduleAppointmentJobs(
  appointmentId: string,
  startAt: Date,
  options: { sendConfirmation: boolean; customerId: string | null },
): Promise<void> {
  const now = new Date();

  if (options.sendConfirmation && options.customerId) {
    await enqueue('journey.trigger', { trigger: 'APPOINTMENT_BOOKED', customerId: options.customerId, appointmentId });
  }

  const reminder24 = dayjs(startAt).subtract(24, 'hour').toDate();
  const reminder2 = dayjs(startAt).subtract(2, 'hour').toDate();

  if (reminder24 > now) {
    await enqueue(
      'appointment.reminder',
      { appointmentId, kind: '24h' },
      { runAt: reminder24, uniqueKey: `reminder:24h:${appointmentId}` },
    );
  }
  if (reminder2 > now) {
    await enqueue(
      'appointment.reminder',
      { appointmentId, kind: '2h' },
      { runAt: reminder2, uniqueKey: `reminder:2h:${appointmentId}` },
    );
  }
}

export async function getAppointment(id: string) {
  const appointment = await prisma.appointment.findUnique({ where: { id }, include: APPOINTMENT_INCLUDE });
  if (!appointment) throw NotFound('Appointment');
  return appointment;
}

export async function listAppointments(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  branchId?: string;
  customerId?: string;
  staffId?: string;
  status?: AppointmentStatus;
  source?: BookingSource;
  from?: Date;
  to?: Date;
  unbilled?: string;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.AppointmentWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.staffId ? { services: { some: { staffId: input.staffId } } } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.unbilled === 'true' ? { invoice: null, status: 'COMPLETED' } : {}),
    ...(input.from || input.to
      ? { startAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
    ...(input.q
      ? {
          OR: [
            { customer: { firstName: { contains: input.q, mode: 'insensitive' as const } } },
            { customer: { lastName: { contains: input.q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: normalizePhone(input.q) } } },
            { walkInName: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.appointment.findMany({ where, skip, take, orderBy: { startAt: 'desc' }, include: APPOINTMENT_INCLUDE }),
    prisma.appointment.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

/** Day or week calendar, grouped by stylist or by chair/room. */
export async function calendar(input: {
  branchId?: string;
  date: Date;
  view?: 'day' | 'week';
  groupBy?: 'staff' | 'resource';
  staffId?: string;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw NotFound('Branch');

  const from = input.view === 'week' ? startOfDay(dayjs(input.date).startOf('week').toDate(), branch.timezone) : startOfDay(input.date, branch.timezone);
  const to = input.view === 'week' ? endOfDay(addDays(from, 6), branch.timezone) : endOfDay(input.date, branch.timezone);

  const [lines, staff, resources] = await Promise.all([
    prisma.appointmentService.findMany({
      where: {
        tenantId,
        branchId,
        startAt: { gte: from, lte: to },
        ...(input.staffId ? { staffId: input.staffId } : {}),
        appointment: { status: { not: 'CANCELLED' } },
      },
      orderBy: { startAt: 'asc' },
      include: {
        service: { select: { id: true, name: true, durationMin: true } },
        staff: { select: { id: true, displayName: true, colorHex: true } },
        resource: { select: { id: true, name: true } },
        appointment: {
          select: {
            id: true,
            status: true,
            source: true,
            notes: true,
            customerId: true,
            walkInName: true,
            walkInPhone: true,
            customer: { select: { id: true, firstName: true, lastName: true, phone: true, tier: true } },
            invoice: { select: { id: true, status: true } },
          },
        },
      },
    }),
    prisma.staff.findMany({
      where: { tenantId, branchId, isActive: true, isBookable: true },
      select: { id: true, displayName: true, colorHex: true, avatarUrl: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.resource.findMany({
      where: { tenantId, branchId, isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const columns =
    input.groupBy === 'resource'
      ? resources.map((r) => ({ id: r.id, label: r.name, kind: 'resource' as const }))
      : staff.map((s) => ({ id: s.id, label: s.displayName, kind: 'staff' as const, colorHex: s.colorHex }));

  const grouped = new Map<string, typeof lines>();
  const unassigned: typeof lines = [];

  for (const line of lines) {
    const key = input.groupBy === 'resource' ? line.resourceId : line.staffId;
    if (!key) {
      unassigned.push(line);
      continue;
    }
    const list = grouped.get(key) ?? [];
    list.push(line);
    grouped.set(key, list);
  }

  return {
    branch: { id: branch.id, name: branch.name, timezone: branch.timezone, slotIntervalMin: branch.slotIntervalMin },
    range: { from, to },
    openingHours: branch.openingHours,
    columns: columns.map((c) => ({ ...c, appointments: grouped.get(c.id) ?? [] })),
    unassigned,
    totals: {
      appointments: new Set(lines.map((l) => l.appointmentId)).size,
      services: lines.length,
      bookedMinutes: lines.reduce((acc, l) => acc + l.durationMin, 0),
    },
  };
}

export async function updateAppointment(id: string, input: { notes?: string; internalNotes?: string; services?: ServiceLineInput[]; force?: boolean }) {
  const tenantId = requireTenantId();
  const appointment = await prisma.appointment.findUnique({ where: { id }, include: { services: true } });
  if (!appointment) throw NotFound('Appointment');
  if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) {
    throw Conflict('A completed or cancelled appointment can no longer be edited');
  }

  if (!input.services) {
    return prisma.appointment
      .update({
        where: { id },
        data: { notes: input.notes ?? appointment.notes, internalNotes: input.internalNotes ?? appointment.internalNotes },
      })
      .then(() => getAppointment(id));
  }

  const { items, endAt, totalDuration, estimated } = await buildLines(tenantId, appointment.startAt, input.services);
  const conflicts = await findConflicts(appointment.branchId, items, id);
  if (conflicts.length && !input.force) throw Conflict('This change conflicts with existing bookings', { conflicts });

  await prisma.$transaction(async (tx) => {
    await tx.appointmentService.deleteMany({ where: { appointmentId: id } });
    await tx.appointmentService.createMany({
      data: items.map((item) => ({
        tenantId,
        branchId: appointment.branchId,
        appointmentId: id,
        serviceId: item.serviceId,
        staffId: item.staffId ?? null,
        resourceId: item.resourceId ?? null,
        startAt: item.startAt,
        endAt: item.endAt,
        durationMin: item.durationMin,
        price: item.price,
        discount: item.discount ?? 0,
        notes: item.notes ?? null,
      })),
    });
    await tx.appointment.update({
      where: { id },
      data: {
        endAt,
        totalDurationMin: totalDuration,
        estimatedAmount: estimated,
        notes: input.notes ?? appointment.notes,
        internalNotes: input.internalNotes ?? appointment.internalNotes,
      },
    });
  });

  return getAppointment(id);
}

export async function rescheduleAppointment(
  id: string,
  input: { startAt: Date; staffId?: string; force?: boolean; reason?: string },
) {
  const tenantId = requireTenantId();
  const appointment = await prisma.appointment.findUnique({
    where: { id },
    include: { services: { orderBy: { startAt: 'asc' } } },
  });
  if (!appointment) throw NotFound('Appointment');
  if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) {
    throw Conflict('This appointment can no longer be rescheduled');
  }

  const lines: ServiceLineInput[] = appointment.services.map((s) => ({
    serviceId: s.serviceId,
    staffId: input.staffId ?? s.staffId ?? undefined,
    resourceId: s.resourceId ?? undefined,
    durationMin: s.durationMin,
    price: Number(s.price),
    discount: Number(s.discount),
  }));

  const { items, endAt, totalDuration } = await buildLines(tenantId, input.startAt, lines);
  const conflicts = await findConflicts(appointment.branchId, items, id);
  if (conflicts.length && !input.force) throw Conflict('The new slot is not available', { conflicts });

  await prisma.$transaction(async (tx) => {
    await tx.appointmentService.deleteMany({ where: { appointmentId: id } });
    await tx.appointmentService.createMany({
      data: items.map((item) => ({
        tenantId,
        branchId: appointment.branchId,
        appointmentId: id,
        serviceId: item.serviceId,
        staffId: item.staffId ?? null,
        resourceId: item.resourceId ?? null,
        startAt: item.startAt,
        endAt: item.endAt,
        durationMin: item.durationMin,
        price: item.price,
        discount: item.discount ?? 0,
      })),
    });
    await tx.appointment.update({
      where: { id },
      data: {
        startAt: input.startAt,
        endAt,
        totalDurationMin: totalDuration,
        status: 'BOOKED',
        confirmedAt: null,
        internalNotes: input.reason
          ? `${appointment.internalNotes ?? ''}\n[Rescheduled] ${input.reason}`.trim()
          : appointment.internalNotes,
      },
    });
  });

  // Old reminders no longer apply.
  await cancelJobs(`reminder:24h:${id}`);
  await cancelJobs(`reminder:2h:${id}`);
  await scheduleAppointmentJobs(id, input.startAt, { sendConfirmation: true, customerId: appointment.customerId });

  return getAppointment(id);
}

const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  BOOKED: ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: ['BOOKED'],
};

export async function changeStatus(id: string, status: AppointmentStatus, meta: { reason?: string; notifyCustomer?: boolean } = {}) {
  const appointment = await prisma.appointment.findUnique({ where: { id } });
  if (!appointment) throw NotFound('Appointment');

  const allowed = ALLOWED_TRANSITIONS[appointment.status];
  if (!allowed.includes(status)) {
    throw Conflict(`Cannot move an appointment from ${appointment.status} to ${status}`);
  }

  const now = new Date();
  const data: Prisma.AppointmentUpdateInput = { status };

  if (status === 'CONFIRMED') data.confirmedAt = now;
  if (status === 'CHECKED_IN') data.checkedInAt = now;
  if (status === 'IN_PROGRESS') data.startedAt = now;
  if (status === 'COMPLETED') data.completedAt = now;
  if (status === 'CANCELLED') {
    data.cancelledAt = now;
    data.cancelReason = meta.reason ?? null;
  }

  const updated = await prisma.appointment.update({ where: { id }, data });

  if (status === 'COMPLETED') {
    await prisma.appointmentService.updateMany({
      where: { appointmentId: id, status: { not: 'CANCELLED' } },
      data: { status: 'COMPLETED' },
    });
    if (updated.customerId) {
      enqueueSafe('journey.trigger', {
        trigger: 'APPOINTMENT_COMPLETED',
        customerId: updated.customerId,
        appointmentId: id,
      });
    }
  }

  if (status === 'CANCELLED' || status === 'NO_SHOW') {
    await cancelJobs(`reminder:24h:${id}`);
    await cancelJobs(`reminder:2h:${id}`);
    if (status === 'CANCELLED' && updated.customerId && meta.notifyCustomer !== false) {
      enqueueSafe('journey.trigger', {
        trigger: 'APPOINTMENT_CANCELLED',
        customerId: updated.customerId,
        appointmentId: id,
      });
    }
  }

  return getAppointment(id);
}

/**
 * Walk-in: creates (or reuses) a customer record so the visit still counts
 * towards history and retention, then books it starting now.
 */
export async function createWalkIn(input: {
  branchId?: string;
  name: string;
  phone?: string;
  gender?: Gender;
  services: ServiceLineInput[];
  createCustomer?: boolean;
  startAt?: Date;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  let customerId: string | undefined;

  if (input.createCustomer !== false && input.phone) {
    const phone = normalizePhone(input.phone);
    const existing = await prisma.customer.findFirst({ where: { tenantId, phone } });
    if (existing) {
      customerId = existing.id;
    } else {
      const count = await prisma.customer.count({ where: { tenantId } });
      const parts = input.name.trim().split(/\s+/);
      const customer = await prisma.customer.create({
        data: {
          tenantId,
          branchId,
          code: sequenceNumber('C', count + 1, 5),
          firstName: parts[0] ?? input.name,
          lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
          phone,
          gender: input.gender ?? null,
          source: 'WALK_IN',
        },
      });
      customerId = customer.id;
    }
  }

  return createAppointment({
    branchId,
    customerId,
    walkInName: customerId ? undefined : input.name,
    walkInPhone: input.phone,
    startAt: input.startAt ?? new Date(),
    source: 'WALK_IN',
    services: input.services,
    force: true, // walk-ins are squeezed in by definition
    sendConfirmation: false,
  }).then(async (appointment) => {
    await changeStatus(appointment.id, 'CHECKED_IN');
    return getAppointment(appointment.id);
  });
}

export async function createRecurring(input: {
  frequency: 'WEEKLY' | 'MONTHLY';
  interval: number;
  occurrences: number;
  appointment: CreateAppointmentInput;
}) {
  const tenantId = requireTenantId();
  const groupId = `rec_${Date.now().toString(36)}`;

  await prisma.recurringRule.create({
    data: {
      tenantId,
      groupId,
      frequency: input.frequency,
      interval: input.interval,
      occurrences: input.occurrences,
    },
  });

  const results: { date: Date; appointmentId?: string; error?: string }[] = [];

  for (let i = 0; i < input.occurrences; i += 1) {
    const startAt =
      input.frequency === 'WEEKLY'
        ? dayjs(input.appointment.startAt).add(i * input.interval, 'week').toDate()
        : dayjs(input.appointment.startAt).add(i * input.interval, 'month').toDate();

    try {
      const created = await createAppointment({ ...input.appointment, startAt, sendConfirmation: i === 0 });
      await prisma.appointment.update({ where: { id: created.id }, data: { isRecurring: true, recurringGroupId: groupId } });
      results.push({ date: startAt, appointmentId: created.id });
    } catch (err) {
      results.push({ date: startAt, error: err instanceof Error ? err.message : 'Could not book' });
    }
  }

  return { groupId, booked: results.filter((r) => r.appointmentId).length, results };
}

// ------------------------------------------------------------- waitlist ----

export async function addToWaitlist(input: {
  branchId?: string;
  customerId: string;
  serviceId?: string;
  preferredStaffId?: string;
  preferredDate: Date;
  preferredFrom?: string;
  preferredTo?: string;
  notes?: string;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  return prisma.waitlist.create({
    data: {
      tenantId,
      branchId,
      customerId: input.customerId,
      serviceId: input.serviceId ?? null,
      preferredStaffId: input.preferredStaffId ?? null,
      preferredDate: input.preferredDate,
      preferredFrom: input.preferredFrom ?? null,
      preferredTo: input.preferredTo ?? null,
      notes: input.notes ?? null,
    },
  });
}

export async function listWaitlist(input: { branchId?: string; status?: string; date?: Date; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.WaitlistWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.status ? { status: input.status as Prisma.EnumWaitlistStatusFilter['equals'] } : { status: 'WAITING' }),
    ...(input.date ? { preferredDate: input.date } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.waitlist.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'asc' },
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true, tier: true } } },
    }),
    prisma.waitlist.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function updateWaitlistStatus(id: string, status: 'WAITING' | 'NOTIFIED' | 'CONVERTED' | 'EXPIRED' | 'CANCELLED') {
  const entry = await prisma.waitlist.findUnique({ where: { id } });
  if (!entry) throw NotFound('Waitlist entry');
  return prisma.waitlist.update({
    where: { id },
    data: { status, notifiedAt: status === 'NOTIFIED' ? new Date() : entry.notifiedAt },
  });
}

/** Today at a glance, for the front desk. */
/**
 * A day's appointments. Today unless asked otherwise.
 *
 * "Upcoming" only means anything on today: on a past day nothing is upcoming,
 * and a list filtered to `startAt >= now` would come back empty and read as
 * "no appointments that day" rather than "that day is over". So on any other
 * day it shows what the day actually held, which is the question somebody
 * looking back is asking.
 */
export async function todaySummary(branchId?: string, forDate?: Date) {
  const tenantId = requireTenantId();
  const branch = branchFilter(branchId);
  const day = forDate ?? new Date();
  const isToday = dateKey(day) === dateKey(new Date());
  const from = startOfDay(day);
  const to = endOfDay(day);

  const [byStatus, upcoming, unconfirmedTomorrow] = await Promise.all([
    prisma.appointment.groupBy({
      by: ['status'],
      where: { tenantId, ...branch, startAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.appointment.findMany({
      where: isToday
        ? { tenantId, ...branch, startAt: { gte: new Date(), lte: to }, status: { in: ['BOOKED', 'CONFIRMED'] } }
        : { tenantId, ...branch, startAt: { gte: from, lte: to } },
      orderBy: { startAt: 'asc' },
      take: 10,
      include: APPOINTMENT_INCLUDE,
    }),
    // Only meaningful while looking at today. On a past day "unconfirmed
    // tomorrow" is a number about a day that has already been and gone.
    isToday
      ? prisma.appointment.count({
          where: {
            tenantId,
            ...branch,
            startAt: { gte: startOfDay(addDays(new Date(), 1)), lte: endOfDay(addDays(new Date(), 1)) },
            status: 'BOOKED',
          },
        })
      : Promise.resolve(0),
  ]);

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
  const total = byStatus.reduce((acc, s) => acc + s._count._all, 0);

  return {
    total,
    counts,
    completed: counts.COMPLETED ?? 0,
    noShows: counts.NO_SHOW ?? 0,
    cancelled: counts.CANCELLED ?? 0,
    isToday,
    upcoming,
    unconfirmedTomorrow,
  };
}

/** Marks past appointments that were never checked in as no-shows. */
export async function sweepNoShows(graceMinutes = 30) {
  const cutoff = dayjs().subtract(graceMinutes, 'minute').toDate();
  const stale = await prisma.appointment.findMany({
    where: { status: { in: ['BOOKED', 'CONFIRMED'] }, endAt: { lt: cutoff } },
    select: { id: true, tenantId: true },
    take: 500,
  });

  for (const appointment of stale) {
    await prisma.appointment
      .update({ where: { id: appointment.id }, data: { status: 'NO_SHOW' } })
      .catch((err: unknown) => logger.warn({ err, id: appointment.id }, 'no-show sweep failed'));
  }

  return { marked: stale.length };
}

export const appointmentInclude = APPOINTMENT_INCLUDE;
export { d };
