import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery, percentSchema, searchQuery } from '../../core/validators';
import * as service from './inventory.service';
import type { ProductInput, PurchaseOrderInput } from './inventory.service';
import type { PurchaseOrderStatus, StockMovementType } from '@prisma/client';

const router = Router();
router.use(authenticate);

const productBody = z.object({
  name: z.string().trim().min(1).max(160),
  brandId: idSchema.optional(),
  categoryId: idSchema.optional(),
  sku: z.string().trim().max(60).optional(),
  shade: z.string().trim().max(60).optional(),
  unit: z.enum(['ml', 'g', 'pcs', 'l', 'kg']).default('ml'),
  packSize: z.coerce.number().positive().max(100000).default(1),
  costPrice: moneySchema.default(0),
  sellingPrice: moneySchema.default(0),
  taxRatePct: percentSchema.default(18),
  hsnSac: z.string().trim().max(12).optional(),
  isRetail: z.boolean().default(false),
  isConsumable: z.boolean().default(true),
  reorderLevel: z.coerce.number().min(0).max(100000).default(0),
  trackExpiry: z.boolean().default(false),
});

// reference data
router.get('/brands', requirePermission(PERMISSIONS.INVENTORY_VIEW), asyncHandler(async (_req, res) => ok(res, await service.listBrands())));

router.post(
  '/brands',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({ body: z.object({ name: z.string().trim().min(1).max(80) }) }),
  asyncHandler(async (req, res) => created(res, await service.createBrand((req.body as { name: string }).name))),
);

router.get(
  '/categories',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  asyncHandler(async (_req, res) => ok(res, await service.listProductCategories())),
);

router.post(
  '/categories',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({ body: z.object({ name: z.string().trim().min(1).max(80) }) }),
  asyncHandler(async (req, res) => created(res, await service.createProductCategory((req.body as { name: string }).name))),
);

// suppliers
router.get(
  '/suppliers',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ query: searchQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listSuppliers(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/suppliers',
  requirePermission(PERMISSIONS.SUPPLIER_MANAGE),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(160),
      contactName: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(20).optional(),
      email: z.string().email().optional(),
      gstin: z.string().trim().max(20).optional(),
      addressLine: z.string().trim().max(240).optional(),
      paymentTerms: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await service.createSupplier(req.body as never))),
);

router.patch(
  '/suppliers/:id',
  requirePermission(PERMISSIONS.SUPPLIER_MANAGE),
  validate({ params: idParam, body: z.record(z.unknown()) }),
  asyncHandler(async (req, res) => ok(res, await service.updateSupplier(req.params.id!, req.body as Record<string, unknown>))),
);

// stock views
router.get(
  '/stock',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ query: paginationQuery.extend({ branchId: idSchema.optional(), lowOnly: z.enum(['true', 'false']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page?: number; pageSize?: number; branchId?: string; lowOnly?: string };
    const result = await service.stockLevels({ ...q, lowOnly: q.lowOnly === 'true' });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/stock/low',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.lowStockAlerts(req.branchId))),
);

router.get(
  '/stock/valuation',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  asyncHandler(async (req, res) => ok(res, await service.stockValuation(req.branchId))),
);

router.get(
  '/stock/expiring',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(60), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { days, branchId } = req.query as unknown as { days: number; branchId?: string };
    return ok(res, await service.expiringBatches(days, branchId));
  }),
);

