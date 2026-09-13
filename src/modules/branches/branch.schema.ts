import { z } from 'zod';
import { emailSchema, gstinSchema, idSchema, linkSchema, phoneSchema, pincodeSchema, searchQuery, timeSchema } from '../../core/validators';

const openingHoursSchema = z.record(
  z.string().regex(/^[0-6]$/),
  z.array(z.object({ open: timeSchema, close: timeSchema })),
);

export const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  stateCode: z.string().trim().max(4).optional(),
  pincode: pincodeSchema,
  gstin: gstinSchema,
  region: z.string().trim().max(80).optional(),
  timezone: z.string().default('Asia/Kolkata'),
  openingHours: openingHoursSchema.optional(),
  slotIntervalMin: z.coerce.number().int().min(5).max(60).default(15),
  invoicePrefix: z.string().trim().min(1).max(10).toUpperCase().default('INV'),
  /** Where a happy customer is sent to leave a public review. One listing per shop. */
  googleReviewUrl: linkSchema.optional(),
});

export const updateBranchSchema = createBranchSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const listBranchesQuery = searchQuery.extend({
  isActive: z.enum(['true', 'false']).optional(),
  region: z.string().trim().max(80).optional(),
});

export const createResourceSchema = z.object({
  branchId: idSchema,
  name: z.string().trim().min(1).max(80),
  type: z.enum(['CHAIR', 'ROOM', 'BED', 'STATION', 'EQUIPMENT']).default('CHAIR'),
  capacity: z.coerce.number().int().min(1).max(20).default(1),
});

export const updateResourceSchema = createResourceSchema.partial().omit({ branchId: true }).extend({
  isActive: z.boolean().optional(),
});

export const createHolidaySchema = z.object({
  branchId: idSchema.optional(),
  date: z.coerce.date(),
  name: z.string().trim().min(1).max(120),
});
