import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { assertBranchAccess } from '../../core/scope';
import { BadRequest, NotFound } from '../../core/errors';
import {
  atTime,
  dateKey,
  dateOnly,
  dayOfWeek,
  dayjs,
  endOfDay,
  minutesToTime,
  overlaps,
  startOfDay,
  timeToMinutes,
} from '../../core/dates';

export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotRequest {
  branchId: string;
  date: Date;
  serviceIds: string[];
  staffId?: string;
  /** Ignore this appointment's own bookings (used when rescheduling). */
  excludeAppointmentId?: string;
}

export interface Slot {
  start: Date;
  end: Date;
  /** "14:30" in the branch's own timezone — what a customer reads. */
  label: string;
  /**
   * False when this stylist is already busy then.
   *
   * Taken times are RETURNED rather than filtered out, so a booking page can
   * grey them instead of leaving a hole. A missing 11:00 tells a customer
   * nothing — it could be a booking, a lunch break, or a time the salon never
   * offers. A greyed 11:00 says "someone got there first", which is both true
   * and the thing that makes them take the 11:30.
   *
   * Only times the salon could otherwise sell appear at all: outside opening
   * hours, outside the stylist's shift, and already past are all absent.
   */
  available: boolean;
}

export interface StaffSlots {
  staffId: string;
  staffName: string;
  slots: Slot[];
}

interface OpeningWindow {
  open: string;
  close: string;
}

export async function branchOpeningWindows(branchId: string, date: Date): Promise<OpeningWindow[]> {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw NotFound('Branch');

  const holiday = await prisma.holiday.findFirst({
    where: { tenantId: branch.tenantId, date: dateOnly(date, branch.timezone), OR: [{ branchId }, { branchId: null }] },
  });
  if (holiday) return [];

  const hours = (branch.openingHours as Record<string, OpeningWindow[]> | null) ?? {};
  return hours[String(dayOfWeek(date, branch.timezone))] ?? [];
}

