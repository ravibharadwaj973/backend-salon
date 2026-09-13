import type { Prisma, PurchaseOrderStatus, StockMovementType } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { currentUserId, requireTenantId } from '../../core/context';
import { assertBranchAccess, branchFilter, requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, mul, pct, round2, sub } from '../../core/money';
import { dayjs, dateOnly } from '../../core/dates';
import { sequenceNumber } from '../../core/ids';
import { recordMovement } from './stock.service';

// ------------------------------------------------------- reference data ----

export async function listBrands() {
  const tenantId = requireTenantId();
  return prisma.brand.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
}

export async function createBrand(name: string) {
  const tenantId = requireTenantId();
  const clash = await prisma.brand.findFirst({ where: { tenantId, name } });
  if (clash) throw Conflict('This brand already exists');
  return prisma.brand.create({ data: { tenantId, name } });
}

export async function listProductCategories() {
  const tenantId = requireTenantId();
  return prisma.productCategory.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
}

export async function createProductCategory(name: string) {
  const tenantId = requireTenantId();
  const clash = await prisma.productCategory.findFirst({ where: { tenantId, name } });
  if (clash) throw Conflict('This product category already exists');
  return prisma.productCategory.create({ data: { tenantId, name } });
}

export async function listSuppliers(input: { page?: number; pageSize?: number; q?: string }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.SupplierWhereInput = {
    tenantId,
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { phone: { contains: input.q } },
            { gstin: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      include: { _count: { select: { purchaseOrders: true } } },
    }),
    prisma.supplier.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function createSupplier(input: {
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  gstin?: string;
  addressLine?: string;
  paymentTerms?: string;
}) {
  const tenantId = requireTenantId();
  const clash = await prisma.supplier.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A supplier with this name already exists');
  return prisma.supplier.create({ data: { tenantId, ...input } });
}

export async function updateSupplier(id: string, input: Record<string, unknown>) {
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) throw NotFound('Supplier');
  return prisma.supplier.update({ where: { id }, data: input as Prisma.SupplierUpdateInput });
}

// ------------------------------------------------------------- products ----

export interface ProductInput {
  name: string;
  brandId?: string;
  categoryId?: string;
  sku?: string;
  shade?: string;
  unit?: string;
  packSize?: number;
  costPrice?: number;
  sellingPrice?: number;
  taxRatePct?: number;
  hsnSac?: string;
  isRetail?: boolean;
  isConsumable?: boolean;
  reorderLevel?: number;
  trackExpiry?: boolean;
  isActive?: boolean;
}

export async function listProducts(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  brandId?: string;
  categoryId?: string;
  branchId?: string;
  isRetail?: string;
  lowStockOnly?: boolean;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.ProductWhereInput = {
    tenantId,
    isActive: true,
    ...(input.brandId ? { brandId: input.brandId } : {}),
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.isRetail ? { isRetail: input.isRetail === 'true' } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { sku: { contains: input.q, mode: 'insensitive' as const } },
            { shade: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      include: {
        brand: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        stocks: input.branchId ? { where: { branchId: input.branchId } } : true,
      },
    }),
    prisma.product.count({ where }),
  ]);

  const withStock = items.map((product) => {
    const quantity = product.stocks.reduce<Prisma.Decimal>((acc, s) => add(acc, s.quantity), d(0));
    return {
      ...product,
      totalQuantity: quantity,
      isLowStock: d(product.reorderLevel).greaterThan(0) && quantity.lessThanOrEqualTo(product.reorderLevel),
    };
  });

  return {
    items: input.lowStockOnly ? withStock.filter((p) => p.isLowStock) : withStock,
    total,
    page,
    pageSize,
  };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      brand: true,
      category: true,
      stocks: { include: { branch: { select: { id: true, name: true } } } },
      batches: { where: { quantity: { gt: 0 } }, orderBy: { expiryDate: 'asc' } },
      consumption: { include: { service: { select: { id: true, name: true } } } },
    },
  });
  if (!product) throw NotFound('Product');
  return product;
}

export async function createProduct(input: ProductInput) {
  const tenantId = requireTenantId();
  const clash = await prisma.product.findFirst({
    where: { tenantId, name: input.name, shade: input.shade ?? null },
  });
  if (clash) throw Conflict('This product (and shade) already exists');
  return prisma.product.create({ data: { tenantId, ...input } });
}

