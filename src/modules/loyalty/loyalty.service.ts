import type { LoyaltyProgram, LoyaltyTxnType, Prisma } from '@prisma/client';
import { prisma, type Db } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { d, div, min as decMin, mul, round2 } from '../../core/money';
import { addMonths } from '../../core/dates';

const DEFAULT_PROGRAM = {
  isActive: true,
  amountPerPoint: 100,
  pointValue: 0.5,
  referralPoints: 100,
  birthdayPoints: 50,
  reviewPoints: 25,
  signupPoints: 0,
  minRedeemPoints: 100,
  maxRedeemPctOfBill: 20,
  expiryMonths: 12,
};

export async function getProgram(tenantId?: string): Promise<LoyaltyProgram> {
  const tid = tenantId ?? requireTenantId();
  const existing = await prisma.loyaltyProgram.findFirst({ where: { tenantId: tid } });
  if (existing) return existing;
  return prisma.loyaltyProgram.create({ data: { tenantId: tid, ...DEFAULT_PROGRAM } });
}

export async function updateProgram(input: Partial<typeof DEFAULT_PROGRAM>) {
  const program = await getProgram();
  return prisma.loyaltyProgram.update({ where: { id: program.id }, data: input });
}

/**
 * Awards points for a bill. Called inside the invoice transaction so points and
 * revenue can never drift apart.
 */
export async function earnPoints(
  db: Db,
  input: { tenantId: string; customerId: string; amount: Prisma.Decimal | number; invoiceId?: string; multiplier?: number },
): Promise<{ points: number; balance: number }> {
  const program = await db.loyaltyProgram.findFirst({ where: { tenantId: input.tenantId } });
  if (!program || !program.isActive) return { points: 0, balance: 0 };

  const perPoint = d(program.amountPerPoint);
  if (perPoint.lessThanOrEqualTo(0)) return { points: 0, balance: 0 };

  const basePoints = Math.floor(Number(div(input.amount, perPoint)));
  const points = Math.floor(basePoints * (input.multiplier ?? 1));
  if (points <= 0) {
    const customer = await db.customer.findUnique({ where: { id: input.customerId }, select: { loyaltyPoints: true } });
    return { points: 0, balance: customer?.loyaltyPoints ?? 0 };
  }

  const customer = await db.customer.update({
    where: { id: input.customerId },
    data: { loyaltyPoints: { increment: points } },
    select: { loyaltyPoints: true },
  });

  await db.loyaltyTransaction.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: 'EARN',
      points,
      balanceAfter: customer.loyaltyPoints,
      reason: input.invoiceId ? `Earned on invoice` : 'Points earned',
      invoiceId: input.invoiceId ?? null,
      expiresAt: program.expiryMonths > 0 ? addMonths(new Date(), program.expiryMonths) : null,
    },
  });

  return { points, balance: customer.loyaltyPoints };
}

/**
 * Converts points into a rupee value that can be applied to a bill. Returns the
 * value redeemed; the caller records it as a LOYALTY_POINTS payment line.
 */
export async function redeemPoints(
  db: Db,
  input: { tenantId: string; customerId: string; points: number; billAmount: Prisma.Decimal | number; invoiceId?: string },
): Promise<{ points: number; value: Prisma.Decimal }> {
  if (input.points <= 0) return { points: 0, value: round2(0) };

  const program = await db.loyaltyProgram.findFirst({ where: { tenantId: input.tenantId } });
  if (!program || !program.isActive) throw BadRequest('The loyalty programme is not active');

  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw NotFound('Customer');

  if (input.points > customer.loyaltyPoints) {
    throw BadRequest(`Customer only has ${customer.loyaltyPoints} points`);
  }
  if (input.points < program.minRedeemPoints) {
    throw BadRequest(`At least ${program.minRedeemPoints} points are needed to redeem`);
  }

  const requestedValue = round2(mul(input.points, program.pointValue));
  const cap = round2(mul(input.billAmount, div(program.maxRedeemPctOfBill, 100)));
  const value = decMin(requestedValue, cap);

  if (value.lessThanOrEqualTo(0)) return { points: 0, value: round2(0) };

  // If the cap bit, only spend the points actually used.
  const pointsUsed = value.equals(requestedValue)
    ? input.points
    : Math.ceil(Number(div(value, program.pointValue)));

  const updated = await db.customer.update({
    where: { id: input.customerId },
    data: { loyaltyPoints: { decrement: pointsUsed } },
    select: { loyaltyPoints: true },
  });

  await db.loyaltyTransaction.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: 'REDEEM',
      points: -pointsUsed,
      balanceAfter: updated.loyaltyPoints,
      reason: 'Redeemed against bill',
      invoiceId: input.invoiceId ?? null,
    },
  });

  return { points: pointsUsed, value };
}

