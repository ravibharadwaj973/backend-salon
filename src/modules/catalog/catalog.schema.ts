import { z } from 'zod';
import { idSchema, moneySchema, searchQuery } from '../../core/validators';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const updateCategorySchema = createCategorySchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const createServiceSchema = z.object({
  categoryId: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(30).optional(),
  description: z.string().trim().max(1000).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).default('UNISEX'),
  durationMin: z.coerce.number().int().min(5).max(600).default(30),
  bufferMin: z.coerce.number().int().min(0).max(120).default(0),
  price: moneySchema,
  memberPrice: moneySchema.optional(),
  /**
   * Deliberately absent: taxRatePct.
   *
   * A service is a price, not a tax position. Whether GST applies is decided
   * on the bill — the salon may have no GSTIN at all, or may raise one bill
   * with GST and the next without — and the rate is the salon's single rate
   * in Settings. Asking for it here made every new service a small tax
   * decision the front desk had to get right in advance.
   */
  hsnSac: z.string().trim().max(12).optional(),
  commissionType: z.enum(['NONE', 'PERCENT_OF_SERVICE', 'PERCENT_OF_TOTAL', 'FLAT_PER_SERVICE', 'SLAB']).default('NONE'),
  commissionRate: z.coerce.number().min(0).max(100000).default(0),
  requiresResource: z.boolean().default(false),
  resourceType: z.enum(['CHAIR', 'ROOM', 'BED', 'STATION', 'EQUIPMENT']).optional(),
  onlineBookable: z.boolean().default(true),
  imageUrl: z.string().url().max(500).optional(),
});

export const updateServiceSchema = createServiceSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const listServicesQuery = searchQuery.extend({
  categoryId: idSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  onlineBookable: z.enum(['true', 'false']).optional(),
  staffId: idSchema.optional(),
});

export const consumptionSchema = z.object({
  items: z
    .array(
      z.object({
        productId: idSchema,
        quantity: z.coerce.number().positive().max(100000),
      }),
    )
    .max(50),
});
