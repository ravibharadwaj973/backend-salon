import type { ChallengeType, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, pctOf } from '../../core/money';
import { addDays, dayjs } from '../../core/dates';
import { logger } from '../../core/logger';

export interface ChallengeInput {
  name: string;
  description?: string;
  type: ChallengeType;
  targetValue: number;
  durationDays?: number;
  rewardPoints?: number;
  startAt: Date;
  endAt: Date;
}

export async function listChallenges(input: { page?: number; pageSize?: number; activeOnly?: boolean }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.ChallengeWhereInput = {
    tenantId,
    ...(input.activeOnly ? { isActive: true, endAt: { gte: new Date() } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.challenge.findMany({
      where,
      skip,
      take,
      orderBy: { startAt: 'desc' },
      include: { _count: { select: { enrollments: true } } },
    }),
    prisma.challenge.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function createChallenge(input: ChallengeInput) {
  const tenantId = requireTenantId();
  const clash = await prisma.challenge.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A challenge with this name already exists');

  return prisma.challenge.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      targetValue: input.targetValue,
      durationDays: input.durationDays ?? 30,
      rewardPoints: input.rewardPoints ?? 0,
      startAt: input.startAt,
      endAt: input.endAt,
    },
  });
}

export async function updateChallenge(id: string, input: Partial<ChallengeInput> & { isActive?: boolean }) {
  const challenge = await prisma.challenge.findUnique({ where: { id } });
  if (!challenge) throw NotFound('Challenge');
  return prisma.challenge.update({ where: { id }, data: input as Prisma.ChallengeUpdateInput });
}

export async function enroll(challengeId: string, customerId: string) {
  const tenantId = requireTenantId();
  const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });
  if (!challenge) throw NotFound('Challenge');
  if (!challenge.isActive || challenge.endAt < new Date()) throw Conflict('This challenge is no longer open');

  const existing = await prisma.challengeEnrollment.findFirst({ where: { challengeId, customerId } });
  if (existing) return existing;

  return prisma.challengeEnrollment.create({ data: { tenantId, challengeId, customerId } });
}

export async function listEnrollments(customerId: string) {
  return prisma.challengeEnrollment.findMany({
    where: { customerId },
    include: { challenge: true },
    orderBy: { enrolledAt: 'desc' },
  });
}

/**
 * Recomputes a customer's progress across every challenge they are enrolled in.
 * Called after each invoice so progress reflects real, paid-for behaviour.
 */
export async function updateProgress(customerId: string, tenantId?: string) {
  const tid = tenantId ?? requireTenantId();

  const enrollments = await runUnscoped(() =>
    prisma.challengeEnrollment.findMany({
      where: { customerId, status: 'ACTIVE', challenge: { tenantId: tid, isActive: true } },
      include: { challenge: true },
    }),
  );
  if (!enrollments.length) return { updated: 0 };

  let completed = 0;

  for (const enrollment of enrollments) {
    const { challenge } = enrollment;
    const from = enrollment.enrolledAt > challenge.startAt ? enrollment.enrolledAt : challenge.startAt;
    const to = challenge.endAt;

    let progress = d(0);

    switch (challenge.type) {
      case 'VISIT_COUNT': {
        const count = await runUnscoped(() =>
          prisma.invoice.count({
            where: { customerId, invoiceDate: { gte: from, lte: to }, status: { not: 'VOID' } },
          }),
        );
        progress = d(count);
        break;
      }
      case 'SPEND_AMOUNT': {
        const agg = await runUnscoped(() =>
          prisma.invoice.aggregate({
            where: { customerId, invoiceDate: { gte: from, lte: to }, status: { not: 'VOID' } },
            _sum: { grandTotal: true },
          }),
        );
        progress = d(agg._sum.grandTotal ?? 0);
        break;
      }
      case 'SERVICE_VARIETY': {
        const rows = await runUnscoped(() =>
          prisma.invoiceItem.findMany({
            where: {
              itemType: 'SERVICE',
              invoice: { customerId, invoiceDate: { gte: from, lte: to }, status: { not: 'VOID' } },
            },
            select: { refId: true },
            distinct: ['refId'],
          }),
        );
        progress = d(rows.length);
        break;
      }
      case 'REFERRAL_COUNT': {
        const count = await runUnscoped(() =>
          prisma.customer.count({ where: { referredById: customerId, createdAt: { gte: from, lte: to } } }),
        );
        progress = d(count);
        break;
      }
      case 'STREAK': {
        const customer = await runUnscoped(() => prisma.customer.findUnique({ where: { id: customerId } }));
        progress = d(customer?.currentStreak ?? 0);
        break;
      }
    }

    const isComplete = progress.greaterThanOrEqualTo(challenge.targetValue);

    await runUnscoped(() =>
      prisma.challengeEnrollment.update({
        where: { id: enrollment.id },
        data: {
          progress,
          ...(isComplete ? { status: 'COMPLETED', completedAt: new Date() } : {}),
        },
      }),
    );

    if (isComplete && challenge.rewardPoints > 0) {
      completed += 1;
      await runUnscoped(async () => {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (!customer) return;
        const balance = customer.loyaltyPoints + challenge.rewardPoints;
        await prisma.customer.update({ where: { id: customerId }, data: { loyaltyPoints: balance } });
        await prisma.loyaltyTransaction.create({
          data: {
            tenantId: tid,
            customerId,
            type: 'BONUS',
            points: challenge.rewardPoints,
            balanceAfter: balance,
            reason: `Challenge completed: ${challenge.name}`,
          },
        });
      }).catch((err: unknown) => logger.warn({ err }, 'challenge reward failed'));
    }
  }

  return { updated: enrollments.length, completed };
}

