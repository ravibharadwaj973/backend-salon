import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { dayjs } from '../../core/dates';

/**
 * Segment rules are stored as JSON so owners can build audiences in the UI
 * without a migration. They compile down to a Prisma `where`, which keeps the
 * matching in the database rather than in memory.
 *
 *   {
 *     "match": "all",
 *     "conditions": [
 *       { "field": "noVisitDays", "op": "gte", "value": 45 },
 *       { "field": "totalVisits", "op": "gte", "value": 2 },
 *       { "field": "tier",        "op": "in",  "value": ["GOLD", "VIP"] }
 *     ]
 *   }
 */
export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'contains'
  | 'has'
  | 'between'
  | 'before'
  | 'after'
  | 'isNull'
  | 'notNull';

export interface SegmentCondition {
  field: string;
  op: RuleOperator;
  value?: unknown;
}

export interface SegmentRules {
  match?: 'all' | 'any';
  conditions: SegmentCondition[];
}

const NUMERIC_FIELDS = new Set(['totalVisits', 'totalSpent', 'avgBill', 'loyaltyPoints', 'walletBalance', 'outstanding']);
const STRING_FIELDS = new Set(['city', 'pincode', 'firstName', 'lastName', 'email', 'phone']);
const ENUM_FIELDS = new Set(['tier', 'gender', 'source', 'whatsappConsent', 'smsConsent', 'emailConsent']);
const DATE_FIELDS = new Set(['createdAt', 'lastVisitAt', 'firstVisitAt', 'dob', 'anniversary']);

function numericFilter(op: RuleOperator, value: unknown): Prisma.IntFilter | Prisma.DecimalFilter | number {
  const num = Number(value);
  switch (op) {
    case 'eq':
      return num;
    case 'neq':
      return { not: num };
    case 'gt':
      return { gt: num };
    case 'gte':
      return { gte: num };
    case 'lt':
      return { lt: num };
    case 'lte':
      return { lte: num };
    case 'between': {
      const [min, max] = value as [number, number];
      return { gte: Number(min), lte: Number(max) };
    }
    default:
      throw BadRequest(`Operator ${op} is not valid for a numeric field`);
  }
}

function dateFilter(op: RuleOperator, value: unknown): Prisma.DateTimeNullableFilter {
  const asDate = (v: unknown) => (typeof v === 'number' ? dayjs().subtract(v, 'day').toDate() : new Date(String(v)));
  switch (op) {
    case 'before':
    case 'lt':
    case 'lte':
      return { lte: asDate(value) };
    case 'after':
    case 'gt':
    case 'gte':
      return { gte: asDate(value) };
    case 'between': {
      const [from, to] = value as [string, string];
      return { gte: new Date(from), lte: new Date(to) };
    }
    case 'isNull':
      return { equals: null };
    case 'notNull':
      return { not: null };
    default:
      throw BadRequest(`Operator ${op} is not valid for a date field`);
  }
}

function conditionToWhere(condition: SegmentCondition): Prisma.CustomerWhereInput {
  const { field, op, value } = condition;

  // Behavioural pseudo-fields -------------------------------------------
  switch (field) {
    case 'noVisitDays': {
      const cutoff = dayjs().subtract(Number(value), 'day').toDate();
      return { OR: [{ lastVisitAt: { lte: cutoff } }, { lastVisitAt: null, createdAt: { lte: cutoff } }] };
    }
    case 'visitedWithinDays':
      return { lastVisitAt: { gte: dayjs().subtract(Number(value), 'day').toDate() } };
    case 'birthdayMonth':
      return { dob: { not: null } };
    case 'hasMembership':
      return value === false
        ? { memberships: { none: { status: 'ACTIVE', endAt: { gte: new Date() } } } }
        : { memberships: { some: { status: 'ACTIVE', endAt: { gte: new Date() } } } };
    case 'membershipExpiringInDays':
      return {
        memberships: {
          some: {
            status: 'ACTIVE',
            endAt: { gte: new Date(), lte: dayjs().add(Number(value), 'day').toDate() },
          },
        },
      };
    case 'hasActivePackage':
      return value === false
        ? { packagePurchases: { none: { status: 'ACTIVE' } } }
        : { packagePurchases: { some: { status: 'ACTIVE' } } };
    case 'usedService':
      return { invoices: { some: { items: { some: { itemType: 'SERVICE', refId: String(value) } } } } };
    case 'seenStaff':
      return { appointments: { some: { services: { some: { staffId: String(value) } } } } };
    case 'branchId':
      return { branchId: String(value) };
    case 'tag':
    case 'tags':
      return op === 'nin' ? { NOT: { tags: { has: String(value) } } } : { tags: { has: String(value) } };
    case 'hasOutstanding':
      return value === false ? { outstanding: { lte: 0 } } : { outstanding: { gt: 0 } };
    case 'ratedBelow':
      return { feedback: { some: { rating: { lte: Number(value) } } } };
    default:
      break;
  }

  // Direct column fields -------------------------------------------------
  if (NUMERIC_FIELDS.has(field)) {
    return { [field]: numericFilter(op, value) } as Prisma.CustomerWhereInput;
  }
  if (DATE_FIELDS.has(field)) {
    return { [field]: dateFilter(op, value) } as Prisma.CustomerWhereInput;
  }
  if (ENUM_FIELDS.has(field)) {
    if (op === 'in') return { [field]: { in: value as string[] } } as Prisma.CustomerWhereInput;
    if (op === 'nin') return { [field]: { notIn: value as string[] } } as Prisma.CustomerWhereInput;
    return { [field]: value } as Prisma.CustomerWhereInput;
  }
  if (STRING_FIELDS.has(field)) {
    if (op === 'contains') {
      return { [field]: { contains: String(value), mode: 'insensitive' } } as Prisma.CustomerWhereInput;
    }
    if (op === 'in') return { [field]: { in: value as string[] } } as Prisma.CustomerWhereInput;
    return { [field]: value } as Prisma.CustomerWhereInput;
  }

  throw BadRequest(`Unknown segment field: ${field}`);
}

