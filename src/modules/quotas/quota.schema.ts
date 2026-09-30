import { z } from 'zod';
import { idSchema } from '../../core/validators';

export const meterEnum = z.enum(['WA_UTILITY', 'WA_MARKETING', 'WA_AUTHENTICATION', 'SMS', 'EMAIL']);

export const paymentModeEnum = z.enum([
  'CASH',
  'CARD',
  'UPI',
  'CHEQUE',
  'BANK_TRANSFER',
  'OTHER',
]);

export const listPacksQuery = z.object({
  activeOnly: z.enum(['true', 'false']).optional(),
  planId: idSchema.optional(),
});

export const createPackSchema = z.object({
  code: z.string().trim().min(2).max(40).toUpperCase(),
  name: z.string().trim().min(2).max(80),
  meter: meterEnum,
  quantity: z.coerce.number().int().min(1).max(1_000_000),
  price: z.coerce.number().min(0),
  planId: idSchema.nullish(),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

export const updatePackSchema = createPackSchema.partial().extend({
  isActive: z.boolean().optional(),
});

/**
 * Recording a top-up. There is no gateway: the operator enters what was received
 * after the salon paid by UPI, transfer or cash, exactly as the salon's own POS
 * records what a customer handed over.
 */
export const grantCreditsSchema = z
  .object({
    packCode: z.string().trim().min(2).max(40).optional(),
    meter: meterEnum.optional(),
    quantity: z.coerce.number().int().optional(),
    amountPaid: z.coerce.number().min(0).optional(),
    paymentMode: paymentModeEnum.optional(),
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(240).optional(),
  })
  .refine((v) => Boolean(v.packCode) || (Boolean(v.meter) && typeof v.quantity === 'number'), {
    message: 'Give either a packCode, or a meter with a quantity',
  });

/**
 * How many months of history to return.
 *
 * Coerced rather than parsed as a string, because it arrives from a query
 * string where everything is text, and the service does arithmetic with it —
 * `"12" - 1` is the kind of bug that produces an empty screen and no error.
 * Capped at 24 here as well as in the service: a client asking for 500 months
 * should be told no by the validator, not quietly handed 24.
 */
export const usageHistoryQuery = z.object({
  months: z.coerce.number().int().min(1).max(24).optional(),
});
