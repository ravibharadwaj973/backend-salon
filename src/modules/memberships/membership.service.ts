import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { addDays, dayjs } from '../../core/dates';

// ----------------------------------------------------------------- plans ---

export async function listPlans(activeOnly = false) {
  const tenantId = requireTenantId();
  return prisma.membershipPlan.findMany({
    where: { tenantId, ...(activeOnly ? { isActive: true } : {}) },
    orderBy: { price: 'asc' },
    include: {
      benefits: { include: { service: { select: { id: true, name: true, price: true } } } },
      _count: { select: { subscriptions: true } },
    },
  });
}

export async function getPlan(id: string) {
  const plan = await prisma.membershipPlan.findUnique({
    where: { id },
    include: { benefits: { include: { service: { select: { id: true, name: true } } } } },
  });
  if (!plan) throw NotFound('Membership plan');
  return plan;
}

export async function createPlan(input: {
  name: string;
  description?: string;
  price: number;
  taxRatePct?: number;
  durationDays?: number;
  serviceDiscountPct?: number;
  productDiscountPct?: number;
  priorityBooking?: boolean;
  birthdayBenefit?: string;
  loyaltyMultiplier?: number;
  benefits?: { serviceId: string; quantity: number }[];
}) {
  const tenantId = requireTenantId();
  const clash = await prisma.membershipPlan.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A membership plan with this name already exists');

  const { benefits, ...rest } = input;

  return prisma.membershipPlan.create({
    data: {
      tenantId,
      ...rest,
      ...(benefits?.length
        ? { benefits: { create: benefits.map((b) => ({ tenantId, serviceId: b.serviceId, quantity: b.quantity })) } }
        : {}),
    },
    include: { benefits: true },
  });
}

export async function updatePlan(
  id: string,
  input: Record<string, unknown> & { benefits?: { serviceId: string; quantity: number }[] },
) {
  const tenantId = requireTenantId();
  const plan = await prisma.membershipPlan.findUnique({ where: { id } });
  if (!plan) throw NotFound('Membership plan');

  const { benefits, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    if (benefits) {
      await tx.membershipPlanBenefit.deleteMany({ where: { planId: id } });
      if (benefits.length) {
        await tx.membershipPlanBenefit.createMany({
          data: benefits.map((b) => ({ tenantId, planId: id, serviceId: b.serviceId, quantity: b.quantity })),
        });
      }
    }
    return tx.membershipPlan.update({
      where: { id },
      data: rest as Prisma.MembershipPlanUpdateInput,
      include: { benefits: true },
    });
  });
}

// --------------------------------------------------------- subscriptions ---

/** Sells a membership. Free-service benefits are materialised as usage rows. */
export async function subscribe(
  db: Db,
  input: { tenantId: string; branchId: string; customerId: string; planId: string; invoiceId?: string; price?: number; autoRenew?: boolean },
) {
  const plan = await db.membershipPlan.findUnique({ where: { id: input.planId }, include: { benefits: true } });
  if (!plan) throw NotFound('Membership plan');
  if (!plan.isActive) throw BadRequest('This membership plan is no longer for sale');

  const active = await db.membershipSubscription.findFirst({
    where: { customerId: input.customerId, status: 'ACTIVE', endAt: { gte: new Date() } },
  });

  // Renewals extend from the current expiry rather than from today.
  const startAt = active && active.planId === plan.id ? active.endAt : new Date();
  const endAt = addDays(startAt, plan.durationDays);

  if (active) {
    await db.membershipSubscription.update({ where: { id: active.id }, data: { status: 'EXPIRED' } });
  }

  return db.membershipSubscription.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      customerId: input.customerId,
      planId: plan.id,
      invoiceId: input.invoiceId ?? null,
      price: input.price ?? plan.price,
      startAt,
      endAt,
      autoRenew: input.autoRenew ?? false,
      benefitUsage: {
        create: plan.benefits.map((b) => ({
          tenantId: input.tenantId,
          serviceId: b.serviceId,
          totalQty: b.quantity,
        })),
      },
    },
    include: { plan: true, benefitUsage: true },
  });
}

