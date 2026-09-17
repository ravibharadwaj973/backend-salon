import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { dayjs } from '../../core/dates';
import { CONTACT_SELECT, reachAll, reachAllInDb } from './reach';
import type { Reach } from './reach';
import type { TemplateCategory } from '@prisma/client';

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

    /**
     * THE CUSTOMER'S OWN CLOCK.
     *
     * These read the columns maintained beside the other rollups, so "late for
     * them" is an indexed query rather than a pass over the whole book. The
     * work is done when a bill is raised, not when a campaign is sent.
     */
    case 'lifecycleStage': {
      const stages = (Array.isArray(value) ? value : [value]).map(String) as Prisma.CustomerWhereInput['lifecycleStage'][];
      if (op === 'nin') return { lifecycleStage: { notIn: stages as never } };
      return { lifecycleStage: { in: stages as never } };
    }

    /** Due within N days, on their own cycle — including anyone already due. */
    case 'dueWithinDays':
      return {
        expectedNextVisitAt: { not: null, lte: dayjs().add(Number(value), 'day').toDate() },
      };

    /**
     * Past due by N days. Not the same as "N days since their last visit":
     * a customer due every 21 days who came 40 days ago is 19 days overdue,
     * while a six-monthly customer at 40 days is not overdue at all.
     */
    case 'overdueByDays':
      return {
        expectedNextVisitAt: { not: null, lte: dayjs().subtract(Number(value), 'day').toDate() },
      };

    case 'visitIntervalDays':
      return { visitIntervalDays: numericFilter(op, value) as Prisma.IntNullableFilter };

    /**
     * Whether the rhythm is earned or borrowed from the salon default. Matters
     * for a campaign that leans on timing: acting on a guessed cycle is how a
     * customer gets chased two weeks early.
     */
    case 'hasKnownRhythm':
      return isTrue ? { visitIntervalDays: { not: null } } : { visitIntervalDays: null };

    case 'noShowCount':
      return { noShowCount: numericFilter(op, value) as Prisma.IntFilter };

    case 'lastServiceCategory': {
      const ids = (Array.isArray(value) ? value : [value]).map(String);
      return { lastServiceCategoryId: { in: ids } };
    }

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
        dob: true,
        anniversary: true,
        tier: true,
        totalVisits: true,
        totalSpent: true,
        lastVisitAt: true,
        // phone, email and the three consent columns — the sample shows them
        // and reachability counts them, so they come from one place.
        ...CONTACT_SELECT,
      },
    });
    const matched = postFilter(rows, rules);
    return {
      count: matched.length,
      approximate: rows.length === POST_FILTER_CAP,
      // Counted from the rows we already pulled, so it costs nothing extra.
      reach: reachAll(matched, 'MARKETING'),
      sample: matched.slice(0, sampleSize),
    };
  }

  const [count, sample, reach] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      take: sampleSize,
      orderBy: { totalSpent: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        dob: true,
        anniversary: true,
        tier: true,
        totalVisits: true,
        totalSpent: true,
        lastVisitAt: true,
        // phone, email and the three consent columns — the sample shows them
        // and reachability counts them, so they come from one place.
        ...CONTACT_SELECT,
      },
    }),
    reachAllInDb(prisma, where, 'MARKETING'),
  ]);

  return { count, approximate: false, reach, sample };
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

