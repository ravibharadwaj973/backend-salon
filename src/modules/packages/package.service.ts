import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { addDays, dayjs } from '../../core/dates';

// ------------------------------------------------------------ templates ----

export async function listTemplates(activeOnly = false) {
  const tenantId = requireTenantId();
  return prisma.packageTemplate.findMany({
    where: { tenantId, ...(activeOnly ? { isActive: true } : {}) },
    orderBy: { name: 'asc' },
    include: {
      items: { include: { service: { select: { id: true, name: true, price: true, durationMin: true } } } },
      _count: { select: { purchases: true } },
    },
  });
}

export async function getTemplate(id: string) {
  const template = await prisma.packageTemplate.findUnique({
    where: { id },
    include: { items: { include: { service: { select: { id: true, name: true, price: true } } } } },
  });
  if (!template) throw NotFound('Package');
  return template;
}

export async function createTemplate(input: {
  name: string;
  description?: string;
  price: number;
  taxRatePct?: number;
  validityDays?: number;
  items: { serviceId: string; quantity: number }[];
}) {
  const tenantId = requireTenantId();
  const clash = await prisma.packageTemplate.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A package with this name already exists');
  if (!input.items.length) throw BadRequest('A package must contain at least one service');

  return prisma.packageTemplate.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      taxRatePct: input.taxRatePct ?? 18,
      validityDays: input.validityDays ?? 90,
      items: {
        create: input.items.map((i) => ({ tenantId, serviceId: i.serviceId, quantity: i.quantity })),
      },
    },
    include: { items: true },
  });
}

export async function updateTemplate(
  id: string,
  input: {
    name?: string;
    description?: string;
    price?: number;
    taxRatePct?: number;
    validityDays?: number;
    isActive?: boolean;
    items?: { serviceId: string; quantity: number }[];
  },
) {
  const tenantId = requireTenantId();
  const template = await prisma.packageTemplate.findUnique({ where: { id } });
  if (!template) throw NotFound('Package');

  const { items, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    if (items) {
      await tx.packageTemplateItem.deleteMany({ where: { templateId: id } });
      await tx.packageTemplateItem.createMany({
        data: items.map((i) => ({ tenantId, templateId: id, serviceId: i.serviceId, quantity: i.quantity })),
      });
    }
    return tx.packageTemplate.update({
      where: { id },
      data: rest,
      include: { items: { include: { service: { select: { id: true, name: true } } } } },
    });
  });
}

// ------------------------------------------------------------ purchases ----

/**
 * Sells a package. Called from billing when a PACKAGE line is invoiced, and
 * directly when a salon records a legacy/manual sale.
 */
export async function purchasePackage(
  db: Db,
  input: { tenantId: string; branchId: string; customerId: string; templateId: string; invoiceId?: string; price?: number },
) {
  const template = await db.packageTemplate.findUnique({
    where: { id: input.templateId },
    include: { items: true },
  });
  if (!template) throw NotFound('Package');
  if (!template.isActive) throw BadRequest('This package is no longer for sale');

  const purchase = await db.packagePurchase.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      customerId: input.customerId,
      templateId: template.id,
      invoiceId: input.invoiceId ?? null,
      price: input.price ?? template.price,
      expiresAt: addDays(new Date(), template.validityDays),
      items: {
        create: template.items.map((i) => ({
          tenantId: input.tenantId,
          serviceId: i.serviceId,
          totalQty: i.quantity,
        })),
      },
    },
    include: { items: true, template: { select: { name: true } } },
  });

  return purchase;
}

export async function sellPackage(input: { customerId: string; templateId: string; branchId?: string; price?: number }) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  return purchasePackage(prisma, { tenantId, branchId, ...input });
}

export async function listCustomerPackages(customerId: string, activeOnly = true) {
  return prisma.packagePurchase.findMany({
    where: { customerId, ...(activeOnly ? { status: 'ACTIVE' } : {}) },
    orderBy: { purchasedAt: 'desc' },
    include: {
      template: { select: { id: true, name: true } },
      items: { include: { service: { select: { id: true, name: true, price: true } } } },
    },
  });
}