export async function sellMembership(input: {
  customerId: string;
  planId: string;
  branchId?: string;
  price?: number;
  autoRenew?: boolean;
}) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  return subscribe(prisma, { tenantId, branchId, ...input });
}

/** The customer's live membership, if any — drives member pricing at the POS. */
export async function activeMembership(customerId: string) {
  return prisma.membershipSubscription.findFirst({
    where: { customerId, status: 'ACTIVE', endAt: { gte: new Date() } },
    orderBy: { endAt: 'desc' },
    include: {
      plan: true,
      benefitUsage: { include: { subscription: false } },
    },
  });
}

export async function membershipBenefitsForCustomer(customerId: string) {
  const membership = await activeMembership(customerId);
  if (!membership) return null;

  const services = await prisma.service.findMany({
    where: { id: { in: membership.benefitUsage.map((b) => b.serviceId) } },
    select: { id: true, name: true, price: true },
  });
  const byId = new Map(services.map((s) => [s.id, s]));

  return {
    subscriptionId: membership.id,
    plan: {
      id: membership.plan.id,
      name: membership.plan.name,
      serviceDiscountPct: membership.plan.serviceDiscountPct,
      productDiscountPct: membership.plan.productDiscountPct,
      loyaltyMultiplier: membership.plan.loyaltyMultiplier,
    },
    expiresAt: membership.endAt,
    daysLeft: dayjs(membership.endAt).diff(dayjs(), 'day'),
    freeServices: membership.benefitUsage
      .filter((b) => b.usedQty < b.totalQty)
      .map((b) => ({
        usageId: b.id,
        serviceId: b.serviceId,
        serviceName: byId.get(b.serviceId)?.name ?? 'Service',
        remaining: b.totalQty - b.usedQty,
        totalQty: b.totalQty,
      })),
  };
}

export async function consumeBenefit(
  db: Db,
  input: { subscriptionId: string; serviceId: string; quantity?: number },
): Promise<{ consumed: number; remaining: number }> {
  const quantity = input.quantity ?? 1;
  const usage = await db.membershipBenefitUsage.findFirst({
    where: { subscriptionId: input.subscriptionId, serviceId: input.serviceId },
  });
  if (!usage) throw BadRequest('This membership does not include that service');
  if (usage.usedQty + quantity > usage.totalQty) {
    throw BadRequest(`Only ${usage.totalQty - usage.usedQty} complimentary session(s) remain`);
  }

  await db.membershipBenefitUsage.update({
    where: { id: usage.id },
    data: { usedQty: { increment: quantity } },
  });

  return { consumed: quantity, remaining: usage.totalQty - usage.usedQty - quantity };
}

export async function listSubscriptions(input: {
  customerId?: string;
  status?: string;
  branchId?: string;
  expiringInDays?: number;
  page?: number;
  pageSize?: number;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.MembershipSubscriptionWhereInput = {
    tenantId,
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.status ? { status: input.status as Prisma.EnumMembershipStatusFilter['equals'] } : {}),
    ...(input.expiringInDays
      ? { status: 'ACTIVE', endAt: { gte: new Date(), lte: dayjs().add(input.expiringInDays, 'day').toDate() } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.membershipSubscription.findMany({
      where,
      skip,
      take,
      orderBy: { endAt: 'asc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, totalSpent: true } },
        plan: { select: { id: true, name: true, price: true } },
      },
    }),
    prisma.membershipSubscription.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function cancelSubscription(id: string) {
  const subscription = await prisma.membershipSubscription.findUnique({ where: { id } });
  if (!subscription) throw NotFound('Membership');
  return prisma.membershipSubscription.update({ where: { id }, data: { status: 'CANCELLED' } });
}

/** Nightly: retire memberships past their end date. */
export async function expireMemberships() {
  const result = await prisma.membershipSubscription.updateMany({
    where: { status: 'ACTIVE', endAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return { expired: result.count };
}
