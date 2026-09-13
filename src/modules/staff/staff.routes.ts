import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requireAnyPermission, requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { dateRangeQuery, idParam, idSchema, paginationQuery } from '../../core/validators';
import { Forbidden } from '../../core/errors';
import { STAFF_PAGE, normaliseLayout, visibleSections } from '../../core/page-layouts';
import { settingValue } from '../tenants/tenant.service';
import * as staff from './staff.service';
import * as hr from './hr.service';
import type { StaffInput } from './staff.service';
import {
  attendanceSchema,
  availabilitySchema,
  createStaffSchema,
  leaveDecisionSchema,
  leaveRequestSchema,
  listStaffQuery,
  payrollGenerateSchema,
  staffServicesSchema,
  targetSchema,
  timeOffSchema,
  updateStaffSchema,
} from './staff.schema';
import type { AttendanceStatus, LeaveStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

// ------------------------------------------------------------- profiles ----

router.get(
  '/',
  requireAnyPermission(PERMISSIONS.STAFF_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ query: listStaffQuery }),
  asyncHandler(async (req, res) => {
    const result = await staff.listStaff(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ body: createStaffSchema }),
  asyncHandler(async (req, res) => {
    const member = await staff.createStaff(req.body as StaffInput);
    audit({ action: 'staff.created', entity: 'Staff', entityId: member.id, after: member });
    return created(res, member);
  }),
);

router.get(
  '/bookable',
  requireAnyPermission(PERMISSIONS.APPOINTMENT_VIEW, PERMISSIONS.APPOINTMENT_MANAGE, PERMISSIONS.STAFF_VIEW),
  validate({ query: z.object({ branchId: idSchema, serviceId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { branchId, serviceId } = req.query as unknown as { branchId: string; serviceId?: string };
    return ok(res, await staff.bookableStaff(branchId, serviceId));
  }),
);

router.get(
  '/leaderboard',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: dateRangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(20) }) }),
  asyncHandler(async (req, res) => ok(res, await staff.staffLeaderboard(req.query as never))),
);

// ----------------------------------------------------------- attendance ----

