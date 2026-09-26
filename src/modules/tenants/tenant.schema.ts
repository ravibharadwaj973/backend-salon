import { z } from 'zod';
import { emailSchema, gstinSchema, idSchema, paginationQuery, phoneSchema, pincodeSchema } from '../../core/validators';

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug may contain lowercase letters, numbers and hyphens only')
    .min(3)
    .max(48)
    .optional(),
  legalName: z.string().trim().max(160).optional(),
  gstin: gstinSchema,
  phone: phoneSchema,
  email: emailSchema,
  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  stateCode: z.string().trim().max(4).optional(),
  pincode: pincodeSchema,
  currency: z.string().length(3).default('INR'),
  timezone: z.string().default('Asia/Kolkata'),
  planCode: z.string().trim().max(40).optional(),
  trialDays: z.coerce.number().int().min(0).max(90).default(14),
  owner: z.object({
    name: z.string().trim().min(2).max(120),
    email: emailSchema,
    phone: phoneSchema.optional(),
    password: z.string().min(8).max(128),
  }),
  branch: z
    .object({
      name: z.string().trim().min(1).max(120).default('Main Branch'),
      code: z.string().trim().min(1).max(20).default('MAIN'),
      phone: phoneSchema.optional(),
      addressLine: z.string().trim().max(240).optional(),
      city: z.string().trim().max(80).optional(),
    })
    .optional(),
  seedDefaults: z.boolean().default(true),
});

export const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().max(160).optional(),
  gstin: gstinSchema,
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  addressLine: z.string().trim().max(240).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  stateCode: z.string().trim().max(4).optional(),
  pincode: pincodeSchema,
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  logoUrl: z.string().url().max(500).optional(),
  /**
   * The salon's own website.
   *
   * Validated as a real URL rather than taken as typed, because it does two
   * jobs where a near-miss fails quietly: it builds {{website_link}} and
   * {{gallery_link}} for messages, and it is the allow-list deciding which
   * redirect targets may carry an arrival token. "glowstudio.in" with no
   * scheme would match no origin, so tracking would simply never work and
   * nobody would know why.
   *
   * Empty string clears it — a salon that takes their site down needs a way
   * to say so, and a field that can only ever be set is a field people work
   * around.
   */
  websiteUrl: z.union([z.string().url().max(300), z.literal('')]).optional(),
  settings: z.record(z.unknown()).optional(),
});

export const tenantStatusSchema = z.object({
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']),
  reason: z.string().max(240).optional(),
});

export const listTenantsQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(),
});

export const assignPlanSchema = z.object({
  planCode: z.string().trim().min(1).max(40),
  months: z.coerce.number().int().min(1).max(36).default(1),
  amount: z.coerce.number().min(0).optional(),
});

export const listPlansQuery = z.object({
  activeOnly: z.enum(['true', 'false']).optional(),
});

export const createPlanSchema = z.object({
  code: z.string().trim().min(2).max(40).toUpperCase(),
  name: z.string().trim().min(2).max(80),
  pricePerMonth: z.coerce.number().min(0),
  pricePerYear: z.coerce.number().min(0).optional(),
  maxBranches: z.coerce.number().int().min(1).max(500).default(1),
  maxStaff: z.coerce.number().int().min(1).max(5000).default(10),
  maxCustomers: z.coerce.number().int().min(1).max(1_000_000).default(5000),
  waUtilityQuota: z.coerce.number().int().min(0).max(1_000_000).default(500),
  waMarketingQuota: z.coerce.number().int().min(0).max(1_000_000).default(0),
  waAuthQuota: z.coerce.number().int().min(0).max(1_000_000).default(0),
  smsQuota: z.coerce.number().int().min(0).max(1_000_000).default(250),
  emailQuota: z.coerce.number().int().min(0).max(1_000_000).default(2000),
  maxCampaignsPerMonth: z.coerce.number().int().min(0).max(1_000_000).default(3),
  extraBranchPrice: z.coerce.number().min(0).nullish(),
  features: z.record(z.boolean()).optional(),
});

export const updatePlanSchema = createPlanSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const settingSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.unknown(),
  branchId: idSchema.optional(),
});
