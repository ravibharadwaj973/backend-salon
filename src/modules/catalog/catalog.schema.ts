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
  /**
   * Whether this price already contains the GST.
   *
   * Three answers, not two, which is why it is nullable rather than a plain
   * boolean: null is "use the salon's setting", and it is what almost every
   * service should say. Only the exceptions answer for themselves — the salon
   * whose treatments are quoted tax-inclusive but whose premium services are
   * quoted plus-tax, which one switch in Settings could not express.
   *
   * Unlike taxRatePct, which is deliberately absent above, this is NOT a tax
   * decision the front desk has to get right in advance. It is a statement about
   * the number already typed into the price box: does ₹800 mean ₹800 to the
   * customer, or ₹800 plus tax? Somebody setting the price knows that.
   */
  priceIncludesTax: z.boolean().nullable().optional(),
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
