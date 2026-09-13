import { z } from 'zod';
import { dayOfWeekSchema, emailSchema, idSchema, moneySchema, phoneSchema, searchQuery, timeSchema } from '../../core/validators';

export const createStaffSchema = z.object({
  branchId: idSchema,
  userId: idSchema.optional(),
  code: z.string().trim().max(20).optional(),
  displayName: z.string().trim().min(1).max(100),
  designation: z.string().trim().max(80).optional(),
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
  dob: z.coerce.date().optional(),
  joinedAt: z.coerce.date().optional(),
  specialities: z.array(z.string().trim().max(40)).max(20).default([]),
  isBookable: z.boolean().default(true),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  avatarUrl: z.string().url().max(500).optional(),
  baseSalary: moneySchema.default(0),
  commissionType: z.enum(['NONE', 'PERCENT_OF_SERVICE', 'PERCENT_OF_TOTAL', 'FLAT_PER_SERVICE', 'SLAB']).default('NONE'),
  commissionRate: z.coerce.number().min(0).max(100000).default(0),
  serviceIds: z.array(idSchema).max(300).optional(),
});

export const updateStaffSchema = createStaffSchema.partial().omit({ branchId: true }).extend({
  branchId: idSchema.optional(),
  isActive: z.boolean().optional(),
  exitedAt: z.coerce.date().optional(),
});

export const listStaffQuery = searchQuery.extend({
  branchId: idSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  isBookable: z.enum(['true', 'false']).optional(),
  serviceId: idSchema.optional(),
});

export const staffServicesSchema = z.object({
  services: z
    .array(
      z.object({
        serviceId: idSchema,
        priceOverride: moneySchema.optional(),
        durationOverrideMin: z.coerce.number().int().min(5).max(600).optional(),
      }),
    )
    .max(300),
});

export const availabilitySchema = z.object({
  slots: z
    .array(
      z.object({
        dayOfWeek: dayOfWeekSchema,
        startTime: timeSchema,
        endTime: timeSchema,
      }),
    )
    .max(60),
});

export const timeOffSchema = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  reason: z.string().trim().max(240).optional(),
});

export const attendanceSchema = z.object({
  staffId: idSchema,
  date: z.coerce.date(),
  status: z.enum(['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY']).default('PRESENT'),
  checkIn: z.coerce.date().optional(),
  checkOut: z.coerce.date().optional(),
  notes: z.string().trim().max(240).optional(),
});

export const leaveRequestSchema = z.object({
  staffId: idSchema,
  fromDate: z.coerce.date(),
  toDate: z.coerce.date(),
  reason: z.string().trim().max(240).optional(),
});

export const leaveDecisionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
});

export const targetSchema = z.object({
  staffId: idSchema,
  periodMonth: z.coerce.number().int().min(1).max(12),
  periodYear: z.coerce.number().int().min(2020).max(2100),
  revenueTarget: moneySchema,
  serviceCountTarget: z.coerce.number().int().min(0).default(0),
});

export const payrollGenerateSchema = z.object({
  branchId: idSchema,
  periodMonth: z.coerce.number().int().min(1).max(12),
  periodYear: z.coerce.number().int().min(2020).max(2100),
  incentives: z.record(moneySchema).optional(),
  deductions: z.record(moneySchema).optional(),
});
