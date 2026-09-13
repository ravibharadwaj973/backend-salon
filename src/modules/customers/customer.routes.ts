import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, paginationQuery } from '../../core/validators';
import * as service from './customer.service';
import type { CustomerInput, ImportRow, ListCustomersInput } from './customer.service';
import {
  birthdaysQuery,
  consentUpdateSchema,
  createCustomerSchema,
  hairProfileSchema,
  importCustomersSchema,
  listCustomersQuery,
  mergeCustomersSchema,
  noteSchema,
  photoSchema,
  updateCustomerSchema,
} from './customer.schema';
import type { LeadSource } from '@prisma/client';
import { PROFILE_LAYOUT_SETTING, normaliseLayout, visibleSections } from '../../core/customer-profile';
import { settingValue } from '../tenants/tenant.service';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ query: listCustomersQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listCustomers(req.query as unknown as ListCustomersInput);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ body: createCustomerSchema }),
  asyncHandler(async (req, res) => {
    const customer = await service.createCustomer(req.body as CustomerInput);
    audit({ action: 'customer.created', entity: 'Customer', entityId: customer.id });
    return created(res, customer);
  }),
);

router.get(
  '/export',
  requirePermission(PERMISSIONS.CUSTOMER_EXPORT),
  validate({ query: listCustomersQuery }),
  asyncHandler(async (req, res) => {
    const csv = await service.exportCustomers(req.query as unknown as ListCustomersInput);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${Date.now()}.csv"`);
    return res.send(csv);
  }),
);

router.post(
  '/import',
  requirePermission(PERMISSIONS.CUSTOMER_IMPORT),
  validate({ body: importCustomersSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { csv?: string; rows?: ImportRow[]; branchId?: string; source?: LeadSource; skipDuplicates?: boolean };
    const result = await service.importCustomers(body);
    audit({ action: 'customer.imported', entity: 'Customer', after: { imported: result.imported, skipped: result.skipped } });
    return ok(res, result);
  }),
);

/** Typeahead behind "have they been here before?" — see lookupCustomers. */
router.get(
  '/lookup',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({
    query: z.object({
      q: z.string().trim().min(1).max(120),
      limit: z.coerce.number().int().min(1).max(10).default(6),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    return ok(res, await service.lookupCustomers(q, limit));
  }),
);

router.get(
  '/birthdays',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ query: birthdaysQuery }),
  asyncHandler(async (req, res) =>
    ok(res, await service.birthdaysAndAnniversaries(req.query as unknown as { window?: 'today' | 'week' | 'month'; branchId?: string })),
  ),
);

router.get(
  '/inactive',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({
    query: paginationQuery.extend({
      days: z.coerce.number().int().min(1).max(730).default(45),
      minVisits: z.coerce.number().int().min(0).optional(),
      branchId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.inactiveCustomers(req.query as never);
    return ok(res, result);
  }),
);

router.post(
  '/merge',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ body: mergeCustomersSchema }),
  asyncHandler(async (req, res) => {
    const { sourceId, targetId } = req.body as { sourceId: string; targetId: string };
    const result = await service.mergeCustomers(sourceId, targetId);
    audit({ action: 'customer.merged', entity: 'Customer', entityId: targetId, before: { sourceId } });
    return ok(res, result);
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const profile = await service.getCustomerProfile(req.params.id!);

    // The page hides sections the owner turned off, but hiding is not enough
    // for money: what the layout says this person should not see, the API does
    // not send. A stylist's browser never holds the lifetime spend.
    const layout = normaliseLayout(await settingValue<unknown>(auth.tenantId, PROFILE_LAYOUT_SETTING, {}));
    const visible = new Set(visibleSections(auth.role, auth.permissions, layout));

    const trimmed: Record<string, unknown> & { stats: Record<string, unknown> } = {
      ...profile,
      sections: [...visible],
    };
    if (!visible.has('stats')) {
      trimmed.stats = { ...trimmed.stats, totalSpent: null, avgBill: null, outstanding: null };
      trimmed.totalSpent = null;
      trimmed.avgBill = null;
      trimmed.outstanding = null;
    }
    if (!visible.has('purchases')) trimmed.lastInvoice = null;
    if (!visible.has('loyalty')) {
      trimmed.stats = { ...trimmed.stats, loyaltyPoints: null, walletBalance: null };
      trimmed.loyaltyPoints = null;
      trimmed.walletBalance = null;
    }
    if (!visible.has('paidFor')) {
      trimmed.memberships = [];
      trimmed.packagePurchases = [];
    }
    if (!visible.has('preferences')) trimmed.hairProfile = null;
    if (!visible.has('feedback')) trimmed.recentFeedback = [];
    if (!visible.has('details')) {
      trimmed.dob = null;
      trimmed.anniversary = null;
      trimmed.addressLine = null;
      trimmed.city = null;
      trimmed.pincode = null;
      trimmed.referredBy = null;
    }

    return ok(res, trimmed);
  }),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam, body: updateCustomerSchema }),
  asyncHandler(async (req, res) => {
    const customer = await service.updateCustomer(req.params.id!, req.body as Partial<CustomerInput>);
    audit({ action: 'customer.updated', entity: 'Customer', entityId: customer.id, after: req.body });
    return ok(res, customer);
  }),
);

router.get(
  '/:id/history',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.getCustomerHistory(req.params.id!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/:id/invoices',
  requirePermission(PERMISSIONS.INVOICE_VIEW),
  validate({ params: idParam, query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listCustomerInvoices(req.params.id!, req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/:id/notes',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.listNotes(req.params.id!))),
);

router.post(
  '/:id/notes',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam, body: noteSchema }),
  asyncHandler(async (req, res) =>
    created(res, await service.addNote(req.params.id!, (req.body as { note: string }).note, req.auth!.userId)),
  ),
);

router.get(
  '/:id/photos',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.listPhotos(req.params.id!))),
);

router.post(
  '/:id/photos',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam, body: photoSchema }),
  asyncHandler(async (req, res) => created(res, await service.addPhoto(req.params.id!, req.body as never))),
);

router.put(
  '/:id/hair-profile',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam, body: hairProfileSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await service.upsertHairProfile(req.params.id!, req.body as Record<string, unknown>)),
  ),
);

router.put(
  '/:id/consent',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam, body: consentUpdateSchema }),
  asyncHandler(async (req, res) => {
    const customer = await service.updateConsent(req.params.id!, req.body as never);
    audit({ action: 'customer.consent_updated', entity: 'Customer', entityId: customer.id, after: req.body });
    return ok(res, customer);
  }),
);

router.post(
  '/:id/recalculate',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.recalculateCustomerRollups(req.params.id!);
    return ok(res, await service.refreshCustomerTier(req.params.id!));
  }),
);

export default router;
