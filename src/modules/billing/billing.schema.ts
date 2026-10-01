import { z } from 'zod';
import { idSchema, moneySchema, percentSchema, searchQuery } from '../../core/validators';

/**
 * How the money was received at the counter — a record, not a transaction.
 * There is no payment gateway: nothing in this system charges a card, opens a
 * checkout, or confirms a payment on its own.
 */
export const paymentModeSchema = z.enum([
  'CASH',
  'CARD',            // the salon's own card machine
  'UPI',             // the salon's own QR / VPA
  'CHEQUE',
  'BANK_TRANSFER',
  'WALLET',          // customer's prepaid balance held in this system
  'MEMBERSHIP',      // settled by a membership benefit
  'PACKAGE',         // settled by a prepaid package session
  'LOYALTY_POINTS',
  'ADVANCE',
  'CREDIT',          // "pay next time" — leaves an outstanding balance
  'OTHER',
]);

const invoiceItemSchema = z.object({
  itemType: z.enum(['SERVICE', 'PRODUCT', 'PACKAGE', 'MEMBERSHIP', 'ADJUSTMENT']),
  refId: idSchema.optional(),
  name: z.string().trim().max(160).optional(),
  staffId: idSchema.optional(),
  /**
   * Everyone who performed this service, primary first.
   *
   * Capped at four. Not an arbitrary number: beyond three or four names on one
   * service the commission on each share is small enough that the salon is
   * better off billing the work as separate lines, and an uncapped array here is
   * an invitation to send a thousand ids and make the till write a thousand rows.
   */
  staffIds: z.array(idSchema).max(4).optional(),
  quantity: z.coerce.number().positive().max(1000).default(1),
  unitPrice: moneySchema.optional(),
  discount: moneySchema.optional(),
  taxRatePct: percentSchema.optional(),
  redeemFrom: z.enum(['NONE', 'PACKAGE', 'MEMBERSHIP', 'LOYALTY']).default('NONE'),
  packagePurchaseItemId: idSchema.optional(),
  membershipSubscriptionId: idSchema.optional(),
});

const paymentSchema = z.object({
  mode: paymentModeSchema,
  amount: moneySchema,
  reference: z.string().trim().max(120).optional(),
  isAdvance: z.boolean().default(false),
  notes: z.string().trim().max(240).optional(),
});

export const createInvoiceSchema = z.object({
  branchId: idSchema.optional(),
  customerId: idSchema.optional(),
  appointmentId: idSchema.optional(),
  items: z.array(invoiceItemSchema).max(60).optional(),
  billDiscountType: z.enum(['PERCENT', 'FLAT']).optional(),
  billDiscountValue: moneySchema.optional(),
  discountReason: z.string().trim().max(240).optional(),
  couponCode: z.string().trim().max(40).optional(),
  loyaltyPointsToRedeem: z.coerce.number().int().min(0).max(1_000_000).optional(),
  useWalletAmount: moneySchema.optional(),
  payments: z.array(paymentSchema).max(6).optional(),
  isGst: z.boolean().optional(),
  placeOfSupply: z.string().trim().max(4).optional(),
  notes: z.string().trim().max(1000).optional(),
  applyMembershipDiscount: z.boolean().default(true),
  sendInvoice: z.boolean().default(true),
});

export const listInvoicesQuery = searchQuery.extend({
  branchId: idSchema.optional(),
  customerId: idSchema.optional(),
  staffId: idSchema.optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'REFUNDED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  unpaidOnly: z.enum(['true', 'false']).optional(),
});

export const addPaymentSchema = paymentSchema;

/**
 * Checking a discount code against the bill being built.
 *
 * The subtotal and the bill discount come from the unsaved cart, so they are
 * taken from the request — there is no invoice to read them off yet. They only
 * decide what the preview SAYS; the authoritative figures are recomputed from
 * the catalogue when the bill is actually saved, so a client that sends a
 * flattering subtotal gets a flattering preview and the same honest invoice.
 */
export const validateCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  subtotal: moneySchema,
  billDiscount: moneySchema.optional(),
  customerId: idSchema.optional(),
});

export const advanceSchema = z.object({
  customerId: idSchema,
  amount: moneySchema,
  mode: paymentModeSchema,
  reference: z.string().trim().max(120).optional(),
  branchId: idSchema.optional(),
});

export const refundSchema = z.object({
  amount: moneySchema,
  mode: paymentModeSchema.default('CASH'),
  reason: z.string().trim().max(240).optional(),
  toWallet: z.boolean().default(false),
});

export const voidSchema = z.object({
  reason: z.string().trim().min(3).max(240),
});

/**
 * Who performed a service on a bill that is already saved.
 *
 * `null` is a meaningful value, not a missing one — it is how the front desk
 * takes a name OFF a line that was attributed to the wrong person, so it is
 * `nullable()` rather than `optional()`. An absent key would be ambiguous
 * between "clear it" and "leave it alone", and the two have opposite effects on
 * somebody's commission.
 */
export const setItemStaffSchema = z.object({
  /**
   * The full cast for this line, primary first. An empty array takes every name
   * off it — that is a meaningful instruction, not a missing field, which is why
   * the array is required rather than optional.
   */
  staffIds: z.array(idSchema).max(4),
});

export const createCouponSchema = z.object({
  code: z.string().trim().min(3).max(24).toUpperCase(),
  description: z.string().trim().max(240).optional(),
  discountType: z.enum(['PERCENT', 'FLAT']).default('PERCENT'),
  value: moneySchema,
  maxDiscount: moneySchema.optional(),
  minBillAmount: moneySchema.default(0),
  applicableServiceIds: z.array(idSchema).max(200).default([]),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  usageLimit: z.coerce.number().int().min(1).optional(),
  perCustomerLimit: z.coerce.number().int().min(0).max(50).default(1),
});

export const updateCouponSchema = createCouponSchema.partial().extend({ isActive: z.boolean().optional() });