router.post(
  '/stock/adjust',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({
    body: z.object({
      branchId: idSchema.optional(),
      productId: idSchema,
      quantity: z.coerce.number(),
      type: z.enum(['OPENING', 'ADJUSTMENT', 'RETURN', 'TRANSFER_IN', 'TRANSFER_OUT']).default('ADJUSTMENT'),
      notes: z.string().trim().max(240).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const movement = await service.adjustStock(req.body as { productId: string; quantity: number; type?: StockMovementType });
    audit({ action: 'inventory.adjusted', entity: 'StockMovement', entityId: movement.id, after: req.body });
    return created(res, movement);
  }),
);

router.post(
  '/stock/wastage',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({
    body: z.object({
      branchId: idSchema.optional(),
      productId: idSchema,
      quantity: z.coerce.number().positive(),
      reason: z.string().trim().min(1).max(240),
    }),
  }),
  asyncHandler(async (req, res) => created(res, await service.recordWastage(req.body as never))),
);

router.get(
  '/movements',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({
    query: paginationQuery.extend({
      productId: idSchema.optional(),
      branchId: idSchema.optional(),
      type: z.enum(['OPENING', 'PURCHASE', 'CONSUMPTION', 'SALE', 'ADJUSTMENT', 'WASTAGE', 'RETURN', 'TRANSFER_IN', 'TRANSFER_OUT']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.listMovements(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.get(
  '/consumption-report',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.consumptionReport(req.query as never))),
);

// purchase orders
router.get(
  '/purchase-orders',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({
    query: paginationQuery.extend({
      branchId: idSchema.optional(),
      supplierId: idSchema.optional(),
      status: z.enum(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.listPurchaseOrders(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/purchase-orders',
  requirePermission(PERMISSIONS.PURCHASE_MANAGE),
  validate({
    body: z.object({
      branchId: idSchema.optional(),
      supplierId: idSchema,
      expectedAt: z.coerce.date().optional(),
      notes: z.string().trim().max(500).optional(),
      invoiceRef: z.string().trim().max(80).optional(),
      items: z
        .array(
          z.object({
            productId: idSchema,
            quantity: z.coerce.number().positive().max(100000),
            unitCost: moneySchema,
            taxRatePct: percentSchema.default(18),
            batchNo: z.string().trim().max(60).optional(),
            expiryDate: z.coerce.date().optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const po = await service.createPurchaseOrder(req.body as PurchaseOrderInput);
    audit({ action: 'purchase_order.created', entity: 'PurchaseOrder', entityId: po.id });
    return created(res, po);
  }),
);

router.get(
  '/purchase-orders/:id',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getPurchaseOrder(req.params.id!))),
);

router.post(
  '/purchase-orders/:id/receive',
  requirePermission(PERMISSIONS.PURCHASE_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      items: z.array(z.object({ itemId: idSchema, receivedQty: z.coerce.number().min(0) })).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items } = req.body as { items?: { itemId: string; receivedQty: number }[] };
    const po = await service.receivePurchaseOrder(req.params.id!, items);
    audit({ action: 'purchase_order.received', entity: 'PurchaseOrder', entityId: po.id });
    return ok(res, po);
  }),
);

router.post(
  '/purchase-orders/:id/cancel',
  requirePermission(PERMISSIONS.PURCHASE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.cancelPurchaseOrder(req.params.id!))),
);

// products
router.get(
  '/products',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({
    query: searchQuery.extend({
      brandId: idSchema.optional(),
      categoryId: idSchema.optional(),
      branchId: idSchema.optional(),
      isRetail: z.enum(['true', 'false']).optional(),
      lowStockOnly: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as Record<string, unknown> & { lowStockOnly?: string };
    const result = await service.listProducts({
      ...(q as Parameters<typeof service.listProducts>[0]),
      lowStockOnly: q.lowStockOnly === 'true',
    });
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/products',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({ body: productBody }),
  asyncHandler(async (req, res) => {
    const product = await service.createProduct(req.body as ProductInput);
    audit({ action: 'product.created', entity: 'Product', entityId: product.id });
    return created(res, product);
  }),
);

router.get(
  '/products/:id',
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getProduct(req.params.id!))),
);

router.patch(
  '/products/:id',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  validate({ params: idParam, body: productBody.partial().extend({ isActive: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.updateProduct(req.params.id!, req.body as Partial<ProductInput>))),
);

export default router;
