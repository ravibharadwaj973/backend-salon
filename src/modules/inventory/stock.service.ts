import type { Prisma, StockMovementType } from '@prisma/client';
import { prisma, type Db } from '../../core/prisma';
import { add, d, round3 } from '../../core/money';
import { logger } from '../../core/logger';

export interface MovementInput {
  tenantId: string;
  branchId: string;
  productId: string;
  type: StockMovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantity: Prisma.Decimal | number;
  unitCost?: Prisma.Decimal | number;
  refType?: string;
  refId?: string;
  invoiceId?: string;
  batchId?: string;
  notes?: string;
  createdById?: string | null;
}

/**
 * The single writer for stock. Every change goes through here so the ledger
 * (stock_movements) and the running balance (stocks) can never disagree.
 */
export async function recordMovement(db: Db, input: MovementInput) {
  const quantity = round3(input.quantity);

  const existing = await db.stock.findFirst({
    where: { branchId: input.branchId, productId: input.productId },
  });

  const balanceAfter = add(existing?.quantity ?? 0, quantity);

  if (existing) {
    await db.stock.update({ where: { id: existing.id }, data: { quantity: balanceAfter } });
  } else {
    await db.stock.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        productId: input.productId,
        quantity: balanceAfter,
      },
    });
  }

  return db.stockMovement.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      productId: input.productId,
      type: input.type,
      quantity,
      unitCost: input.unitCost ?? 0,
      balanceAfter,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      invoiceId: input.invoiceId ?? null,
      batchId: input.batchId ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
    },
  });
}

/**
 * Deducts the products a service is expected to consume (colour, developer,
 * masks...) when the service is billed.
 */
export async function consumeForService(
  db: Db,
  input: { tenantId: string; branchId: string; serviceId: string; quantity?: number; invoiceId?: string; createdById?: string | null },
) {
  const recipe = await db.serviceConsumption.findMany({
    where: { serviceId: input.serviceId },
    include: { product: { select: { id: true, costPrice: true, isConsumable: true } } },
  });
  if (!recipe.length) return [];

  const multiplier = input.quantity ?? 1;
  const movements = [];

  for (const line of recipe) {
    if (!line.product.isConsumable) continue;
    movements.push(
      await recordMovement(db, {
        tenantId: input.tenantId,
        branchId: input.branchId,
        productId: line.productId,
        type: 'CONSUMPTION',
        quantity: d(line.quantity).times(multiplier).negated(),
        unitCost: line.product.costPrice,
        refType: 'SERVICE',
        refId: input.serviceId,
        invoiceId: input.invoiceId,
        createdById: input.createdById ?? null,
      }),
    );
  }

  return movements;
}

/** Retail sale of a product on an invoice. */
export async function recordSale(
  db: Db,
  input: { tenantId: string; branchId: string; productId: string; quantity: number; invoiceId: string; createdById?: string | null },
) {
  const product = await db.product.findUnique({ where: { id: input.productId } });
  if (!product) return null;

  return recordMovement(db, {
    tenantId: input.tenantId,
    branchId: input.branchId,
    productId: input.productId,
    type: 'SALE',
    quantity: -Math.abs(input.quantity),
    unitCost: product.costPrice,
    refType: 'INVOICE',
    refId: input.invoiceId,
    invoiceId: input.invoiceId,
    createdById: input.createdById ?? null,
  });
}

/** Reverses movements for a voided invoice. */
export async function reverseInvoiceMovements(db: Db, invoiceId: string) {
  const movements = await db.stockMovement.findMany({ where: { invoiceId } });

  for (const movement of movements) {
    await recordMovement(db, {
      tenantId: movement.tenantId,
      branchId: movement.branchId,
      productId: movement.productId,
      type: 'RETURN',
      quantity: d(movement.quantity).negated(),
      unitCost: movement.unitCost,
      refType: 'INVOICE_VOID',
      refId: invoiceId,
      notes: `Reversal of ${movement.type}`,
    }).catch((err: unknown) => logger.warn({ err, movementId: movement.id }, 'stock reversal failed'));
  }

  return { reversed: movements.length };
}

export async function currentStock(branchId: string, productId: string): Promise<Prisma.Decimal> {
  const stock = await prisma.stock.findFirst({ where: { branchId, productId } });
  return d(stock?.quantity ?? 0);
}