/**
 * Visit streaks. A streak survives while the gap between visits stays inside the
 * window (default 45 days), which is roughly a salon's natural rhythm.
 */
export async function updateStreak(customerId: string, windowDays = 45) {
  const customer = await runUnscoped(() => prisma.customer.findUnique({ where: { id: customerId } }));
  if (!customer) return null;

  const visits = await runUnscoped(() =>
    prisma.invoice.findMany({
      where: { customerId, status: { not: 'VOID' } },
      orderBy: { invoiceDate: 'asc' },
      select: { invoiceDate: true },
    }),
  );

  let current = 0;
  let longest = 0;
  let previous: Date | null = null;

  for (const visit of visits) {
    if (!previous || dayjs(visit.invoiceDate).diff(dayjs(previous), 'day') <= windowDays) {
      current += 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    previous = visit.invoiceDate;
  }

  // A lapsed customer has no live streak.
  if (previous && dayjs().diff(dayjs(previous), 'day') > windowDays) current = 0;

  return runUnscoped(() =>
    prisma.customer.update({
      where: { id: customerId },
      data: { currentStreak: current, longestStreak: Math.max(longest, customer.longestStreak) },
    }),
  );
}

/** Top referrers — the leaderboard the spec asks for. */
export async function referralLeaderboard(input: { from?: Date; to?: Date; limit?: number }) {
  const tenantId = requireTenantId();

  const grouped = await prisma.customer.groupBy({
    by: ['referredById'],
    where: {
      tenantId,
      referredById: { not: null },
      ...(input.from || input.to
        ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
        : {}),
    },
    _count: { _all: true },
  });

  const referrerIds = grouped.map((g) => g.referredById!).filter(Boolean);
  if (!referrerIds.length) return [];

  const [referrers, revenueRows] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: referrerIds } },
      select: { id: true, firstName: true, lastName: true, phone: true, tier: true, loyaltyPoints: true },
    }),
    prisma.customer.groupBy({
      by: ['referredById'],
      where: { tenantId, referredById: { in: referrerIds } },
      _sum: { totalSpent: true },
    }),
  ]);

  const byId = new Map(referrers.map((r) => [r.id, r]));
  const revenueById = new Map(revenueRows.map((r) => [r.referredById, r._sum.totalSpent ?? 0]));

  return grouped
    .map((g) => {
      const referrer = byId.get(g.referredById!);
      return {
        customerId: g.referredById,
        name: referrer ? `${referrer.firstName} ${referrer.lastName ?? ''}`.trim() : 'Unknown',
        phone: referrer?.phone ?? null,
        tier: referrer?.tier ?? null,
        referrals: g._count._all,
        revenueFromReferrals: revenueById.get(g.referredById) ?? 0,
      };
    })
    .sort((a, b) => b.referrals - a.referrals)
    .slice(0, input.limit ?? 10);
}

/** Tier distribution and streak stats for the engagement dashboard. */
export async function engagementSummary(branchId?: string) {
  const tenantId = requireTenantId();
  const where: Prisma.CustomerWhereInput = { tenantId, isActive: true, ...(branchId ? { branchId } : {}) };

  const [tiers, streaks, challengeStats, total] = await Promise.all([
    prisma.customer.groupBy({ by: ['tier'], where, _count: { _all: true }, _sum: { totalSpent: true } }),
    prisma.customer.aggregate({ where, _avg: { currentStreak: true }, _max: { longestStreak: true } }),
    prisma.challengeEnrollment.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
    prisma.customer.count({ where }),
  ]);

  return {
    totalCustomers: total,
    tiers: tiers.map((t) => ({
      tier: t.tier,
      customers: t._count._all,
      sharePct: pctOf(t._count._all, total || 1),
      revenue: t._sum.totalSpent ?? 0,
    })),
    streaks: {
      average: streaks._avg.currentStreak ?? 0,
      longest: streaks._max.longestStreak ?? 0,
    },
    challenges: Object.fromEntries(challengeStats.map((c) => [c.status, c._count._all])),
  };
}

/** Auto-enrols eligible customers into every live challenge. */
export async function autoEnrollActiveChallenges(tenantId: string) {
  const challenges = await runUnscoped(() =>
    prisma.challenge.findMany({ where: { tenantId, isActive: true, endAt: { gte: new Date() } } }),
  );
  if (!challenges.length) return { enrolled: 0 };

  let enrolled = 0;

  for (const challenge of challenges) {
    const customers = await runUnscoped(() =>
      prisma.customer.findMany({
        where: {
          tenantId,
          isActive: true,
          enrollments: { none: { challengeId: challenge.id } },
          lastVisitAt: { gte: addDays(new Date(), -120) },
        },
        select: { id: true },
        take: 2000,
      }),
    );
    if (!customers.length) continue;

    await runUnscoped(() =>
      prisma.challengeEnrollment.createMany({
        data: customers.map((c) => ({ tenantId, challengeId: challenge.id, customerId: c.id })),
        skipDuplicates: true,
      }),
    );
    enrolled += customers.length;
  }

  return { enrolled };
}

export const totalReferralValue = (rows: { revenueFromReferrals: Prisma.Decimal | number }[]) =>
  rows.reduce<Prisma.Decimal>((acc, r) => add(acc, r.revenueFromReferrals), d(0));
