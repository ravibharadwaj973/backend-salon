import { z } from 'zod';
import { emailSchema, idSchema, paginationQuery, phoneSchema, pincodeSchema, searchQuery } from '../../core/validators';

export const genderSchema = z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']);

export const leadSourceSchema = z.enum([
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'GOOGLE',
  'WEBSITE',
  'PHONE',
  'WALK_IN',
  'REFERRAL',
  'MANUAL',
  'CSV_IMPORT',
  'CAMPAIGN',
  'OTHER',
]);

export const consentSchema = z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT']);

export const createCustomerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  phone: phoneSchema,
  altPhone: phoneSchema.optional(),
  email: emailSchema.optional(),
  gender: genderSchema.optional(),
  dob: z.coerce.date().optional(),
  anniversary: z.coerce.date().optional(),
  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  pincode: pincodeSchema,
  branchId: idSchema.optional(),
  source: leadSourceSchema.default('WALK_IN'),
  sourceDetail: z.string().trim().max(120).optional(),
  referredById: idSchema.optional(),
  preferredStaffId: idSchema.optional(),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  notes: z.string().trim().max(2000).optional(),
  whatsappConsent: consentSchema.default('UNKNOWN'),
  smsConsent: consentSchema.default('UNKNOWN'),
  emailConsent: consentSchema.default('UNKNOWN'),
});

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  isActive: z.boolean().optional(),
  isBlacklisted: z.boolean().optional(),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD', 'VIP']).optional(),
});

export const listCustomersQuery = searchQuery.extend({
  branchId: idSchema.optional(),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD', 'VIP']).optional(),
  tag: z.string().trim().max(40).optional(),
  source: leadSourceSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  hasMembership: z.enum(['true', 'false']).optional(),
  lastVisitBefore: z.coerce.date().optional(),
  lastVisitAfter: z.coerce.date().optional(),
  minVisits: z.coerce.number().int().min(0).optional(),
  minSpent: z.coerce.number().min(0).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
});

export const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) });

export const photoSchema = z.object({
  url: z.string().url().max(600),
  kind: z.enum(['BEFORE', 'AFTER', 'REFERENCE']).default('AFTER'),
  caption: z.string().trim().max(200).optional(),
  appointmentId: idSchema.optional(),
});

export const hairProfileSchema = z.object({
  hairType: z.string().trim().max(80).optional(),
  hairCondition: z.string().trim().max(120).optional(),
  scalpCondition: z.string().trim().max(120).optional(),
  colorBrand: z.string().trim().max(80).optional(),
  colorFormula: z.string().trim().max(300).optional(),
  lastColorAt: z.coerce.date().optional(),
  preferredStyle: z.string().trim().max(200).optional(),
  allergies: z.string().trim().max(400).optional(),
  sensitivities: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const consentUpdateSchema = z.object({
  whatsappConsent: consentSchema.optional(),
  smsConsent: consentSchema.optional(),
  emailConsent: consentSchema.optional(),
});

export const importCustomersSchema = z.object({
  branchId: idSchema.optional(),
  source: leadSourceSchema.default('CSV_IMPORT'),
  /** Raw CSV text with a header row, or an array of already-parsed rows. */
  csv: z.string().max(5_000_000).optional(),
  rows: z
    .array(
      z.object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().max(80).optional(),
        phone: z.string().trim().min(6).max(20),
        email: z.string().trim().max(160).optional(),
        gender: z.string().trim().max(10).optional(),
        dob: z.string().trim().max(20).optional(),
        tags: z.string().trim().max(200).optional(),
        notes: z.string().trim().max(500).optional(),
      }),
    )
    .max(20000)
    .optional(),
  skipDuplicates: z.boolean().default(true),
});

export const mergeCustomersSchema = z.object({
  sourceId: idSchema,
  targetId: idSchema,
});

export const birthdaysQuery = paginationQuery.extend({
  window: z.enum(['today', 'week', 'month']).default('week'),
  branchId: idSchema.optional(),
});