export async function updateProduct(id: string, input: Partial<ProductInput>) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw NotFound('Product');
  return prisma.product.update({ where: { id }, data: input });
}

// ---------------------------------------------------------------- stock ----

export async function stockLevels(input: { branchId?: string; lowOnly?: boolean; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.StockWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    product: { isActive: true },
  };

  const [rows, total] = await Promise.all([
    prisma.stock.findMany({
      where,
      skip,
      take,
      orderBy: { quantity: 'asc' },
      include: {
        product: { include: { brand: { select: { name: true } } } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.stock.count({ where }),
  ]);

  const items = rows
    .map((row) => ({
      productId: row.productId,
      productName: row.product.name,
      shade: row.product.shade,
      brand: row.product.brand?.name ?? null,
      unit: row.product.unit,
      branch: row.branch,
      quantity: row.quantity,
      reorderLevel: row.product.reorderLevel,
      isLow: d(row.product.reorderLevel).greaterThan(0) && d(row.quantity).lessThanOrEqualTo(row.product.reorderLevel),
      value: round2(mul(row.quantity, row.product.costPrice)),
    }))
    .filter((row) => (input.lowOnly ? row.isLow : true));

  return { items, total, page, pageSize };
}

export async function adjustStock(input: {
  branchId?: string;
  productId: string;
  quantity: number;
  type?: StockMovementType;
  notes?: string;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product) throw NotFound('Product');
  if (input.quantity === 0) throw BadRequest('Adjustment quantity cannot be zero');

  return recordMovement(prisma, {
    tenantId,
    branchId,
    productId: input.productId,
    type: input.type ?? 'ADJUSTMENT',
    quantity: input.quantity,
    unitCost: product.costPrice,
    notes: input.notes,
    createdById: currentUserId(),
  });
}

export async function recordWastage(input: { branchId?: string; productId: string; quantity: number; reason: string }) {
  return adjustStock({
    branchId: input.branchId,
    productId: input.productId,
    quantity: -Math.abs(input.quantity),
    type: 'WASTAGE',
    notes: input.reason,
  });
}

export async function listMovements(input: {
  productId?: string;
  branchId?: string;
  type?: StockMovementType;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.StockMovementWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.stockMovement.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        product: { select: { id: true, name: true, shade: true, unit: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

/**
 * Opening + purchases − consumption − wastage = closing, per product. This is the
 * reconciliation view salon owners actually check.
 */
export async function consumptionReport(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const movements = await prisma.stockMovement.groupBy({
    by: ['productId', 'type'],
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      createdAt: { gte: input.from, lte: input.to },
    },
    _sum: { quantity: true },
  });

  const productIds = [...new Set(movements.map((m) => m.productId))];
  if (!productIds.length) return { period: input, rows: [], totals: { consumptionValue: d(0), wastageValue: d(0) } };

  const [products, openingRows, closingRows] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, shade: true, unit: true, costPrice: true },
    }),
    prisma.stockMovement.groupBy({
      by: ['productId'],
      where: { tenantId, ...branchFilter(input.branchId), productId: { in: productIds }, createdAt: { lt: input.from } },
      _sum: { quantity: true },
    }),
    prisma.stock.groupBy({
      by: ['productId'],
      where: { tenantId, ...branchFilter(input.branchId), productId: { in: productIds } },
      _sum: { quantity: true },
    }),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const openingById = new Map(openingRows.map((r) => [r.productId, r._sum.quantity ?? d(0)]));
  const closingById = new Map(closingRows.map((r) => [r.productId, r._sum.quantity ?? d(0)]));

  const byProduct = new Map<string, Record<string, Prisma.Decimal>>();
  for (const movement of movements) {
    const entry = byProduct.get(movement.productId) ?? {};
    entry[movement.type] = d(movement._sum.quantity ?? 0);
    byProduct.set(movement.productId, entry);
  }

  let consumptionValue = d(0);
  let wastageValue = d(0);

  const rows = productIds.map((productId) => {
    const product = productById.get(productId)!;
    const entry = byProduct.get(productId) ?? {};
    const purchases = entry.PURCHASE ?? d(0);
    const consumption = (entry.CONSUMPTION ?? d(0)).abs();
    const sales = (entry.SALE ?? d(0)).abs();
    const wastage = (entry.WASTAGE ?? d(0)).abs();
    const adjustments = entry.ADJUSTMENT ?? d(0);

    consumptionValue = add(consumptionValue, mul(consumption, product.costPrice));
    wastageValue = add(wastageValue, mul(wastage, product.costPrice));

    return {
      productId,
      name: `${product.name}${product.shade ? ` (${product.shade})` : ''}`,
      unit: product.unit,
      opening: openingById.get(productId) ?? d(0),
      purchases,
      consumption,
      sales,
      wastage,
      adjustments,
      closing: closingById.get(productId) ?? d(0),
      consumptionValue: round2(mul(consumption, product.costPrice)),
      wastageValue: round2(mul(wastage, product.costPrice)),
    };
  });

  return {
    period: input,
    rows: rows.sort((a, b) => Number(b.consumptionValue) - Number(a.consumptionValue)),
    totals: { consumptionValue: round2(consumptionValue), wastageValue: round2(wastageValue) },
  };
}

export async function stockValuation(branchId?: string) {
  const tenantId = requireTenantId();

  const rows = await prisma.stock.findMany({
    where: { tenantId, ...branchFilter(branchId), quantity: { gt: 0 } },
    include: { product: { select: { costPrice: true, sellingPrice: true, isRetail: true } } },
  });

  const costValue = rows.reduce<Prisma.Decimal>((acc, r) => add(acc, mul(r.quantity, r.product.costPrice)), d(0));
  const retailValue = rows.reduce<Prisma.Decimal>((acc, r) => add(acc, mul(r.quantity, r.product.sellingPrice)), d(0));

  return {
    lines: rows.length,
    costValue: round2(costValue),
    retailValue: round2(retailValue),
    potentialMargin: round2(sub(retailValue, costValue)),
  };
}

export async function expiringBatches(days = 60, branchId?: string) {
  const tenantId = requireTenantId();
  return prisma.productBatch.findMany({
    where: {
      tenantId,
      ...(branchId ? { branchId } : {}),
      quantity: { gt: 0 },
      expiryDate: { not: null, lte: dayjs().add(days, 'day').toDate() },
    },
    orderBy: { expiryDate: 'asc' },
    include: { product: { select: { id: true, name: true, shade: true, unit: true } } },
  });
}

// ------------------------------------------------------ purchase orders ----

export interface PurchaseOrderInput {
  branchId?: string;
  supplierId: string;
  expectedAt?: Date;
  notes?: string;
  invoiceRef?: string;
  items: {
    productId: string;
    quantity: number;
    unitCost: number;
    taxRatePct?: number;
    batchNo?: string;
    expiryDate?: Date;
  }[];
}

export async function createPurchaseOrder(input: PurchaseOrderInput) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  if (!input.items.length) throw BadRequest('A purchase order needs at least one line');

  const count = await prisma.purchaseOrder.count({ where: { tenantId } });
  const poNumber = sequenceNumber('PO', count + 1, 5);

  const lines = input.items.map((item) => {
    const base = round2(mul(item.quantity, item.unitCost));
    const tax = pct(base, item.taxRatePct ?? 18);
    return { ...item, base, tax, lineTotal: round2(add(base, tax)) };
  });

  const subTotal = lines.reduce<Prisma.Decimal>((acc, l) => add(acc, l.base), d(0));
  const taxAmount = lines.reduce<Prisma.Decimal>((acc, l) => add(acc, l.tax), d(0));

  return prisma.purchaseOrder.create({
    data: {
      tenantId,
      branchId,
      supplierId: input.supplierId,
      poNumber,
      expectedAt: input.expectedAt ?? null,
      notes: input.notes ?? null,
      invoiceRef: input.invoiceRef ?? null,
      subTotal,
      taxAmount,
      totalAmount: round2(add(subTotal, taxAmount)),
      status: 'ORDERED',
      createdById: currentUserId(),
      items: {
        create: lines.map((line) => ({
          tenantId,
          productId: line.productId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          taxRatePct: line.taxRatePct ?? 18,
          lineTotal: line.lineTotal,
          batchNo: line.batchNo ?? null,
          expiryDate: line.expiryDate ? dateOnly(line.expiryDate) : null,
        })),
      },
    },
    include: { items: { include: { product: { select: { id: true, name: true } } } }, supplier: true },
  });
}

/** Receiving a PO is what actually moves stock. */
export async function receivePurchaseOrder(id: string, received?: { itemId: string; receivedQty: number }[]) {
  const tenantId = requireTenantId();
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw NotFound('Purchase order');
  if (po.status === 'RECEIVED') throw Conflict('This purchase order has already been received');
  if (po.status === 'CANCELLED') throw Conflict('This purchase order was cancelled');

  assertBranchAccess(po.branchId);
  const byItemId = new Map((received ?? []).map((r) => [r.itemId, r.receivedQty]));

  return prisma.$transaction(async (tx) => {
    let fullyReceived = true;

    for (const item of po.items) {
      const qty = byItemId.has(item.id) ? d(byItemId.get(item.id)!) : d(item.quantity).minus(item.receivedQty);
      if (qty.lessThanOrEqualTo(0)) {
        if (d(item.receivedQty).lessThan(item.quantity)) fullyReceived = false;
        continue;
      }

      await recordMovement(tx, {
        tenantId,
        branchId: po.branchId,
        productId: item.productId,
        type: 'PURCHASE',
        quantity: qty,
        unitCost: item.unitCost,
        refType: 'PURCHASE_ORDER',
        refId: po.id,
        notes: `PO ${po.poNumber}`,
        createdById: currentUserId(),
      });

      if (item.batchNo || item.expiryDate) {
        await tx.productBatch.create({
          data: {
            tenantId,
            productId: item.productId,
            branchId: po.branchId,
            batchNo: item.batchNo,
            expiryDate: item.expiryDate,
            quantity: qty,
            costPrice: item.unitCost,
          },
        });
      }

      const newReceived = add(item.receivedQty, qty);
      await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { receivedQty: newReceived } });
      if (newReceived.lessThan(item.quantity)) fullyReceived = false;

      // Keep the moving cost price current.
      await tx.product.update({ where: { id: item.productId }, data: { costPrice: item.unitCost } });
    }

    const status: PurchaseOrderStatus = fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED';

    return tx.purchaseOrder.update({
      where: { id },
      data: { status, receivedAt: fullyReceived ? new Date() : null },
      include: { items: { include: { product: { select: { id: true, name: true } } } }, supplier: true },
    });
  });
}

export async function listPurchaseOrders(input: {
  page?: number;
  pageSize?: number;
  branchId?: string;
  supplierId?: string;
  status?: PurchaseOrderStatus;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.PurchaseOrderWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  const [items, total, agg] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      skip,
      take,
      orderBy: { orderedAt: 'desc' },
      include: { supplier: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    }),
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.aggregate({ where, _sum: { totalAmount: true } }),
  ]);

  return { items, total, page, pageSize, totalValue: agg._sum.totalAmount ?? 0 };
}