export async function adjustPoints(input: { customerId: string; points: number; reason: string; type?: LoyaltyTxnType }) {
  const tenantId = requireTenantId();
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw NotFound('Customer');

  const balance = customer.loyaltyPoints + input.points;
  if (balance < 0) throw BadRequest('This adjustment would leave a negative balance');

  const [, txn] = await prisma.$transaction([
    prisma.customer.update({ where: { id: input.customerId }, data: { loyaltyPoints: balance } }),
    prisma.loyaltyTransaction.create({
      data: {
        tenantId,
        customerId: input.customerId,
        type: input.type ?? 'ADJUST',
        points: input.points,
        balanceAfter: balance,
        reason: input.reason,
      },
    }),
  ]);

  return txn;
}

export async function listTransactions(customerId: string, input: { page?: number; pageSize?: number }) {
  const { skip, take, page, pageSize } = pageParams(input);
  const [items, total] = await Promise.all([
    prisma.loyaltyTransaction.findMany({
      where: { customerId },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { invoice: { select: { id: true, invoiceNumber: true } } },
    }),
    prisma.loyaltyTransaction.count({ where: { customerId } }),
  ]);
  return { items, total, page, pageSize };
}

// ------------------------------------------------------------- rewards -----

export async function listRewards(activeOnly = false) {
  const tenantId = requireTenantId();
  return prisma.reward.findMany({
    where: { tenantId, ...(activeOnly ? { isActive: true } : {}) },
    orderBy: { pointsCost: 'asc' },
    include: { service: { select: { id: true, name: true } } },
  });
}

export async function createReward(input: {
  name: string;
  pointsCost: number;
  rewardType?: string;
  value?: number;
  serviceId?: string;
}) {
  const tenantId = requireTenantId();
  return prisma.reward.create({ data: { tenantId, ...input } });
}

export async function updateReward(id: string, input: Record<string, unknown>) {
  const reward = await prisma.reward.findUnique({ where: { id } });
  if (!reward) throw NotFound('Reward');
  return prisma.reward.update({ where: { id }, data: input as Prisma.RewardUpdateInput });
}

/**
 * Redeem a catalogue reward. Points are deducted immediately; the resulting
 * benefit is applied to the next bill via the returned redemption id.
 */
export async function redeemReward(input: { rewardId: string; customerId: string; invoiceId?: string }) {
  const tenantId = requireTenantId();
  const [reward, customer] = await Promise.all([
    prisma.reward.findUnique({ where: { id: input.rewardId } }),
    prisma.customer.findUnique({ where: { id: input.customerId } }),
  ]);

  if (!reward || !reward.isActive) throw NotFound('Reward');
  if (!customer) throw NotFound('Customer');
  if (customer.loyaltyPoints < reward.pointsCost) {
    throw BadRequest(`This reward needs ${reward.pointsCost} points; the customer has ${customer.loyaltyPoints}`);
  }

  const balance = customer.loyaltyPoints - reward.pointsCost;

  const [, , redemption] = await prisma.$transaction([
    prisma.customer.update({ where: { id: input.customerId }, data: { loyaltyPoints: balance } }),
    prisma.loyaltyTransaction.create({
      data: {
        tenantId,
        customerId: input.customerId,
        type: 'REDEEM',
        points: -reward.pointsCost,
        balanceAfter: balance,
        reason: `Redeemed reward: ${reward.name}`,
        invoiceId: input.invoiceId ?? null,
      },
    }),
    prisma.rewardRedemption.create({
      data: {
        tenantId,
        rewardId: reward.id,
        customerId: input.customerId,
        points: reward.pointsCost,
        invoiceId: input.invoiceId ?? null,
      },
    }),
  ]);

  return { redemption, reward, pointsBalance: balance };
}

/** Expires points older than the programme window. Run nightly. */
export async function expireStalePoints(tenantId: string) {
  const program = await prisma.loyaltyProgram.findFirst({ where: { tenantId, isActive: true } });
  if (!program || program.expiryMonths <= 0) return { expired: 0, customers: 0 };

  const due = await prisma.loyaltyTransaction.findMany({
    where: { tenantId, type: 'EARN', expiresAt: { lte: new Date() } },
    select: { id: true, customerId: true, points: true },
    take: 1000,
  });
  if (!due.length) return { expired: 0, customers: 0 };

  const byCustomer = new Map<string, number>();
  for (const txn of due) byCustomer.set(txn.customerId, (byCustomer.get(txn.customerId) ?? 0) + txn.points);

  let expired = 0;
  for (const [customerId, points] of byCustomer) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) continue;
    const toExpire = Math.min(points, customer.loyaltyPoints);
    if (toExpire <= 0) continue;

    const balance = customer.loyaltyPoints - toExpire;
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customerId }, data: { loyaltyPoints: balance } }),
      prisma.loyaltyTransaction.create({
        data: {
          tenantId,
          customerId,
          type: 'EXPIRE',
          points: -toExpire,
          balanceAfter: balance,
          reason: 'Points expired',
        },
      }),
    ]);
    expired += toExpire;
  }

  // Clear the expiry marker so the same rows are not processed twice.
  await prisma.loyaltyTransaction.updateMany({
    where: { id: { in: due.map((t) => t.id) } },
    data: { expiresAt: null },
  });

  return { expired, customers: byCustomer.size };
}
