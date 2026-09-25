import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission, requireRole } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { dateRangeQuery, idParam, idSchema, paginationQuery } from '../../core/validators';
import * as billing from './billing.service';
import * as coupons from './coupon.service';
import * as taxSettings from './tax-settings.service';
import * as invoiceExport from './invoice-export.service';
import { parseFormat } from './invoice-series';
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

// ---------------------------------------------------------------- export ----
//
// Above '/:id' deliberately: Express matches in order, and below it these
// would be read as requests for an invoice whose id is "export".

const exportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: idSchema.optional(),
  financialYear: z.string().trim().regex(/^\d{2}-\d{2}$/, 'Use the form 25-26').optional(),
});

/**
 * Every bill in issue order, as a file for the accountant.
 *
 * Owner only, and by ROLE rather than by permission. This is the whole book of
 * account in one download — every sale, who billed it, and every voided number.
 * A manager who can legitimately void a single bill has no business taking the
 * lot off the premises.
 */
invoiceRouter.get(
  '/export',
  requireRole('OWNER'),
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    const { csv, count } = await invoiceExport.exportInvoices(req.query as never);
    const q = req.query as { financialYear?: string };
    const label = q.financialYear ? `fy-${q.financialYear}` : new Date().toISOString().slice(0, 10);
    // Audited: somebody taking the full sales book deserves a line in the log.
    audit({ action: 'invoice.exported', entity: 'Invoice', entityId: 'bulk', after: { count, filter: req.query } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-${label}.csv"`);
    return res.send(csv);
  }),
);

/** Gaps in the numbering, before somebody else finds them. */
invoiceRouter.get(
  '/series-audit',
  requireRole('OWNER'),
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => ok(res, await invoiceExport.seriesAudit(req.query as never))),
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


// ------------------------------------------------- tax & invoice settings ---

/**
 * WHO THE BUSINESS IS, AND WHAT ITS BILLS LOOK LIKE.
 *
 * Owner only, by role rather than by permission, and deliberately so. These are
 * not day-to-day settings: the registration status decides whether the salon may
 * charge GST at all, and the numbering format decides whether its invoices are
 * valid documents. A manager who can void a bill still should not be able to
 * change what every future bill is called.
 */
export const taxSettingsRouter = Router();
taxSettingsRouter.use(authenticate);

const seriesBody = z.object({
  prefix: z.string().trim().min(1).max(10),
  separator: z.enum(['/', '-', '']),
  includeFinancialYear: z.boolean(),
  padding: z.coerce.number().int().min(1).max(10),
  startFrom: z.coerce.number().int().min(1).max(9_999_999),
  reset: z.enum(['FINANCIAL_YEAR', 'NEVER']),
});

taxSettingsRouter.get(
  '/',
  requireRole('OWNER'),
  asyncHandler(async (_req, res) => ok(res, await taxSettings.getTaxSettings())),
);

taxSettingsRouter.put(
  '/identity',
  requireRole('OWNER'),
  validate({
    body: z.object({
      status: z.enum(['REGULAR', 'COMPOSITION', 'UNREGISTERED']),
      gstin: z.string().trim().max(20).optional(),
      legalName: z.string().trim().max(160).optional(),
      pan: z.string().trim().max(10).optional(),
      stateCode: z.string().trim().max(2).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const before = await taxSettings.getTaxSettings();
    const after = await taxSettings.updateTaxIdentity(req.body as never);
    audit({
      action: 'settings.updated',
      entity: 'Tenant',
      entityId: req.auth!.tenantId,
      before: { tax: before.identity },
      after: { tax: after.identity },
    });
    return ok(res, after);
  }),
);

taxSettingsRouter.put(
  '/series',
  requireRole('OWNER'),
  validate({ body: seriesBody }),
  asyncHandler(async (req, res) => {
    const before = await taxSettings.getTaxSettings();
    const after = await taxSettings.updateSeriesFormat(parseFormat(req.body));
    audit({
      action: 'settings.updated',
      entity: 'Tenant',
      entityId: req.auth!.tenantId,
      before: { series: before.series },
      after: { series: after.series },
    });
    return ok(res, after);
  }),
);

/** Try a format without saving it, so the owner reads the finished number first. */
taxSettingsRouter.post(
  '/series/preview',
  requireRole('OWNER'),
  validate({ body: seriesBody }),
  asyncHandler(async (req, res) => ok(res, taxSettings.previewFormat(parseFormat(req.body)))),
);

export default invoiceRouter;