export async function getPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: true,
      branch: { select: { id: true, name: true } },
      items: { include: { product: { select: { id: true, name: true, shade: true, unit: true } } } },
    },
  });
  if (!po) throw NotFound('Purchase order');
  return po;
}

export async function cancelPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw NotFound('Purchase order');
  if (po.status === 'RECEIVED') throw Conflict('A received purchase order cannot be cancelled');
  return prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
}

/** Products at or below their reorder level — feeds the owner's alert list. */
export async function lowStockAlerts(branchId?: string) {
  const tenantId = requireTenantId();

  const rows = await prisma.stock.findMany({
    where: { tenantId, ...branchFilter(branchId), product: { isActive: true, reorderLevel: { gt: 0 } } },
    include: {
      product: { select: { id: true, name: true, shade: true, unit: true, reorderLevel: true, costPrice: true } },
      branch: { select: { id: true, name: true } },
    },
  });

  return rows
    .filter((row) => d(row.quantity).lessThanOrEqualTo(row.product.reorderLevel))
    .map((row) => ({
      productId: row.productId,
      name: `${row.product.name}${row.product.shade ? ` (${row.product.shade})` : ''}`,
      branch: row.branch,
      quantity: row.quantity,
      unit: row.product.unit,
      reorderLevel: row.product.reorderLevel,
      shortfall: sub(row.product.reorderLevel, row.quantity),
    }));
}
