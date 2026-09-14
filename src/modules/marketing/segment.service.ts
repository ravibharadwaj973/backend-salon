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

/**
 * Service ids for a category, resolved once per build rather than per row.
 * Invoice lines store a bare refId with no relation, so a category rule has to
 * become "any of these service ids" before it can be a query.
 */
async function serviceIdsInCategory(tenantId: string, categoryId: string): Promise<string[]> {
  const services = await prisma.service.findMany({
    where: { tenantId, categoryId },
    select: { id: true },
  });
  return services.map((service) => service.id);
}

/** Every category id the rules mention, so they can be resolved in one query. */
function categoryIdsIn(rules: SegmentRules): string[] {
  return [
    ...new Set(
      (rules.conditions ?? [])
        .filter((c) => c.field === 'usedCategory' || c.field === 'notUsedCategory')
        .map((c) => String(c.value)),
    ),
  ];
}

const billedSince = (days: unknown) => dayjs().subtract(Number(days), 'day').toDate();

function conditionToWhere(
  condition: SegmentCondition,
  servicesByCategory: Map<string, string[]>,
): Prisma.CustomerWhereInput {
  const { field, op, value } = condition;
  const isTrue = value !== false && value !== 'false';

  // Behavioural pseudo-fields -------------------------------------------
  switch (field) {
    case 'noVisitDays': {
      const cutoff = billedSince(value);
      return { OR: [{ lastVisitAt: { lte: cutoff } }, { lastVisitAt: null, createdAt: { lte: cutoff } }] };
    }
    case 'visitedWithinDays':
      return { lastVisitAt: { gte: billedSince(value) } };

    /** Harder than "last visit": they may have booked and never turned up. */
    case 'notBilledInLastDays':
      return { invoices: { none: { invoiceDate: { gte: billedSince(value) }, status: { not: 'VOID' } } } };

    case 'newWithinDays':
      return { createdAt: { gte: billedSince(value) } };

    /** The retention question, straight from the rollup column. */
    case 'onlyOneVisit':
      return isTrue ? { totalVisits: 1 } : { totalVisits: { not: 1 } };
    case 'neverVisited':
      return isTrue ? { totalVisits: 0 } : { totalVisits: { gt: 0 } };

    case 'birthdayMonth':
      return { dob: { not: null } };
    case 'birthdayInNextDays':
      return { dob: { not: null } };
    case 'anniversaryInNextDays':
      return { anniversary: { not: null } };

    case 'hasMembership':
      return isTrue
        ? { memberships: { some: { status: 'ACTIVE', endAt: { gte: new Date() } } } }
        : { memberships: { none: { status: 'ACTIVE', endAt: { gte: new Date() } } } };
    case 'membershipExpiringInDays':
      return {
        memberships: {
          some: { status: 'ACTIVE', endAt: { gte: new Date(), lte: dayjs().add(Number(value), 'day').toDate() } },
        },
      };
    case 'hasActivePackage':
      return isTrue ? { packagePurchases: { some: { status: 'ACTIVE' } } } : { packagePurchases: { none: { status: 'ACTIVE' } } };
    case 'packageExpiringInDays':
      return {
        packagePurchases: {
          some: { status: 'ACTIVE', expiresAt: { gte: new Date(), lte: dayjs().add(Number(value), 'day').toDate() } },
        },
      };

    case 'usedService':
      return { invoices: { some: { items: { some: { itemType: 'SERVICE', refId: String(value) } } } } };
    /** The cross-sell list. `none` across invoices, not `some` of a negation. */
    case 'notUsedService':
      return { invoices: { none: { items: { some: { itemType: 'SERVICE', refId: String(value) } } } } };

    case 'usedCategory': {
      const ids = servicesByCategory.get(String(value)) ?? [];
      // An empty category matches nobody, rather than matching everybody.
      if (ids.length === 0) return { id: { in: [] } };
      return { invoices: { some: { items: { some: { itemType: 'SERVICE', refId: { in: ids } } } } } };
    }
    case 'notUsedCategory': {
      const ids = servicesByCategory.get(String(value)) ?? [];
      if (ids.length === 0) return {};
      return { invoices: { none: { items: { some: { itemType: 'SERVICE', refId: { in: ids } } } } } };
    }

    case 'seenStaff':
      return { appointments: { some: { services: { some: { staffId: String(value) } } } } };
    case 'preferredStaffId':
      return { preferredStaffId: String(value) };

    case 'branchId':
      return { branchId: String(value) };
    /** Where they actually go, which is not always where they signed up. */
    case 'visitedBranch':
      return { invoices: { some: { branchId: String(value), status: { not: 'VOID' } } } };

    case 'tag':
    case 'tags':
      return op === 'nin' ? { NOT: { tags: { has: String(value) } } } : { tags: { has: String(value) } };

    case 'hasOutstanding':
      return isTrue ? { outstanding: { gt: 0 } } : { outstanding: { lte: 0 } };

    case 'ratedBelow':
      return { feedback: { some: { rating: { lte: Number(value) } } } };
    case 'ratedAtLeast':
      return { feedback: { some: { rating: { gte: Number(value) } } } };
    case 'noFeedback':
      return isTrue ? { feedback: { none: {} } } : { feedback: { some: {} } };

    case 'hasEmail':
      return isTrue ? { email: { not: null } } : { email: null };

    /**
     * Reachable means both halves: we hold an address for that channel and
     * they agreed to hear from us on it. Either alone is a message that never
     * arrives, or one that should not be sent.
     */
    case 'reachableOn': {
      const channel = String(value).toUpperCase();
      if (channel === 'EMAIL') return { email: { not: null }, emailConsent: 'OPTED_IN' };
      if (channel === 'SMS') return { phone: { not: '' }, smsConsent: 'OPTED_IN' };
      return { phone: { not: '' }, whatsappConsent: 'OPTED_IN' };
    }

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

export async function buildSegmentWhere(
  tenantId: string,
  rules: SegmentRules,
  branchId?: string,
): Promise<Prisma.CustomerWhereInput> {
  // Category rules become lists of service ids first — one query for all of
  // them, rather than one per condition.
  const categoryIds = categoryIdsIn(rules);
  const servicesByCategory = new Map<string, string[]>();
  for (const categoryId of categoryIds) {
    servicesByCategory.set(categoryId, await serviceIdsInCategory(tenantId, categoryId));
  }

  const conditions = (rules.conditions ?? []).map((condition) => conditionToWhere(condition, servicesByCategory));
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

/**
 * Occasions cannot be expressed in Prisma, because they ignore the year: a
 * birthday on 2 January is "in the next 7 days" on 28 December. The query
 * narrows to people who have a date at all; the day-of-year comparison happens
 * here, on that much smaller set.
 */
export function daysUntilAnniversaryOf(date: Date, from = new Date()): number {
  const today = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let next = new Date(Date.UTC(today.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Already gone this year, so the next one is next year — which is what makes
  // late December work for an early January birthday.
  if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate()));
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

interface Datable {
  dob: Date | null;
  anniversary?: Date | null;
}

function postFilter<T extends Datable>(customers: T[], rules: SegmentRules): T[] {
  const rule = (field: string) => rules.conditions?.find((c) => c.field === field);
  let rows = customers;

  const month = rule('birthdayMonth');
  if (month) {
    const wanted = Number(month.value);
    rows = rows.filter((c) => c.dob && c.dob.getUTCMonth() + 1 === wanted);
  }

  const birthdaySoon = rule('birthdayInNextDays');
  if (birthdaySoon) {
    const within = Number(birthdaySoon.value);
    rows = rows.filter((c) => c.dob && daysUntilAnniversaryOf(c.dob) <= within);
  }

  const anniversarySoon = rule('anniversaryInNextDays');
  if (anniversarySoon) {
    const within = Number(anniversarySoon.value);
    rows = rows.filter((c) => c.anniversary && daysUntilAnniversaryOf(c.anniversary) <= within);
  }

  return rows;
}

/** True when the count from the database still has to be trimmed in memory. */
function hasPostFilter(rules: SegmentRules): boolean {
  return (rules.conditions ?? []).some((c) =>
    ['birthdayMonth', 'birthdayInNextDays', 'anniversaryInNextDays'].includes(c.field),
  );
}

export async function previewSegment(rules: SegmentRules, branchId?: string, sampleSize = 10) {
  const tenantId = requireTenantId();
  const where = await buildSegmentWhere(tenantId, rules, branchId);

  /**
   * An occasion rule is applied in memory, so `count(where)` would overstate
   * the audience — sometimes wildly, since "has a birthday on file" matches
   * most of the book. When one is in play the rows are pulled and counted
   * properly. Capped, because a preview must stay fast; past the cap the count
   * is marked approximate rather than quietly wrong.
   */
  const POST_FILTER_CAP = 20_000;

  if (hasPostFilter(rules)) {
    const rows = await prisma.customer.findMany({
      where,
      take: POST_FILTER_CAP,
      orderBy: { totalSpent: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        dob: true,
        anniversary: true,
        tier: true,
        totalVisits: true,
        totalSpent: true,
        lastVisitAt: true,
        whatsappConsent: true,
        emailConsent: true,
      },
    });
    const matched = postFilter(rows, rules);
    return {
      count: matched.length,
      approximate: rows.length === POST_FILTER_CAP,
      whatsappReachable: matched.filter((c) => c.whatsappConsent === 'OPTED_IN' && c.phone).length,
      emailReachable: matched.filter((c) => c.emailConsent === 'OPTED_IN' && c.email).length,
      sample: matched.slice(0, sampleSize),
    };
  }

  const [count, sample, whatsapp, email] = await Promise.all([
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
        email: true,
        dob: true,
        anniversary: true,
        tier: true,
        totalVisits: true,
        totalSpent: true,
        lastVisitAt: true,
        whatsappConsent: true,
        emailConsent: true,
      },
    }),
    prisma.customer.count({ where: { ...where, whatsappConsent: 'OPTED_IN' } }),
    prisma.customer.count({ where: { ...where, emailConsent: 'OPTED_IN', email: { not: null } } }),
  ]);

  return { count, approximate: false, whatsappReachable: whatsapp, emailReachable: email, sample };
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
  const where = await buildSegmentWhere(segment.tenantId, rules);

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
    select: { id: true, dob: true, anniversary: true, phone: true, email: true },
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