export function buildSegmentWhere(tenantId: string, rules: SegmentRules, branchId?: string): Prisma.CustomerWhereInput {
  const conditions = (rules.conditions ?? []).map(conditionToWhere);
  const base: Prisma.CustomerWhereInput = {
    tenantId,
    isActive: true,
    isBlacklisted: false,
    ...optionalBranchFilter(branchId),
  };

  if (!conditions.length) return base;

  // Merge, never overwrite: `base` already carries the branch scope under
  // `AND`, and replacing it would quietly widen the segment to every branch.
  const scoped = Array.isArray(base.AND) ? base.AND : base.AND ? [base.AND] : [];
  return rules.match === 'any'
    ? { ...base, AND: [...scoped, { OR: conditions }] }
    : { ...base, AND: [...scoped, ...conditions] };
}

/** Birthday-month filtering cannot be expressed in Prisma, so it is applied after the query. */
function postFilter<T extends { dob: Date | null }>(customers: T[], rules: SegmentRules): T[] {
  const monthRule = rules.conditions?.find((c) => c.field === 'birthdayMonth');
  if (!monthRule) return customers;
  const month = Number(monthRule.value);
  return customers.filter((c) => c.dob && c.dob.getUTCMonth() + 1 === month);
}

export async function previewSegment(rules: SegmentRules, branchId?: string, sampleSize = 10) {
  const tenantId = requireTenantId();
  const where = buildSegmentWhere(tenantId, rules, branchId);

  const [count, sample, reachable] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      take: sampleSize,
      orderBy: { totalSpent: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        dob: true,
        tier: true,
        totalVisits: true,
        totalSpent: true,
        lastVisitAt: true,
        whatsappConsent: true,
      },
    }),
    prisma.customer.count({ where: { ...where, whatsappConsent: 'OPTED_IN' } }),
  ]);

  return { count, whatsappReachable: reachable, sample: postFilter(sample, rules) };
}

export async function listSegments(input: { page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const [items, total] = await Promise.all([
    prisma.segment.findMany({
      where: { tenantId },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { campaigns: true } } },
    }),
    prisma.segment.count({ where: { tenantId } }),
  ]);

  return { items, total, page, pageSize };
}

export async function createSegment(input: { name: string; description?: string; rules: SegmentRules; isDynamic?: boolean }) {
  const tenantId = requireTenantId();
  const clash = await prisma.segment.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A segment with this name already exists');

  const preview = await previewSegment(input.rules);

  return prisma.segment.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      rules: input.rules as unknown as Prisma.InputJsonValue,
      isDynamic: input.isDynamic ?? true,
      lastCount: preview.count,
      lastComputedAt: new Date(),
    },
  });
}

export async function updateSegment(id: string, input: { name?: string; description?: string; rules?: SegmentRules }) {
  const segment = await prisma.segment.findUnique({ where: { id } });
  if (!segment) throw NotFound('Segment');

  const rules = input.rules ?? (segment.rules as unknown as SegmentRules);
  const preview = await previewSegment(rules);

  return prisma.segment.update({
    where: { id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.rules ? { rules: input.rules as unknown as Prisma.InputJsonValue } : {}),
      lastCount: preview.count,
      lastComputedAt: new Date(),
    },
  });
}

export async function deleteSegment(id: string) {
  const inUse = await prisma.campaign.count({ where: { segmentId: id, status: { in: ['SCHEDULED', 'RUNNING'] } } });
  if (inUse > 0) throw Conflict('This segment is used by a running campaign');
  return prisma.segment.delete({ where: { id } });
}

/** Resolve a segment to concrete customer ids, ready for a campaign send. */
export async function resolveMembers(segmentId: string, options: { requireConsent?: 'WHATSAPP' | 'SMS' | 'EMAIL' } = {}) {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw NotFound('Segment');

  const rules = segment.rules as unknown as SegmentRules;
  const where = buildSegmentWhere(segment.tenantId, rules);

  const consentField =
    options.requireConsent === 'WHATSAPP'
      ? { whatsappConsent: 'OPTED_IN' as const }
      : options.requireConsent === 'SMS'
        ? { smsConsent: 'OPTED_IN' as const }
        : options.requireConsent === 'EMAIL'
          ? { emailConsent: 'OPTED_IN' as const }
          : {};

  const customers = await prisma.customer.findMany({
    where: { ...where, ...consentField },
    select: { id: true, dob: true, phone: true, email: true },
    take: 50_000,
  });

  const filtered = postFilter(customers, rules);

  await prisma.segment.update({
    where: { id: segmentId },
    data: { lastCount: filtered.length, lastComputedAt: new Date() },
  });

  return filtered;
}

/** Materialise a static snapshot of the segment's members. */
export async function snapshotSegment(segmentId: string) {
  const tenantId = requireTenantId();
  const members = await resolveMembers(segmentId);

  await prisma.segmentMember.deleteMany({ where: { segmentId } });
  if (members.length) {
    await prisma.segmentMember.createMany({
      data: members.map((m) => ({ tenantId, segmentId, customerId: m.id })),
      skipDuplicates: true,
    });
  }

  return { segmentId, members: members.length };
}