/** One segment, with how many campaigns have used it. */
export async function getSegment(id: string) {
  const segment = await prisma.segment.findUnique({
    where: { id },
    include: { _count: { select: { campaigns: true } } },
  });
  if (!segment) throw NotFound('Segment');
  return segment;
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

/**
 * Resolve a segment to concrete customer ids, ready for a campaign send.
 *
 * `reachableOn` drops anyone the channel cannot actually reach. Phone is
 * required on every customer, so it only bites for email: a salon's book is
 * mostly phone numbers, and a third of it typically has no email address at
 * all. Without this the campaign walks every one of them, queueMessage returns
 * null at the last moment, and the run reports hundreds of unexplained skips.
 *
 * Counting them would be worse than pointless — it would bill the salon for
 * messages that were never going to exist.
 */
export async function resolveMembers(
  segmentId: string,
  options: { requireConsent?: 'WHATSAPP' | 'SMS' | 'EMAIL'; reachableOn?: 'WHATSAPP' | 'SMS' | 'EMAIL' } = {},
) {
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

  // An empty string is as unreachable as null, and both occur: the CSV import
  // stores a blank cell as null, while an edited-then-cleared field can leave
  // "". Postgres treats them as different values, so both are excluded.
  const reachableField =
    options.reachableOn === 'EMAIL'
      ? { email: { not: null as string | null }, NOT: { email: '' } }
      : options.reachableOn === 'WHATSAPP' || options.reachableOn === 'SMS'
        ? { NOT: { phone: '' } }
        : {};

  const customers = await prisma.customer.findMany({
    where: { ...where, ...consentField, ...reachableField },
    select: { id: true, dob: true, anniversary: true, phone: true, email: true },
    take: 50_000,
  });

  const filtered = postFilter(customers, rules);

  // Only refresh the stored size on an unfiltered resolve. A campaign asking
  // "who can I email?" must not overwrite the segment's real membership count
  // with the smaller reachable-by-email number.
  if (!options.requireConsent && !options.reachableOn) {
    await prisma.segment.update({
      where: { id: segmentId },
      data: { lastCount: filtered.length, lastComputedAt: new Date() },
    });
  }

  return filtered;
}

/**
 * How many of a saved segment each channel can actually reach.
 *
 * This is the number a campaign is about to send, worked out the same way the
 * send itself works it out — same rules, same post-filter, same consent test —
 * so the figure on the confirmation screen is the figure that goes out. A
 * confirmation that says 2,400 and sends 900 is worse than no confirmation,
 * because the owner stops reading it.
 */
export async function segmentReach(segmentId: string, category: TemplateCategory = 'MARKETING'): Promise<Reach> {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw NotFound('Segment');

  const rules = segment.rules as unknown as SegmentRules;
  const where = await buildSegmentWhere(segment.tenantId, rules);

  // An occasion rule ("birthday this week") is applied in memory, so counting
  // in the database would count people the send will skip.
  if (hasPostFilter(rules)) {
    const rows = await prisma.customer.findMany({
      where,
      select: { dob: true, anniversary: true, ...CONTACT_SELECT },
      take: 50_000,
    });
    return reachAll(postFilter(rows, rules), category);
  }

  return reachAllInDb(prisma, where, category);
}

/**
 * Who is actually in a saved segment, a page at a time.
 *
 * A segment is a rule, and a rule is only as trustworthy as the people it
 * picks. "2,412 customers" is a number somebody either believes or does not;
 * seeing that the list is full of the right names is what makes them press
 * send. It is also the only way to find a rule that is subtly wrong — an
 * off-by-one on days, a tag that matches more than it looks like it should.
 *
 * Each row carries what the rule was probably about (visits, spend, last
 * visit) and whether they can actually be reached, so the list answers "is
 * this the right group?" and "will they get it?" together.
 */
export async function segmentMembers(
  segmentId: string,
  input: { page?: number; pageSize?: number } = {},
) {
  const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw NotFound('Segment');

  const rules = segment.rules as unknown as SegmentRules;
  const where = await buildSegmentWhere(segment.tenantId, rules);
  const { skip, take, page, pageSize } = pageParams(input);

  const select = {
    id: true,
    code: true,
    firstName: true,
    lastName: true,
    tier: true,
    totalVisits: true,
    totalSpent: true,
    lastVisitAt: true,
    dob: true,
    anniversary: true,
    ...CONTACT_SELECT,
  };

  /**
   * An occasion rule is applied in memory, so the database cannot paginate:
   * page 2 of the query is not page 2 of the answer. Those segments are read
   * up to the cap and paged here instead — the same cap resolveMembers uses,
   * so the list and the send agree.
   */
  if (hasPostFilter(rules)) {
    const rows = await prisma.customer.findMany({
      where,
      select,
      take: 50_000,
      orderBy: { totalSpent: 'desc' },
    });
    const matched = postFilter(rows, rules);
    return { items: matched.slice(skip, skip + take), total: matched.length, page, pageSize };
  }

  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, select, skip, take, orderBy: { totalSpent: 'desc' } }),
    prisma.customer.count({ where }),
  ]);

  return { items, total, page, pageSize };
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
