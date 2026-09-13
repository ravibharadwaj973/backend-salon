import type { CommissionType, Gender, Prisma, ResourceType } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';

// ----------------------------------------------------------- categories -----

export async function listCategories() {
  const tenantId = requireTenantId();
  return prisma.serviceCategory.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { services: true } } },
  });
}

export async function createCategory(input: { name: string; sortOrder?: number }) {
  const tenantId = requireTenantId();
  const existing = await prisma.serviceCategory.findFirst({ where: { tenantId, name: input.name } });
  if (existing) throw Conflict('A category with this name already exists');
  return prisma.serviceCategory.create({ data: { tenantId, ...input } });
}

export async function updateCategory(id: string, input: { name?: string; sortOrder?: number; isActive?: boolean }) {
  const category = await prisma.serviceCategory.findUnique({ where: { id } });
  if (!category) throw NotFound('Category');
  return prisma.serviceCategory.update({ where: { id }, data: input });
}

export async function deleteCategory(id: string) {
  const inUse = await prisma.service.count({ where: { categoryId: id, isActive: true } });
  if (inUse > 0) throw Conflict(`${inUse} active services still use this category`);
  return prisma.serviceCategory.update({ where: { id }, data: { isActive: false } });
}

// ------------------------------------------------------------- services -----

export interface ServiceInput {
  categoryId?: string;
  name: string;
  code?: string;
  description?: string;
  gender?: Gender;
  durationMin?: number;
  bufferMin?: number;
  price: number;
  memberPrice?: number;
  /** Not settable. The bill decides whether GST applies, and at what rate. */
  hsnSac?: string;
  commissionType?: CommissionType;
  commissionRate?: number;
  requiresResource?: boolean;
  resourceType?: ResourceType;
  onlineBookable?: boolean;
  imageUrl?: string;
  isActive?: boolean;
}

export async function listServices(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  categoryId?: string;
  gender?: Gender;
  isActive?: string;
  onlineBookable?: string;
  staffId?: string;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.ServiceWhereInput = {
    tenantId,
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.gender ? { OR: [{ gender: input.gender }, { gender: 'UNISEX' }] } : {}),
    ...(input.isActive ? { isActive: input.isActive === 'true' } : {}),
    ...(input.onlineBookable ? { onlineBookable: input.onlineBookable === 'true' } : {}),
    ...(input.staffId ? { staffServices: { some: { staffId: input.staffId } } } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { code: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      skip,
      take,
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { staffServices: true } },
      },
    }),
    prisma.service.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getService(id: string) {
  const service = await prisma.service.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      consumption: { include: { product: { select: { id: true, name: true, unit: true, shade: true } } } },
      staffServices: {
        include: { staff: { select: { id: true, displayName: true, branchId: true, isBookable: true } } },
      },
    },
  });
  if (!service) throw NotFound('Service');
  return service;
}

export async function createService(input: ServiceInput) {
  const tenantId = requireTenantId();
  const clash = await prisma.service.findFirst({
    where: { tenantId, name: input.name, gender: input.gender ?? 'UNISEX' },
  });
  if (clash) throw Conflict('A service with this name already exists for that gender');

  return prisma.service.create({ data: { tenantId, ...input } });
}

export async function updateService(id: string, input: Partial<ServiceInput>) {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) throw NotFound('Service');
  return prisma.service.update({ where: { id }, data: input });
}

export async function deactivateService(id: string) {
  const upcoming = await prisma.appointmentService.count({
    where: { serviceId: id, startAt: { gte: new Date() }, appointment: { status: { in: ['BOOKED', 'CONFIRMED'] } } },
  });
  if (upcoming > 0) throw Conflict(`${upcoming} upcoming appointments still use this service`);
  return prisma.service.update({ where: { id }, data: { isActive: false } });
}

/**
 * Expected product consumption per service — the basis for automatic stock
 * deduction when the service is billed.
 */
export async function setServiceConsumption(serviceId: string, items: { productId: string; quantity: number }[]) {
  const tenantId = requireTenantId();
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) throw NotFound('Service');

  await prisma.$transaction([
    prisma.serviceConsumption.deleteMany({ where: { serviceId } }),
    ...(items.length
      ? [
          prisma.serviceConsumption.createMany({
            data: items.map((i) => ({ tenantId, serviceId, productId: i.productId, quantity: i.quantity })),
          }),
        ]
      : []),
  ]);

  return prisma.serviceConsumption.findMany({
    where: { serviceId },
    include: { product: { select: { id: true, name: true, unit: true } } },
  });
}

/** Menu grouped by category — used by the booking page and the POS screen. */
export async function serviceMenu(input: { gender?: Gender; onlineOnly?: boolean }) {
  const tenantId = requireTenantId();
  const categories = await prisma.serviceCategory.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      services: {
        where: {
          isActive: true,
          ...(input.onlineOnly ? { onlineBookable: true } : {}),
          ...(input.gender ? { OR: [{ gender: input.gender }, { gender: 'UNISEX' }] } : {}),
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          description: true,
          durationMin: true,
          bufferMin: true,
          price: true,
          memberPrice: true,
          taxRatePct: true,
          gender: true,
          imageUrl: true,
        },
      },
    },
  });

  const uncategorised = await prisma.service.findMany({
    where: {
      tenantId,
      categoryId: null,
      isActive: true,
      ...(input.onlineOnly ? { onlineBookable: true } : {}),
    },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      durationMin: true,
      bufferMin: true,
      price: true,
      memberPrice: true,
      taxRatePct: true,
      gender: true,
      imageUrl: true,
    },
  });

  const result = categories.filter((c) => c.services.length > 0);
  if (uncategorised.length) {
    result.push({
      id: 'uncategorised',
      tenantId,
      name: 'Other',
      sortOrder: 999,
      isActive: true,
      services: uncategorised,
    } as (typeof result)[number]);
  }
  return result;
}
