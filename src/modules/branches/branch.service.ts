import type { Prisma, ResourceType } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { assertBranchAccess, allowedBranchIds } from '../../core/scope';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { dateOnly } from '../../core/dates';
import { assertBranchAllowed } from '../quotas/limits.service';

export interface BranchInput {
  name: string;
  code: string;
  phone?: string;
  email?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  pincode?: string;
  gstin?: string;
  region?: string;
  timezone?: string;
  openingHours?: Record<string, { open: string; close: string }[]>;
  slotIntervalMin?: number;
  /** null = as many as there are stylists free. */
  maxConcurrentBookings?: number | null;
  invoicePrefix?: string;
  googleReviewUrl?: string;
  isActive?: boolean;
}

export async function listBranches(input: { page?: number; pageSize?: number; q?: string; isActive?: string; region?: string }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);
  const allowed = allowedBranchIds();

  const where: Prisma.BranchWhereInput = {
    tenantId,
    ...(allowed ? { id: { in: allowed } } : {}),
    ...(input.isActive ? { isActive: input.isActive === 'true' } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { code: { contains: input.q, mode: 'insensitive' as const } },
            { city: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.branch.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      include: { _count: { select: { staff: true, resources: true, appointments: true } } },
    }),
    prisma.branch.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getBranch(id: string) {
  assertBranchAccess(id);
  const branch = await prisma.branch.findUnique({
    where: { id },
    include: {
      resources: { where: { isActive: true }, orderBy: { name: 'asc' } },
      _count: { select: { staff: true, customers: true } },
    },
  });
  if (!branch) throw NotFound('Branch');
  return branch;
}

export async function createBranch(input: BranchInput) {
  const tenantId = requireTenantId();

  // A one-branch plan must refuse the second branch here, not report it later.
  await assertBranchAllowed(tenantId);

  const existing = await prisma.branch.findFirst({ where: { tenantId, code: input.code } });
  if (existing) throw Conflict(`Branch code "${input.code}" is already used`);

  const { openingHours, googleReviewUrl, ...rest } = input;
  return prisma.branch.create({
    data: {
      tenantId,
      ...rest,
      ...(openingHours ? { openingHours: openingHours as Prisma.InputJsonValue } : {}),
      googleReviewUrl: googleReviewUrl || null,
    },
  });
}

export async function updateBranch(id: string, input: Partial<BranchInput>) {
  assertBranchAccess(id);
  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) throw NotFound('Branch');

  if (input.code && input.code !== branch.code) {
    const clash = await prisma.branch.findFirst({ where: { tenantId: branch.tenantId, code: input.code } });
    if (clash) throw Conflict(`Branch code "${input.code}" is already used`);
  }

  const { openingHours, googleReviewUrl, ...rest } = input;
  return prisma.branch.update({
    where: { id },
    data: {
      ...rest,
      ...(openingHours ? { openingHours: openingHours as Prisma.InputJsonValue } : {}),
      // Clearing the box means "no listing for this shop", not an empty link.
      ...(googleReviewUrl !== undefined ? { googleReviewUrl: googleReviewUrl || null } : {}),
    },
  });
}

export async function deactivateBranch(id: string) {
  assertBranchAccess(id);
  const upcoming = await prisma.appointment.count({
    where: { branchId: id, startAt: { gte: new Date() }, status: { in: ['BOOKED', 'CONFIRMED'] } },
  });
  if (upcoming > 0) {
    throw Conflict(`This branch has ${upcoming} upcoming appointments. Cancel or move them first.`);
  }
  return prisma.branch.update({ where: { id }, data: { isActive: false } });
}

// ------------------------------------------------------------- resources ----

export async function listResources(branchId?: string) {
  const tenantId = requireTenantId();
  if (branchId) assertBranchAccess(branchId);
  const allowed = allowedBranchIds();

  return prisma.resource.findMany({
    where: {
      tenantId,
      ...(branchId ? { branchId } : allowed ? { branchId: { in: allowed } } : {}),
    },
    orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
  });
}

export async function createResource(input: { branchId: string; name: string; type?: ResourceType; capacity?: number }) {
  const tenantId = requireTenantId();
  assertBranchAccess(input.branchId);
  return prisma.resource.create({
    data: {
      tenantId,
      branchId: input.branchId,
      name: input.name,
      type: input.type ?? 'CHAIR',
      capacity: input.capacity ?? 1,
    },
  });
}

export async function updateResource(id: string, input: { name?: string; type?: ResourceType; capacity?: number; isActive?: boolean }) {
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource) throw NotFound('Resource');
  assertBranchAccess(resource.branchId);
  return prisma.resource.update({ where: { id }, data: input });
}

export async function deleteResource(id: string) {
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource) throw NotFound('Resource');
  assertBranchAccess(resource.branchId);
  return prisma.resource.update({ where: { id }, data: { isActive: false } });
}

// -------------------------------------------------------------- holidays ----

export async function listHolidays(branchId?: string) {
  const tenantId = requireTenantId();
  return prisma.holiday.findMany({
    where: { tenantId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    orderBy: { date: 'asc' },
  });
}

export async function createHoliday(input: { branchId?: string; date: Date; name: string }) {
  const tenantId = requireTenantId();
  if (input.branchId) assertBranchAccess(input.branchId);
  const date = dateOnly(input.date);

  const existing = await prisma.holiday.findFirst({
    where: { tenantId, branchId: input.branchId ?? null, date },
  });
  if (existing) throw Conflict('A holiday already exists on this date');

  return prisma.holiday.create({
    data: { tenantId, branchId: input.branchId ?? null, date, name: input.name },
  });
}

export async function deleteHoliday(id: string) {
  const holiday = await prisma.holiday.findUnique({ where: { id } });
  if (!holiday) throw NotFound('Holiday');
  return prisma.holiday.delete({ where: { id } });
}
