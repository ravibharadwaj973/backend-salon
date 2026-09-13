import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';

export interface CouponInput {
  code: string;
  description?: string;
  discountType?: 'PERCENT' | 'FLAT';
  value: number;
  maxDiscount?: number;
  minBillAmount?: number;
  applicableServiceIds?: string[];
  validFrom: Date;
  validTo: Date;
  usageLimit?: number;
  perCustomerLimit?: number;
  isActive?: boolean;
}

export async function listCoupons(input: { page?: number; pageSize?: number; activeOnly?: boolean }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.CouponWhereInput = {
    tenantId,
    ...(input.activeOnly ? { isActive: true, validTo: { gte: new Date() } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    }),
    prisma.coupon.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function createCoupon(input: CouponInput) {
  const tenantId = requireTenantId();
  if (input.validTo <= input.validFrom) throw BadRequest('The coupon must expire after it starts');

  const clash = await prisma.coupon.findFirst({ where: { tenantId, code: input.code } });
  if (clash) throw Conflict('A coupon with this code already exists');

  return prisma.coupon.create({ data: { tenantId, ...input } });
}

export async function updateCoupon(id: string, input: Partial<CouponInput>) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw NotFound('Coupon');
  return prisma.coupon.update({ where: { id }, data: input });
}

export async function couponPerformance(id: string) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw NotFound('Coupon');

  const [redemptions, revenue] = await Promise.all([
    prisma.couponRedemption.aggregate({ where: { couponId: id }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.invoice.aggregate({ where: { couponId: id, status: { not: 'VOID' } }, _sum: { grandTotal: true } }),
  ]);

  return {
    coupon,
    redemptions: redemptions._count._all,
    discountGiven: redemptions._sum.amount ?? 0,
    revenueGenerated: revenue._sum.grandTotal ?? 0,
  };
}