/** Everything that already occupies a staff member's day. */
export async function staffBusyIntervals(
  staffIds: string[],
  from: Date,
  to: Date,
  excludeAppointmentId?: string,
): Promise<Map<string, Interval[]>> {
  if (!staffIds.length) return new Map();

  const [booked, timeOff] = await Promise.all([
    prisma.appointmentService.findMany({
      where: {
        staffId: { in: staffIds },
        startAt: { lt: to },
        endAt: { gt: from },
        appointment: {
          status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
      },
      select: { staffId: true, startAt: true, endAt: true, service: { select: { bufferMin: true } } },
    }),
    prisma.staffTimeOff.findMany({
      where: { staffId: { in: staffIds }, startAt: { lt: to }, endAt: { gt: from } },
      select: { staffId: true, startAt: true, endAt: true },
    }),
  ]);

  const map = new Map<string, Interval[]>();
  const push = (staffId: string, interval: Interval) => {
    const list = map.get(staffId) ?? [];
    list.push(interval);
    map.set(staffId, list);
  };

  for (const row of booked) {
    if (!row.staffId) continue;
    // Buffer time after a service is treated as busy.
    push(row.staffId, {
      start: row.startAt,
      end: dayjs(row.endAt).add(row.service.bufferMin, 'minute').toDate(),
    });
  }
  for (const row of timeOff) push(row.staffId, { start: row.startAt, end: row.endAt });

  return map;
}

export async function resourceBusyIntervals(
  resourceIds: string[],
  from: Date,
  to: Date,
  excludeAppointmentId?: string,
): Promise<Map<string, Interval[]>> {
  if (!resourceIds.length) return new Map();

  const rows = await prisma.appointmentService.findMany({
    where: {
      resourceId: { in: resourceIds },
      startAt: { lt: to },
      endAt: { gt: from },
      appointment: {
        status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
    },
    select: { resourceId: true, startAt: true, endAt: true },
  });

  const map = new Map<string, Interval[]>();
  for (const row of rows) {
    if (!row.resourceId) continue;
    const list = map.get(row.resourceId) ?? [];
    list.push({ start: row.startAt, end: row.endAt });
    map.set(row.resourceId, list);
  }
  return map;
}

/**
 * Every appointment occupying this branch in a window, one interval each.
 *
 * Per APPOINTMENT, not per service line: someone having a cut, a colour and a
 * blow-dry is one person in the salon for two hours, not three simultaneous
 * bookings. Counting lines would make a branch look full three times over.
 */
export async function bookedIntervals(
  branchId: string,
  from: Date,
  to: Date,
  excludeAppointmentId?: string,
): Promise<Interval[]> {
  const rows = await prisma.appointmentService.findMany({
    where: {
      branchId,
      startAt: { lt: to },
      endAt: { gt: from },
      appointment: {
        status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS'] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
    },
    select: { appointmentId: true, startAt: true, endAt: true },
  });

  const byAppointment = new Map<string, Interval>();
  for (const row of rows) {
    const current = byAppointment.get(row.appointmentId);
    byAppointment.set(
      row.appointmentId,
      current
        ? {
            start: row.startAt < current.start ? row.startAt : current.start,
            end: row.endAt > current.end ? row.endAt : current.end,
          }
        : { start: row.startAt, end: row.endAt },
    );
  }

  return [...byAppointment.values()];
}

/** How many of those overlap a given window. */
function concurrentAt(intervals: Interval[], start: Date, end: Date): number {
  return intervals.filter((i) => overlaps(start, end, i.start, i.end)).length;
}

/**
 * The most bookings this branch takes at one moment.
 *
 * The salon's own number when they have set one; otherwise how many bookable
 * stylists work there. The fallback is not a new rule — it is what "capacity
 * comes from the rota" always meant. It is stated explicitly because the
 * per-stylist checks cannot see an appointment with nobody assigned to it, and
 * without a branch-wide number those bookings were unlimited: a receptionist
 * could stack ten people onto one o'clock and nothing anywhere objected.
 */
export async function effectiveCapacity(branch: { id: string; maxConcurrentBookings: number | null }): Promise<number> {
  if (branch.maxConcurrentBookings) return branch.maxConcurrentBookings;

  const stylists = await prisma.staff.count({
    where: { branchId: branch.id, isActive: true, isBookable: true },
  });

  // A branch with nobody on the books should not silently become unlimited.
  return Math.max(stylists, 1);
}

function isFree(intervals: Interval[] | undefined, start: Date, end: Date): boolean {
  if (!intervals?.length) return true;
  return !intervals.some((i) => overlaps(start, end, i.start, i.end));
}

/**
 * The shape of a stylist's day for a given set of services.
 *
 * Returns every time the salon could sell — inside opening hours, inside that
 * stylist's shift, long enough for the whole booking, and still to come —
 * each marked available or not. Holidays, time off, existing bookings and
 * their buffer time are what make one unavailable.
 *
 * It returns taken times rather than hiding them because the caller is a
 * booking page, and a customer reads a greyed 11:00 as "gone" but reads a
 * missing 11:00 as nothing at all.
 */
export async function availableSlots(input: SlotRequest): Promise<StaffSlots[]> {
  const tenantId = requireTenantId();
  assertBranchAccess(input.branchId);

  const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!branch) throw NotFound('Branch');

  const services = await prisma.service.findMany({
    where: { tenantId, id: { in: input.serviceIds }, isActive: true },
  });
  if (services.length !== input.serviceIds.length) throw BadRequest('One or more services are unavailable');

  const totalDuration = services.reduce((acc, s) => acc + s.durationMin, 0);
  const trailingBuffer = services[services.length - 1]?.bufferMin ?? 0;

  const windows = await branchOpeningWindows(input.branchId, input.date);
  if (!windows.length) return [];

  const dayStart = startOfDay(input.date, branch.timezone);
  const dayEnd = endOfDay(input.date, branch.timezone);
  const weekday = dayOfWeek(input.date, branch.timezone);

  const staffList = await prisma.staff.findMany({
    where: {
      tenantId,
      branchId: input.branchId,
      isActive: true,
      isBookable: true,
      ...(input.staffId ? { id: input.staffId } : {}),
      // Every requested service must be in the stylist's repertoire.
      AND: input.serviceIds.map((serviceId) => ({ services: { some: { serviceId } } })),
    },
    include: { availability: { where: { dayOfWeek: weekday } } },
  });
  if (!staffList.length) return [];

  const busyByStaff = await staffBusyIntervals(
    staffList.map((s) => s.id),
    dayStart,
    dayEnd,
    input.excludeAppointmentId,
  );

  // Always applied, not just when the salon has set a number. Bookings with no
  // stylist assigned are invisible to the per-stylist busy map, so this is the
  // only thing that counts them.
  const cap = await effectiveCapacity(branch);
  const dayBookings = await bookedIntervals(input.branchId, dayStart, dayEnd, input.excludeAppointmentId);

  const interval = branch.slotIntervalMin > 0 ? branch.slotIntervalMin : 15;
  const now = new Date();

  return staffList
    .map((staff) => {
      const slots: Slot[] = [];

      for (const window of windows) {
        for (const shift of staff.availability) {
          const from = Math.max(timeToMinutes(window.open), timeToMinutes(shift.startTime));
          const until = Math.min(timeToMinutes(window.close), timeToMinutes(shift.endTime));

          for (let minute = from; minute + totalDuration <= until; minute += interval) {
            const start = atTime(input.date, minutesToTime(minute), branch.timezone);
            const end = dayjs(start).add(totalDuration, 'minute').toDate();
            const endWithBuffer = dayjs(end).add(trailingBuffer, 'minute').toDate();

            // A time that has already passed is not a slot at all — showing
            // this morning greyed out at four in the afternoon is just noise.
            if (start <= now) continue;

            // Two independent reasons a time can be gone: this stylist is
            // busy, or the shop is already as full as it will let the
            // internet make it. The buffer counts against the stylist but not
            // against the room — a customer is in the chair for the
            // appointment, not for the stylist's turnaround afterwards.
            const stylistFree = isFree(busyByStaff.get(staff.id), start, endWithBuffer);
            const roomLeft = concurrentAt(dayBookings, start, end) < cap;

            slots.push({
              start,
              end,
              label: minutesToTime(minute),
              available: stylistFree && roomLeft,
            });
          }
        }
      }

      return { staffId: staff.id, staffName: staff.displayName, slots };
    })
    .filter((s) => s.slots.length > 0);
}

export interface ConflictCheckItem {
  serviceId: string;
  staffId?: string | null;
  resourceId?: string | null;
  startAt: Date;
  endAt: Date;
}

export interface Conflict {
  type:
    | 'STAFF_BUSY'
    | 'STAFF_UNAVAILABLE'
    | 'STAFF_TIME_OFF'
    | 'RESOURCE_BUSY'
    | 'BRANCH_CLOSED'
    | 'BRANCH_AT_CAPACITY'
    | 'OVERLAP_IN_REQUEST';
  message: string;
  staffId?: string | null;
  resourceId?: string | null;
  startAt: Date;
}

/**
 * Central double-booking guard. Every write path (create, reschedule, staff
 * change) runs through this before touching the database.
 */
export async function findConflicts(
  branchId: string,
  items: ConflictCheckItem[],
  excludeAppointmentId?: string,
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  if (!items.length) return conflicts;

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw NotFound('Branch');

  const from = new Date(Math.min(...items.map((i) => i.startAt.getTime())));
  const to = new Date(Math.max(...items.map((i) => i.endAt.getTime())));

  // 1. The requested lines must not collide with each other.
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.staffId && a.staffId === b.staffId && overlaps(a.startAt, a.endAt, b.startAt, b.endAt)) {
        conflicts.push({
          type: 'OVERLAP_IN_REQUEST',
          message: 'Two services in this booking are assigned to the same stylist at the same time',
          staffId: a.staffId,
          startAt: a.startAt,
        });
      }
    }
  }

  // 2. Branch must be open for every line.
  for (const item of items) {
    const windows = await branchOpeningWindows(branchId, item.startAt);
    if (!windows.length) {
      conflicts.push({
        type: 'BRANCH_CLOSED',
        message: `The branch is closed on ${dateKey(item.startAt, branch.timezone)}`,
        startAt: item.startAt,
      });
      continue;
    }
    const startMin = timeToMinutes(dayjs(item.startAt).tz(branch.timezone).format('HH:mm'));
    const endMin = timeToMinutes(dayjs(item.endAt).tz(branch.timezone).format('HH:mm'));
    const insideHours = windows.some((w) => startMin >= timeToMinutes(w.open) && endMin <= timeToMinutes(w.close));
    if (!insideHours) {
      conflicts.push({
        type: 'BRANCH_CLOSED',
        message: 'This time falls outside branch opening hours',
        startAt: item.startAt,
      });
    }
  }

  // 3. The shop's own ceiling on how many people it takes at once.
  //
  // Checked here as well as when offering slots, because the slot list is a
  // suggestion and this is the gate. Without it, two people booking the last
  // place at the same moment both succeed, and anyone posting straight at the
  // API ignores the limit entirely.
  //
  // `force` skips every conflict, which is the point: the front desk can always
  // squeeze someone in, and only online booking is held to the number.
  {
    const from = new Date(Math.min(...items.map((i) => i.startAt.getTime())));
    const to = new Date(Math.max(...items.map((i) => i.endAt.getTime())));

    const cap = await effectiveCapacity(branch);
    const existing = await bookedIntervals(branchId, from, to, excludeAppointmentId);
    const taken = existing.filter((i) => overlaps(from, to, i.start, i.end)).length;

    if (taken >= cap) {
      conflicts.push({
        type: 'BRANCH_AT_CAPACITY',
        message: branch.maxConcurrentBookings
          ? `${branch.name} takes ${cap} at a time and already has ${taken} then`
          : `All ${cap} of ${branch.name}'s stylists are already booked then`,
        startAt: from,
      });
    }
  }

  // 4. Staff availability, time off and existing bookings.
  const staffIds = [...new Set(items.map((i) => i.staffId).filter((id): id is string => Boolean(id)))];
  if (staffIds.length) {
    const [staffRows, busy] = await Promise.all([
      prisma.staff.findMany({ where: { id: { in: staffIds } }, include: { availability: true } }),
      staffBusyIntervals(staffIds, from, to, excludeAppointmentId),
    ]);
    const staffById = new Map(staffRows.map((s) => [s.id, s]));

    for (const item of items) {
      if (!item.staffId) continue;
      const staff = staffById.get(item.staffId);
      if (!staff) {
        conflicts.push({ type: 'STAFF_UNAVAILABLE', message: 'Stylist not found', staffId: item.staffId, startAt: item.startAt });
        continue;
      }

      const weekday = dayOfWeek(item.startAt, branch.timezone);
      const startMin = timeToMinutes(dayjs(item.startAt).tz(branch.timezone).format('HH:mm'));
      const endMin = timeToMinutes(dayjs(item.endAt).tz(branch.timezone).format('HH:mm'));
      const worksNow = staff.availability.some(
        (a) => a.dayOfWeek === weekday && startMin >= timeToMinutes(a.startTime) && endMin <= timeToMinutes(a.endTime),
      );

      if (!worksNow) {
        conflicts.push({
          type: 'STAFF_UNAVAILABLE',
          message: `${staff.displayName} does not work at this time`,
          staffId: staff.id,
          startAt: item.startAt,
        });
      }

      if (!isFree(busy.get(item.staffId), item.startAt, item.endAt)) {
        conflicts.push({
          type: 'STAFF_BUSY',
          message: `${staff.displayName} already has a booking that overlaps this slot`,
          staffId: staff.id,
          startAt: item.startAt,
        });
      }
    }
  }

  // 5. Rooms and chairs.
  const resourceIds = [...new Set(items.map((i) => i.resourceId).filter((id): id is string => Boolean(id)))];
  if (resourceIds.length) {
    const busy = await resourceBusyIntervals(resourceIds, from, to, excludeAppointmentId);
    for (const item of items) {
      if (!item.resourceId) continue;
      if (!isFree(busy.get(item.resourceId), item.startAt, item.endAt)) {
        conflicts.push({
          type: 'RESOURCE_BUSY',
          message: 'The selected room or chair is already booked for this slot',
          resourceId: item.resourceId,
          startAt: item.startAt,
        });
      }
    }
  }

  return conflicts;
}

