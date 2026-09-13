import { z } from 'zod';
import { idSchema, moneySchema, paginationQuery, phoneSchema, searchQuery } from '../../core/validators';

export const bookingSourceSchema = z.enum([
  'WALK_IN',
  'PHONE',
  'RECEPTION',
  'ONLINE',
  'WHATSAPP',
  'QR',
  'APP',
  'INSTAGRAM',
  'IMPORT',
]);

const serviceLineSchema = z.object({
  serviceId: idSchema,
  staffId: idSchema.optional(),
  resourceId: idSchema.optional(),
  /** Optional explicit start; otherwise lines are chained back to back. */
  startAt: z.coerce.date().optional(),
  durationMin: z.coerce.number().int().min(5).max(600).optional(),
  price: moneySchema.optional(),
  discount: moneySchema.optional(),
  notes: z.string().trim().max(240).optional(),
});

export const createAppointmentSchema = z
  .object({
    branchId: idSchema.optional(),
    customerId: idSchema.optional(),
    walkInName: z.string().trim().min(1).max(120).optional(),
    walkInPhone: phoneSchema.optional(),
    startAt: z.coerce.date(),
    source: bookingSourceSchema.default('RECEPTION'),
    notes: z.string().trim().max(1000).optional(),
    internalNotes: z.string().trim().max(1000).optional(),
    services: z.array(serviceLineSchema).min(1).max(20),
    /** Book even if the slot conflicts (manager override). */
    force: z.boolean().default(false),
    sendConfirmation: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.customerId) || Boolean(v.walkInName), {
    message: 'Provide either customerId or walkInName',
    path: ['customerId'],
  });

export const updateAppointmentSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  internalNotes: z.string().trim().max(1000).optional(),
  services: z.array(serviceLineSchema).min(1).max(20).optional(),
  force: z.boolean().default(false),
});

export const rescheduleSchema = z.object({
  startAt: z.coerce.date(),
  staffId: idSchema.optional(),
  force: z.boolean().default(false),
  reason: z.string().trim().max(240).optional(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(240).optional(),
  notifyCustomer: z.boolean().default(true),
});

export const listAppointmentsQuery = searchQuery.extend({
  branchId: idSchema.optional(),
  customerId: idSchema.optional(),
  staffId: idSchema.optional(),
  status: z
    .enum(['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
    .optional(),
  source: bookingSourceSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  unbilled: z.enum(['true', 'false']).optional(),
});

export const calendarQuery = z.object({
  branchId: idSchema.optional(),
  date: z.coerce.date(),
  view: z.enum(['day', 'week']).default('day'),
  groupBy: z.enum(['staff', 'resource']).default('staff'),
  staffId: idSchema.optional(),
});

export const slotsQuery = z.object({
  branchId: idSchema,
  date: z.coerce.date(),
  serviceIds: z.union([z.string(), z.array(idSchema)]).transform((v) => (Array.isArray(v) ? v : v.split(','))),
  staffId: idSchema.optional(),
  excludeAppointmentId: idSchema.optional(),
});

export const walkInSchema = z.object({
  branchId: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
  services: z.array(serviceLineSchema).min(1).max(20),
  createCustomer: z.boolean().default(true),
  startAt: z.coerce.date().optional(),
});

export const recurringSchema = z.object({
  frequency: z.enum(['WEEKLY', 'MONTHLY']),
  interval: z.coerce.number().int().min(1).max(12).default(1),
  occurrences: z.coerce.number().int().min(2).max(52),
  appointment: createAppointmentSchema,
});

export const waitlistSchema = z.object({
  branchId: idSchema.optional(),
  customerId: idSchema,
  serviceId: idSchema.optional(),
  preferredStaffId: idSchema.optional(),
  preferredDate: z.coerce.date(),
  preferredFrom: z.string().max(5).optional(),
  preferredTo: z.string().max(5).optional(),
  notes: z.string().trim().max(240).optional(),
});

export const listWaitlistQuery = paginationQuery.extend({
  branchId: idSchema.optional(),
  status: z.enum(['WAITING', 'NOTIFIED', 'CONVERTED', 'EXPIRED', 'CANCELLED']).optional(),
  date: z.coerce.date().optional(),
});
