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
