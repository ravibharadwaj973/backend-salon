import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requireAnyPermission, requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema } from '../../core/validators';
import { Forbidden } from '../../core/errors';
import * as service from './appointment.service';
import * as availability from './availability.service';
import type { CreateAppointmentInput, ServiceLineInput } from './appointment.service';
import {
  calendarQuery,
  cancelSchema,
  createAppointmentSchema,
  listAppointmentsQuery,
  listWaitlistQuery,
  recurringSchema,
  rescheduleSchema,
  slotsQuery,
  updateAppointmentSchema,
  waitlistSchema,
  walkInSchema,
} from './appointment.schema';
import type { AppointmentStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

const canView = requireAnyPermission(PERMISSIONS.APPOINTMENT_VIEW, PERMISSIONS.APPOINTMENT_VIEW_OWN);

router.get(
  '/',
  canView,
  validate({ query: listAppointmentsQuery }),
  asyncHandler(async (req, res) => {
    const query = req.query as never as Parameters<typeof service.listAppointments>[0];
    // A stylist only ever sees their own column.
    if (!req.auth!.permissions.has(PERMISSIONS.APPOINTMENT_VIEW)) {
      if (!req.auth!.staffId) throw Forbidden('Your login is not linked to a staff profile');
      query.staffId = req.auth!.staffId;
    }
    const result = await service.listAppointments(query);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ body: createAppointmentSchema }),
  asyncHandler(async (req, res) => {
    const appointment = await service.createAppointment(req.body as CreateAppointmentInput);
    audit({ action: 'appointment.created', entity: 'Appointment', entityId: appointment.id, branchId: appointment.branchId });
    return created(res, appointment);
  }),
);

router.get(
  '/calendar',
  canView,
  validate({ query: calendarQuery }),
  asyncHandler(async (req, res) => {
    const query = req.query as never as Parameters<typeof service.calendar>[0];
    if (!req.auth!.permissions.has(PERMISSIONS.APPOINTMENT_VIEW) && req.auth!.staffId) {
      query.staffId = req.auth!.staffId;
    }
    return ok(res, await service.calendar(query));
  }),
);

router.get(
  '/slots',
  canView,
  validate({ query: slotsQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      branchId: string;
      date: Date;
      serviceIds: string[];
      staffId?: string;
      excludeAppointmentId?: string;
    };
    return ok(res, await availability.availableSlots(q));
  }),
);

router.get(
  '/utilisation',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: z.object({ branchId: idSchema, date: z.coerce.date() }) }),
  asyncHandler(async (req, res) => {
    const { branchId, date } = req.query as unknown as { branchId: string; date: Date };
    return ok(res, await availability.utilisation(branchId, date));
  }),
);

router.get(
  '/today',
  canView,
  // A date may be given, so the dashboard's appointment panel follows whichever
  // day is being looked at rather than always showing today's.
  validate({ query: z.object({ date: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) =>
    ok(res, await service.todaySummary(req.branchId, (req.query as { date?: Date }).date)),
  ),
);

router.post(
  '/walk-in',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ body: walkInSchema }),
  asyncHandler(async (req, res) => {
    const appointment = await service.createWalkIn(req.body as never);
    audit({ action: 'appointment.walk_in', entity: 'Appointment', entityId: appointment.id });
    return created(res, appointment);
  }),
);

router.post(
  '/recurring',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ body: recurringSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      frequency: 'WEEKLY' | 'MONTHLY';
      interval: number;
      occurrences: number;
      appointment: CreateAppointmentInput;
    };
    return created(res, await service.createRecurring(body));
  }),
);

// ------------------------------------------------------------- waitlist ----

router.get(
  '/waitlist',
  canView,
  validate({ query: listWaitlistQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listWaitlist(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/waitlist',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ body: waitlistSchema }),
  asyncHandler(async (req, res) => created(res, await service.addToWaitlist(req.body as never))),
);

router.patch(
  '/waitlist/:id',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['WAITING', 'NOTIFIED', 'CONVERTED', 'EXPIRED', 'CANCELLED']) }),
  }),
  asyncHandler(async (req, res) => {
    const { status } = req.body as { status: 'WAITING' | 'NOTIFIED' | 'CONVERTED' | 'EXPIRED' | 'CANCELLED' };
    return ok(res, await service.updateWaitlistStatus(req.params.id!, status));
  }),
);

// --------------------------------------------------------- single record ---

router.get(
  '/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getAppointment(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ params: idParam, body: updateAppointmentSchema }),
  asyncHandler(async (req, res) => {
    const appointment = await service.updateAppointment(
      req.params.id!,
      req.body as { notes?: string; services?: ServiceLineInput[]; force?: boolean },
    );
    audit({ action: 'appointment.updated', entity: 'Appointment', entityId: appointment.id });
    return ok(res, appointment);
  }),
);

router.post(
  '/:id/reschedule',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({ params: idParam, body: rescheduleSchema }),
  asyncHandler(async (req, res) => {
    const appointment = await service.rescheduleAppointment(req.params.id!, req.body as never);
    audit({ action: 'appointment.rescheduled', entity: 'Appointment', entityId: appointment.id, after: req.body });
    return ok(res, appointment);
  }),
);

router.post(
  '/:id/status',
  requirePermission(PERMISSIONS.APPOINTMENT_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW']),
      reason: z.string().trim().max(240).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, reason } = req.body as { status: AppointmentStatus; reason?: string };
    const appointment = await service.changeStatus(req.params.id!, status, { reason });
    audit({ action: `appointment.${status.toLowerCase()}`, entity: 'Appointment', entityId: appointment.id });
    return ok(res, appointment);
  }),
);

router.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.APPOINTMENT_CANCEL),
  validate({ params: idParam, body: cancelSchema }),
  asyncHandler(async (req, res) => {
    const { reason, notifyCustomer } = req.body as { reason?: string; notifyCustomer: boolean };
    const appointment = await service.changeStatus(req.params.id!, 'CANCELLED', { reason, notifyCustomer });
    audit({ action: 'appointment.cancelled', entity: 'Appointment', entityId: appointment.id, after: { reason } });
    return ok(res, appointment);
  }),
);

export default router;
// Owner login       : owner@glowstudio.in / Salon@12345
  // Manager login     : manager@glowstudio.in / Salon@12345
  // Receptionist      : reception@glowstudio.in / Salon@12345
  // Accountant        : accounts@glowstudio.in / Salon@12345
  // Platform admin    : admin@salonos.in / Admin@12345