/** Capacity utilisation for a day: how much of the bookable time is sold. */
export async function utilisation(branchId: string, date: Date) {
  const tenantId = requireTenantId();
  assertBranchAccess(branchId);

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw NotFound('Branch');

  const weekday = dayOfWeek(date, branch.timezone);
  const windows = await branchOpeningWindows(branchId, date);
  const openMinutes = windows.reduce((acc, w) => acc + (timeToMinutes(w.close) - timeToMinutes(w.open)), 0);

  const staffList = await prisma.staff.findMany({
    where: { tenantId, branchId, isActive: true, isBookable: true },
    include: { availability: { where: { dayOfWeek: weekday } } },
  });

  const booked = await prisma.appointmentService.groupBy({
    by: ['staffId'],
    where: {
      branchId,
      startAt: { gte: startOfDay(date, branch.timezone), lte: endOfDay(date, branch.timezone) },
      appointment: { status: { in: ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] } },
    },
    _sum: { durationMin: true },
  });
  const bookedByStaff = new Map(booked.map((b) => [b.staffId, b._sum.durationMin ?? 0]));

  const rows = staffList.map((staff) => {
    const capacity = staff.availability.reduce(
      (acc, a) => acc + Math.min(timeToMinutes(a.endTime), openMinutes ? timeToMinutes(a.endTime) : 0) - timeToMinutes(a.startTime),
      0,
    );
    const used = bookedByStaff.get(staff.id) ?? 0;
    return {
      staffId: staff.id,
      name: staff.displayName,
      capacityMinutes: Math.max(capacity, 0),
      bookedMinutes: used,
      utilisationPct: capacity > 0 ? Number(((used / capacity) * 100).toFixed(1)) : 0,
    };
  });

  const capacityTotal = rows.reduce((a, r) => a + r.capacityMinutes, 0);
  const bookedTotal = rows.reduce((a, r) => a + r.bookedMinutes, 0);

  return {
    date: dateKey(date, branch.timezone),
    branchId,
    capacityMinutes: capacityTotal,
    bookedMinutes: bookedTotal,
    utilisationPct: capacityTotal > 0 ? Number(((bookedTotal / capacityTotal) * 100).toFixed(1)) : 0,
    idleMinutes: Math.max(capacityTotal - bookedTotal, 0),
    byStaff: rows,
  };
}

export type AppointmentWhere = Prisma.AppointmentWhereInput;