/** What is still redeemable for this customer, ready for the POS screen. */
export async function redeemableForCustomer(customerId: string) {
  const purchases = await prisma.packagePurchase.findMany({
    where: { customerId, status: 'ACTIVE', expiresAt: { gte: new Date() } },
    include: {
      template: { select: { id: true, name: true } },
      items: { include: { service: { select: { id: true, name: true, price: true } } } },
    },
  });

  return purchases.flatMap((purchase) =>
    purchase.items
      .filter((item) => item.usedQty < item.totalQty)
      .map((item) => ({
        purchaseId: purchase.id,
        purchaseItemId: item.id,
        packageName: purchase.template.name,
        serviceId: item.serviceId,
        serviceName: item.service.name,
        remaining: item.totalQty - item.usedQty,
        totalQty: item.totalQty,
        usedQty: item.usedQty,
        expiresAt: purchase.expiresAt,
      })),
  );
}

/**
 * Consume sessions from a package. Runs inside the invoice transaction so a
 * failed bill never burns a customer's session.
 */
export async function redeemPackageSession(
  db: Db,
  input: { tenantId: string; purchaseItemId: string; quantity?: number; invoiceId?: string; appointmentId?: string },
) {
  const quantity = input.quantity ?? 1;
  const item = await db.packagePurchaseItem.findUnique({
    where: { id: input.purchaseItemId },
    include: { purchase: true },
  });
  if (!item) throw NotFound('Package session');

  if (item.purchase.status !== 'ACTIVE') throw BadRequest('This package is no longer active');
  if (item.purchase.expiresAt < new Date()) throw BadRequest('This package has expired');
  if (item.usedQty + quantity > item.totalQty) {
    throw BadRequest(`Only ${item.totalQty - item.usedQty} session(s) remain in this package`);
  }

  await db.packagePurchaseItem.update({
    where: { id: item.id },
    data: { usedQty: { increment: quantity } },
  });

  await db.packageRedemption.create({
    data: {
      tenantId: input.tenantId,
      purchaseItemId: item.id,
      invoiceId: input.invoiceId ?? null,
      appointmentId: input.appointmentId ?? null,
      quantity,
    },
  });

  // Mark the whole package exhausted once every line is used up.
  const siblings = await db.packagePurchaseItem.findMany({ where: { purchaseId: item.purchaseId } });
  const allUsed = siblings.every((s) => (s.id === item.id ? s.usedQty + quantity : s.usedQty) >= s.totalQty);
  if (allUsed) {
    await db.packagePurchase.update({ where: { id: item.purchaseId }, data: { status: 'EXHAUSTED' } });
  }

  return { purchaseItemId: item.id, remaining: item.totalQty - item.usedQty - quantity };
}

export async function listPurchases(input: {
  customerId?: string;
  status?: string;
  branchId?: string;
  expiringInDays?: number;
  page?: number;
  pageSize?: number;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.PackagePurchaseWhereInput = {
    tenantId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.status ? { status: input.status as Prisma.EnumPackageStatusFilter['equals'] } : {}),
    ...(input.expiringInDays
      ? { status: 'ACTIVE', expiresAt: { gte: new Date(), lte: dayjs().add(input.expiringInDays, 'day').toDate() } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.packagePurchase.findMany({
      where,
      skip,
      take,
      orderBy: { expiresAt: 'asc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        template: { select: { id: true, name: true } },
        items: { include: { service: { select: { id: true, name: true } } } },
      },
    }),
    prisma.packagePurchase.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function cancelPurchase(id: string, reason?: string) {
  const purchase = await prisma.packagePurchase.findUnique({ where: { id } });
  if (!purchase) throw NotFound('Package purchase');
  return prisma.packagePurchase.update({
    where: { id },
    data: { status: 'CANCELLED', ...(reason ? {} : {}) },
  });
}

/** Nightly: expire packages past their validity date. */
export async function expirePackages() {
  const result = await prisma.packagePurchase.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}
