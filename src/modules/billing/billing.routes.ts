import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { dateRangeQuery, idParam, idSchema, paginationQuery } from '../../core/validators';
import * as billing from './billing.service';
import * as coupons from './coupon.service';
import type { CreateInvoiceInput, PaymentInput } from './billing.service';
import type { CouponInput } from './coupon.service';
import {
  addPaymentSchema,
  advanceSchema,
  createCouponSchema,
  createInvoiceSchema,
  listInvoicesQuery,
  refundSchema,
  updateCouponSchema,
  voidSchema,
} from './billing.schema';
import type { PaymentMode } from '@prisma/client';

// ------------------------------------------------------------- invoices ----

export const invoiceRouter = Router();
invoiceRouter.use(authenticate);

invoiceRouter.get(
  '/',
  requirePermission(PERMISSIONS.INVOICE_VIEW),
  validate({ query: listInvoicesQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as Record<string, unknown> & { unpaidOnly?: string };
    const result = await billing.listInvoices({
      ...(q as Parameters<typeof billing.listInvoices>[0]),
      unpaidOnly: q.unpaidOnly === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

/** GST on/off by default, GSTIN present or not, prices inclusive or not — read before billing. */
invoiceRouter.get(
  '/billing-defaults',
  requirePermission(PERMISSIONS.INVOICE_CREATE),
  asyncHandler(async (req, res) =>
    ok(res, {
      ...(await billing.billingDefaults(req.auth!.tenantId)),
      canChooseGst: req.auth!.permissions.has(PERMISSIONS.INVOICE_GST_CHOICE),
    }),
  ),
);

invoiceRouter.post(
  '/',
  requirePermission(PERMISSIONS.INVOICE_CREATE),
  validate({ body: createInvoiceSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as CreateInvoiceInput;
    // Only staff with discount rights may knock money off a bill.
    if ((body.billDiscountValue ?? 0) > 0 && !req.auth!.permissions.has(PERMISSIONS.INVOICE_DISCOUNT)) {
      body.billDiscountValue = 0;
      body.billDiscountType = undefined;
    }
    // Choosing GST or no-GST per bill is its own permission; without it the
    // salon default applies whatever the request says.
    if (body.isGst !== undefined && !req.auth!.permissions.has(PERMISSIONS.INVOICE_GST_CHOICE)) {
      body.isGst = undefined;
    }
    const invoice = await billing.createInvoice(body);
    audit({ action: 'invoice.created', entity: 'Invoice', entityId: invoice.id, after: { total: invoice.grandTotal } });
    return created(res, invoice);
  }),
);

invoiceRouter.get(
  '/outstanding',
  requirePermission(PERMISSIONS.INVOICE_VIEW),
  validate({ query: paginationQuery.extend({ branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const result = await billing.outstandingInvoices(req.query as never);
    return ok(res, result);
  }),
);

invoiceRouter.get(
  '/collections',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ query: dateRangeQuery.extend({ date: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => ok(res, await billing.collectionSummary(req.query as never))),
);

invoiceRouter.get(
  '/gst-report',
  requirePermission(PERMISSIONS.REPORT_FINANCIAL),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await billing.gstReport(req.query as never))),
);

invoiceRouter.get(
  '/pos-context/:customerId',
  requirePermission(PERMISSIONS.INVOICE_CREATE),
  asyncHandler(async (req, res) => ok(res, await billing.posContext(req.params.customerId!))),
);

invoiceRouter.post(
  '/advance',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  validate({ body: advanceSchema }),
  asyncHandler(async (req, res) => {
    const result = await billing.addAdvance(req.body as { customerId: string; amount: number; mode: PaymentMode });
    audit({ action: 'payment.advance', entity: 'Payment', entityId: result.payment.id });
    return created(res, result);
  }),
);

invoiceRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.INVOICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await billing.getInvoice(req.params.id!))),
);

invoiceRouter.post(
  '/:id/payments',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  validate({ params: idParam, body: addPaymentSchema }),
  asyncHandler(async (req, res) => {
    const invoice = await billing.addPayment(req.params.id!, req.body as PaymentInput);
    audit({ action: 'payment.received', entity: 'Invoice', entityId: invoice.id, after: req.body });
    return ok(res, invoice);
  }),
);

invoiceRouter.post(
  '/:id/refund',
  requirePermission(PERMISSIONS.REFUND_MANAGE),
  validate({ params: idParam, body: refundSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { amount: number; mode: PaymentMode; reason?: string; toWallet: boolean };
    const refund = await billing.refundInvoice({ invoiceId: req.params.id!, ...body });
    audit({ action: 'invoice.refunded', entity: 'Invoice', entityId: req.params.id!, after: body });
    return created(res, refund);
  }),
);

invoiceRouter.post(
  '/:id/void',
  requirePermission(PERMISSIONS.INVOICE_VOID),
  validate({ params: idParam, body: voidSchema }),
  asyncHandler(async (req, res) => {
    const { reason } = req.body as { reason: string };
    const invoice = await billing.voidInvoice(req.params.id!, reason);
    audit({ action: 'invoice.voided', entity: 'Invoice', entityId: invoice.id, after: { reason } });
    return ok(res, invoice);
  }),
);

/** Take back a payment recorded by mistake; the bill's status follows the payments left. */
invoiceRouter.delete(
  '/:id/payments/:paymentId',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  validate({ params: idParam.extend({ paymentId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { invoice, removed } = await billing.removePayment(req.params.id!, req.params.paymentId!);
    audit({
      action: 'payment.removed',
      entity: 'Invoice',
      entityId: invoice.id,
      before: { paymentId: removed.id, mode: removed.mode, amount: removed.amount, reference: removed.reference },
      after: { status: invoice.status, paidAmount: invoice.paidAmount, dueAmount: invoice.dueAmount },
    });
    return ok(res, invoice);
  }),
);

/**
 * Remove a voided bill from the books. Audited with the whole bill in
 * `before`, so what was deleted is never a mystery.
 */
invoiceRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.INVOICE_DELETE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const invoice = await billing.deleteInvoice(req.params.id!);
    audit({
      action: 'invoice.deleted',
      entity: 'Invoice',
      entityId: invoice.id,
      before: {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        grandTotal: invoice.grandTotal,
        customerId: invoice.customerId,
        items: invoice.items.map((i) => ({ name: i.name, quantity: i.quantity, taxableValue: i.taxableValue })),
      },
    });
    return ok(res, { deleted: true, invoiceNumber: invoice.invoiceNumber });
  }),
);

// -------------------------------------------------------------- coupons ----

export const couponRouter = Router();
couponRouter.use(authenticate);

couponRouter.get(
  '/',
  requirePermission(PERMISSIONS.INVOICE_VIEW),
  validate({ query: paginationQuery.extend({ activeOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; activeOnly?: string };
    const result = await coupons.listCoupons({ ...q, activeOnly: q.activeOnly === 'true' });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

couponRouter.post(
  '/',
  requirePermission(PERMISSIONS.COUPON_MANAGE),
  validate({ body: createCouponSchema }),
  asyncHandler(async (req, res) => created(res, await coupons.createCoupon(req.body as CouponInput))),
);

couponRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.COUPON_MANAGE),
  validate({ params: idParam, body: updateCouponSchema }),
  asyncHandler(async (req, res) => ok(res, await coupons.updateCoupon(req.params.id!, req.body as Partial<CouponInput>))),
);

couponRouter.get(
  '/:id/performance',
  requirePermission(PERMISSIONS.REPORT_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await coupons.couponPerformance(req.params.id!))),
);

export default invoiceRouter;