router.get(
  '/attendance',
  requirePermission(PERMISSIONS.ATTENDANCE_VIEW),
  validate({ query: paginationQuery.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), staffId: idSchema.optional(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await hr.listAttendance(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/attendance',
  requirePermission(PERMISSIONS.ATTENDANCE_MANAGE),
  validate({ body: attendanceSchema }),
  asyncHandler(async (req, res) =>
    created(res, await hr.markAttendance(req.body as { staffId: string; date: Date; status?: AttendanceStatus })),
  ),
);

router.get(
  '/attendance/summary',
  requirePermission(PERMISSIONS.ATTENDANCE_VIEW),
  validate({
    query: z.object({
      month: z.coerce.number().int().min(1).max(12),
      year: z.coerce.number().int().min(2020).max(2100),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await hr.attendanceSummary(req.query as never))),
);

router.post(
  '/attendance/punch',
  asyncHandler(async (req, res) => {
    const staffId = req.auth!.staffId;
    if (!staffId) throw Forbidden('Your login is not linked to a staff profile');
    const direction = (req.body as { direction?: 'IN' | 'OUT' }).direction ?? 'IN';
    return ok(res, await hr.punch(staffId, direction));
  }),
);

// ---------------------------------------------------------------- leave ----

router.get(
  '/leave',
  requirePermission(PERMISSIONS.ATTENDANCE_VIEW),
  validate({ query: paginationQuery.extend({ staffId: idSchema.optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await hr.listLeaveRequests(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/leave',
  validate({ body: leaveRequestSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { staffId: string; fromDate: Date; toDate: Date; reason?: string };
    // A stylist may only file leave for themselves.
    if (req.auth!.staffId && req.auth!.staffId !== body.staffId && !req.auth!.permissions.has(PERMISSIONS.ATTENDANCE_MANAGE)) {
      throw Forbidden('You can only request leave for yourself');
    }
    return created(res, await hr.requestLeave(body));
  }),
);

router.patch(
  '/leave/:id',
  requirePermission(PERMISSIONS.ATTENDANCE_MANAGE),
  validate({ params: idParam, body: leaveDecisionSchema }),
  asyncHandler(async (req, res) => {
    const { status } = req.body as { status: LeaveStatus };
    const result = await hr.decideLeave(req.params.id!, status, req.auth!.userId);
    audit({ action: `leave.${status.toLowerCase()}`, entity: 'LeaveRequest', entityId: req.params.id! });
    return ok(res, result);
  }),
);

// ---------------------------------------------------------- commissions ----

router.get(
  '/commissions',
  requirePermission(PERMISSIONS.COMMISSION_VIEW),
  validate({
    query: paginationQuery.extend({
      staffId: idSchema.optional(),
      branchId: idSchema.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      isPaid: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page?: number;
      pageSize?: number;
      staffId?: string;
      branchId?: string;
      from?: Date;
      to?: Date;
      isPaid?: string;
    };
    const result = await hr.listCommissions({
      page: q.page,
      pageSize: q.pageSize,
      staffId: q.staffId,
      branchId: q.branchId,
      from: q.from,
      to: q.to,
      isPaid: q.isPaid === undefined ? undefined : q.isPaid === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/commissions/summary',
  requirePermission(PERMISSIONS.COMMISSION_VIEW),
  validate({ query: dateRangeQuery }),
  asyncHandler(async (req, res) => ok(res, await hr.commissionSummary(req.query as never))),
);

router.post(
  '/commissions/pay',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE),
  validate({ body: z.object({ ids: z.array(idSchema).min(1).max(500), payrollId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { ids, payrollId } = req.body as { ids: string[]; payrollId?: string };
    return ok(res, await hr.markCommissionsPaid(ids, payrollId));
  }),
);

// -------------------------------------------------------------- payroll ----

router.get(
  '/payroll',
  requirePermission(PERMISSIONS.PAYROLL_VIEW),
  validate({ query: paginationQuery.extend({ branchId: idSchema.optional(), year: z.coerce.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await hr.listPayrolls(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/payroll/generate',
  requirePermission(PERMISSIONS.PAYROLL_MANAGE),
  validate({ body: payrollGenerateSchema }),
  asyncHandler(async (req, res) => {
    const payroll = await hr.generatePayroll(req.body as never);
    audit({ action: 'payroll.generated', entity: 'Payroll', entityId: payroll.id });
    return created(res, payroll);
  }),
);

router.get(
  '/payroll/:id',
  requirePermission(PERMISSIONS.PAYROLL_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await hr.getPayroll(req.params.id!))),
);

router.post(
  '/payroll/:id/approve',
  requirePermission(PERMISSIONS.PAYROLL_MANAGE),
  validate({ params: idParam, body: z.object({ markPaid: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const { markPaid } = req.body as { markPaid: boolean };
    const payroll = await hr.approvePayroll(req.params.id!, markPaid);
    audit({ action: markPaid ? 'payroll.paid' : 'payroll.approved', entity: 'Payroll', entityId: payroll.id });
    return ok(res, payroll);
  }),
);

// -------------------------------------------------------------- targets ----

router.post(
  '/targets',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ body: targetSchema }),
  asyncHandler(async (req, res) => created(res, await hr.setTarget(req.body as never))),
);

// -------------------------------------------------------- staff by id -----

/**
 * Looking at your own record is always allowed; looking at anyone else's needs
 * staff.view. Used by every per-person route below.
 */
function assertCanSee(req: { auth?: { permissions: Set<string>; staffId: string | null } }, id: string, permission: string) {
  const auth = req.auth!;
  if (auth.permissions.has(permission)) return;
  if (auth.permissions.has(PERMISSIONS.STAFF_SELF) && auth.staffId === id) return;
  throw Forbidden('You can only view your own record');
}

router.get(
  '/:id',
  requireAnyPermission(PERMISSIONS.STAFF_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    assertCanSee(req, req.params.id!, PERMISSIONS.STAFF_VIEW);
    const member = await staff.getStaff(req.params.id!);

    // Which sections this viewer gets: their permissions, the owner's layout,
    // and whether this is their own record. The page renders only these and
    // the money behind a hidden section is not sent.
    const layout = normaliseLayout(STAFF_PAGE, await settingValue<unknown>(auth.tenantId, STAFF_PAGE.settingKey, {}));
    const self = auth.staffId === req.params.id;
    const sections = visibleSections(STAFF_PAGE, { role: auth.role, permissions: auth.permissions, self }, layout);
    const visible = new Set(sections);
    const trimmed: Record<string, unknown> = { ...member, sections, isSelf: self };
    if (!visible.has('pay')) trimmed.baseSalary = null;
    if (!visible.has('earnings')) {
      trimmed.commissionRate = null;
      // The arrangement gives the number away nearly as well as the number.
      trimmed.commissionType = null;
    }
    return ok(res, trimmed);
  }),
);

// Per-person views. Each accepts the team-wide permission or, for your own
// record, staff.self — so a stylist sees their own hours and commission
// without being able to see anyone else's.

router.get(
  '/:id/attendance',
  requireAnyPermission(PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam, query: paginationQuery.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    assertCanSee(req, req.params.id!, PERMISSIONS.ATTENDANCE_VIEW);
    const q = req.query as unknown as { from?: Date; to?: Date; page?: number; pageSize?: number };
    const from = q.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = q.to ?? new Date();
    const [list, totals] = await Promise.all([
      hr.listAttendance({ staffId: req.params.id!, from, to, page: q.page, pageSize: q.pageSize }),
      hr.attendanceTotals(req.params.id!, from, to),
    ]);
    return ok(res, { period: { from, to }, totals, items: list.items, total: list.total });
  }),
);

router.get(
  '/:id/commissions',
  requireAnyPermission(PERMISSIONS.COMMISSION_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam, query: paginationQuery.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    assertCanSee(req, req.params.id!, PERMISSIONS.COMMISSION_VIEW);
    const q = req.query as unknown as { from?: Date; to?: Date; page?: number; pageSize?: number };
    const [all, unpaid] = await Promise.all([
      hr.listCommissions({ staffId: req.params.id!, from: q.from, to: q.to, page: q.page, pageSize: q.pageSize }),
      hr.listCommissions({ staffId: req.params.id!, isPaid: false, pageSize: 1 }),
    ]);
    return ok(res, { items: all.items, total: all.total, totalAmount: all.totalAmount, unpaidAmount: unpaid.totalAmount });
  }),
);

router.get(
  '/:id/payslips',
  requireAnyPermission(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    assertCanSee(req, req.params.id!, PERMISSIONS.PAYROLL_VIEW);
    const result = await hr.listPayslips(req.params.id!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/:id/leave',
  requireAnyPermission(PERMISSIONS.ATTENDANCE_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    assertCanSee(req, req.params.id!, PERMISSIONS.ATTENDANCE_VIEW);
    const result = await hr.listLeaveRequests({ staffId: req.params.id!, ...(req.query as object) });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam, body: updateStaffSchema }),
  asyncHandler(async (req, res) => {
    const member = await staff.updateStaff(req.params.id!, req.body as Partial<StaffInput>);
    audit({ action: 'staff.updated', entity: 'Staff', entityId: member.id, after: req.body });
    return ok(res, member);
  }),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await staff.deactivateStaff(req.params.id!))),
);

router.put(
  '/:id/services',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam, body: staffServicesSchema }),
  asyncHandler(async (req, res) => {
    const { services } = req.body as { services: { serviceId: string }[] };
    return ok(res, await staff.setStaffServices(req.params.id!, services));
  }),
);

router.put(
  '/:id/availability',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam, body: availabilitySchema }),
  asyncHandler(async (req, res) => {
    const { slots } = req.body as { slots: { dayOfWeek: number; startTime: string; endTime: string }[] };
    return ok(res, await staff.setAvailability(req.params.id!, slots));
  }),
);

router.post(
  '/:id/time-off',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam, body: timeOffSchema }),
  asyncHandler(async (req, res) =>
    created(res, await staff.addTimeOff(req.params.id!, req.body as { startAt: Date; endAt: Date; reason?: string })),
  ),
);

router.delete(
  '/time-off/:id',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await staff.removeTimeOff(req.params.id!);
    return noContent(res);
  }),
);

router.get(
  '/:id/performance',
  requireAnyPermission(PERMISSIONS.REPORT_VIEW, PERMISSIONS.STAFF_SELF),
  validate({ params: idParam, query: dateRangeQuery }),
  asyncHandler(async (req, res) => {
    if (!req.auth!.permissions.has(PERMISSIONS.REPORT_VIEW) && req.auth!.staffId !== req.params.id) {
      throw Forbidden('You can only view your own performance');
    }
    const { from, to } = req.query as unknown as { from?: Date; to?: Date };
    return ok(res, await staff.staffPerformance(req.params.id!, from, to));
  }),
);

export default router;
