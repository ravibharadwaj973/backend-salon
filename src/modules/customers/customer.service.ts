import Papa from 'papaparse';
import type { ConsentStatus, CustomerTier, Gender, LeadSource, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { activeBranchId, branchFilter, optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { normalizePhone, sequenceNumber, toDisplayName } from '../../core/ids';
import { visitRhythm } from './visit-rhythm';
import { add, div, round2 } from '../../core/money';
import { dateKey, dayjs, DEFAULT_TZ } from '../../core/dates';
import { logger } from '../../core/logger';
import { assertCustomerAllowed } from '../quotas/limits.service';

export interface CustomerInput {
  firstName: string;
  lastName?: string;
  phone: string;
  altPhone?: string;
  email?: string;
  gender?: Gender;
  dob?: Date;
  anniversary?: Date;
  addressLine?: string;
  city?: string;
  pincode?: string;
  branchId?: string;
  source?: LeadSource;
  sourceDetail?: string;
  referredById?: string;
  preferredStaffId?: string;
  tags?: string[];
  notes?: string;
  whatsappConsent?: ConsentStatus;
  smsConsent?: ConsentStatus;
  emailConsent?: ConsentStatus;
  isActive?: boolean;
  isBlacklisted?: boolean;
  tier?: CustomerTier;
}

export interface ListCustomersInput {
  page?: number;
  pageSize?: number;
  q?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  branchId?: string;
  tier?: CustomerTier;
  tag?: string;
  source?: LeadSource;
  isActive?: string;
  hasMembership?: string;
  lastVisitBefore?: Date;
  lastVisitAfter?: Date;
  minVisits?: number;
  minSpent?: number;
  createdFrom?: Date;
  createdTo?: Date;
}

const SORTABLE = new Set(['createdAt', 'lastVisitAt', 'totalSpent', 'totalVisits', 'firstName', 'avgBill']);

export function buildCustomerWhere(tenantId: string, input: ListCustomersInput): Prisma.CustomerWhereInput {
  const q = input.q?.trim();

  // Both the branch scope and a multi-word search want to live in `AND`, and
  // object spread would let the second silently replace the first — dropping
  // the branch scope the moment somebody typed a name, so a receptionist at
  // one shop would see customers from every shop. Merge the arrays instead.
  // Prisma types AND as one object or an array of them, so normalise before
  // concatenating.
  const asList = (value: Prisma.CustomerWhereInput['AND']): Prisma.CustomerWhereInput[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];

  const branch = optionalBranchFilter(input.branchId) as Prisma.CustomerWhereInput;
  const search = searchClause(q);
  const and = [...asList(branch.AND), ...asList(search.AND)];

  return {
    tenantId,
    ...(and.length ? { AND: and } : {}),
    ...(search.OR ? { OR: search.OR } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.tag ? { tags: { has: input.tag } } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.isActive ? { isActive: input.isActive === 'true' } : {}),
    ...(input.minVisits !== undefined ? { totalVisits: { gte: input.minVisits } } : {}),
    ...(input.minSpent !== undefined ? { totalSpent: { gte: input.minSpent } } : {}),
    ...(input.lastVisitBefore || input.lastVisitAfter
      ? {
          lastVisitAt: {
            ...(input.lastVisitBefore ? { lte: input.lastVisitBefore } : {}),
            ...(input.lastVisitAfter ? { gte: input.lastVisitAfter } : {}),
          },
        }
      : {}),
    ...(input.createdFrom || input.createdTo
      ? {
          createdAt: {
            ...(input.createdFrom ? { gte: input.createdFrom } : {}),
            ...(input.createdTo ? { lte: input.createdTo } : {}),
          },
        }
      : {}),
    ...(input.hasMembership === 'true'
      ? { memberships: { some: { status: 'ACTIVE', endAt: { gte: new Date() } } } }
      : {}),
    ...(input.hasMembership === 'false'
      ? { memberships: { none: { status: 'ACTIVE', endAt: { gte: new Date() } } } }
      : {}),
  };
}

/**
 * The search box on the customer list.
 *
 * Two things this has to get right, both of which it previously got wrong.
 *
 * FIRST: a search for text must not include a phone clause. `normalizePhone`
 * strips everything that is not a digit, so "priya" reduced to the empty
 * string and the query became `phone LIKE '%%'` — which matches every row in
 * the table. The OR then matched everything and the filter appeared to do
 * nothing at all. The phone clause is only added when the query actually
 * contains digits.
 *
 * SECOND: "Priya Sharma" must find Priya Sharma. Comparing the whole phrase
 * against firstName and then against lastName can never match a name that
 * spans both columns. So the words are matched independently and ANDed: every
 * word must appear somewhere in the name, email or code. That also means
 * "sharma priya" works, and "pri sha" works, which is how people actually type
 * at a busy counter.
 */
export function searchClause(q: string | undefined): Prisma.CustomerWhereInput {
  const text = q?.trim();
  if (!text) return {};

  // `lookupTerms` already decides what looks like a phone number, and it does
  // it properly: a query is a number only when everything left after removing
  // spaces, +, brackets and dashes is digits. Counting digits alone is not
  // enough — the customer code "C-00003" has five of them, and treating that
  // as a phone number means searching by code silently finds nobody.
  const { phone } = lookupTerms(text);

  if (phone) {
    // The code goes in too, so someone who types "00003" off a printed bill
    // finds C-00003 rather than nothing.
    return {
      OR: [
        { phone: { contains: phone } },
        { altPhone: { contains: phone } },
        { code: { contains: phone, mode: 'insensitive' as const } },
      ],
    };
  }

  const words = text.split(/\s+/).filter(Boolean);

  return {
    AND: words.map((word) => ({
      OR: [
        { firstName: { contains: word, mode: 'insensitive' as const } },
        { lastName: { contains: word, mode: 'insensitive' as const } },
        { email: { contains: word, mode: 'insensitive' as const } },
        { code: { contains: word, mode: 'insensitive' as const } },
      ],
    })),
  };
}

/**
 * The "have they been here before?" lookup behind every place a customer can
 * be typed in fresh — the new-customer form, the walk-in box at booking.
 *
 * Deliberately narrower than listCustomers: it answers one question quickly
 * with a small payload, and it matches on the things a receptionist actually
 * has in hand — a phone number (any spacing or +91 prefix), an email, or a
 * name. `exact` marks a match on the full phone number or email, which is the
 * case the UI should treat as "this *is* them", not "this might be them".
 */
export function lookupTerms(q: string): { text: string; phone: string } {
  const text = q.trim();
  const digits = text.replace(/\D/g, '');
  // "98765 43210", "+91 98765-43210", "(0) 9876" are phones; "priya98" is not.
  const looksLikePhone = digits.length >= 4 && digits.length >= text.replace(/[\s+()-]/g, '').length;
  return { text, phone: looksLikePhone ? normalizePhone(text) : '' };
}

export async function lookupCustomers(q: string, limit = 6) {
  const tenantId = requireTenantId();
  const { text, phone } = lookupTerms(q);
  if (!text) return [];

  // "Priya Sharma" has to find Priya Sharma: every word must match somewhere,
  // each word against first name, last name or email.
  const words = text.split(/\s+/).filter(Boolean);
  const where = phone
    ? { OR: [{ phone: { contains: phone } }, { altPhone: { contains: phone } }] }
    : {
        AND: words.map((word) => ({
          OR: [
            { email: { contains: word, mode: 'insensitive' as const } },
            { firstName: { contains: word, mode: 'insensitive' as const } },
            { lastName: { contains: word, mode: 'insensitive' as const } },
          ],
        })),
      };

  const rows = await prisma.customer.findMany({
    where: { tenantId, isActive: true, ...where },
    orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      code: true,
      firstName: true,
      lastName: true,
      phone: true,
      altPhone: true,
      email: true,
      gender: true,
      dob: true,
      tier: true,
      totalVisits: true,
      totalSpent: true,
      lastVisitAt: true,
      createdAt: true,
    },
  });

  const lowered = text.toLowerCase();
  return rows.map((row) => ({
    ...row,
    exact:
      (phone !== '' && (row.phone === phone || row.altPhone === phone)) ||
      (phone === '' && row.email?.toLowerCase() === lowered),
  }));
}

export async function listCustomers(input: ListCustomersInput) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);
  const where = buildCustomerWhere(tenantId, input);
  const sortBy = input.sortBy && SORTABLE.has(input.sortBy) ? input.sortBy : 'createdAt';

  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: input.sortDir ?? 'desc' },
      select: {
        id: true,
        code: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        gender: true,
        tier: true,
        tags: true,
        totalVisits: true,
        totalSpent: true,
        avgBill: true,
        loyaltyPoints: true,
        walletBalance: true,
        outstanding: true,
        lastVisitAt: true,
        createdAt: true,
        branchId: true,
      },
    }),
    prisma.customer.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

async function nextCustomerCode(tenantId: string): Promise<string> {
  const count = await prisma.customer.count({ where: { tenantId } });
  return sequenceNumber('C', count + 1, 5);
}

export async function createCustomer(input: CustomerInput) {
  const tenantId = requireTenantId();
  const phone = normalizePhone(input.phone);

  // Tidied on the way in, like the phone number beside it. The name is not
  // only read on screen — it is greeted in WhatsApp messages and printed on
  // bills, and "Hi arihant" reads as a mail merge that went wrong.
  input.firstName = toDisplayName(input.firstName) as string;
  if (input.lastName !== undefined) input.lastName = toDisplayName(input.lastName) as string | undefined;

  await assertCustomerAllowed(tenantId);

  const existing = await prisma.customer.findFirst({ where: { tenantId, phone } });
  if (existing) {
    throw Conflict('A customer with this phone number already exists', {
      customerId: existing.id,
      name: `${existing.firstName} ${existing.lastName ?? ''}`.trim(),
    });
  }

  const { branchId, referredById, preferredStaffId, ...rest } = input;
  if (branchId) branchFilter(branchId);

  // The branch they were signed up at, when the counter has one selected. It is
  // where they "live" in branch-scoped lists; they can still be served anywhere.
  const homeBranchId = branchId ?? activeBranchId() ?? null;

  const customer = await prisma.customer.create({
    data: {
      tenantId,
      ...rest,
      phone,
      altPhone: input.altPhone ? normalizePhone(input.altPhone) : null,
      code: await nextCustomerCode(tenantId),
      branchId: homeBranchId,
      referredById: referredById ?? null,
      preferredStaffId: preferredStaffId ?? null,
      consentUpdatedAt: new Date(),
    },
  });

  if (referredById) await awardReferral(tenantId, referredById, customer.id);
  return customer;
}

/** Referral points are only awarded when the loyalty programme is switched on. */
async function awardReferral(tenantId: string, referrerId: string, newCustomerId: string): Promise<void> {
  const program = await prisma.loyaltyProgram.findFirst({ where: { tenantId, isActive: true } });
  if (!program || program.referralPoints <= 0) return;

  const referrer = await prisma.customer.findUnique({ where: { id: referrerId } });
  if (!referrer) return;

  const balance = referrer.loyaltyPoints + program.referralPoints;
  await prisma.$transaction([
    prisma.customer.update({ where: { id: referrerId }, data: { loyaltyPoints: balance } }),
    prisma.loyaltyTransaction.create({
      data: {
        tenantId,
        customerId: referrerId,
        type: 'BONUS',
        points: program.referralPoints,
        balanceAfter: balance,
        reason: `Referral bonus for customer ${newCustomerId}`,
      },
    }),
  ]);
}

export async function updateCustomer(id: string, input: Partial<CustomerInput>) {
  const tenantId = requireTenantId();
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) throw NotFound('Customer');

  if (input.firstName !== undefined) input.firstName = toDisplayName(input.firstName) as string;
  if (input.lastName !== undefined) input.lastName = toDisplayName(input.lastName) as string | undefined;

  if (input.phone) {
    const phone = normalizePhone(input.phone);
    if (phone !== customer.phone) {
      const clash = await prisma.customer.findFirst({ where: { tenantId, phone, id: { not: id } } });
      if (clash) throw Conflict('Another customer already uses this phone number');
      input.phone = phone;
    }
  }

  const consentChanged =
    input.whatsappConsent !== undefined || input.smsConsent !== undefined || input.emailConsent !== undefined;

  return prisma.customer.update({
    where: { id },
    data: {
      ...(input as Prisma.CustomerUpdateInput),
      ...(consentChanged ? { consentUpdatedAt: new Date() } : {}),
    },
  });
}

/**
 * The customer 360 view: everything the front desk needs on one screen.
 */
export async function getCustomerProfile(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, name: true } },
      preferredStaff: { select: { id: true, displayName: true } },
      referredBy: { select: { id: true, firstName: true, lastName: true } },
      hairProfile: true,
      memberships: {
        where: { status: 'ACTIVE' },
        include: { plan: { select: { id: true, name: true, serviceDiscountPct: true } } },
        orderBy: { endAt: 'desc' },
      },
      packagePurchases: {
        where: { status: 'ACTIVE' },
        include: {
          template: { select: { id: true, name: true } },
          items: { include: { service: { select: { id: true, name: true } } } },
        },
      },
      _count: { select: { appointments: true, invoices: true, feedback: true } },
    },
  });
  if (!customer) throw NotFound('Customer');

  const [nextAppointment, lastInvoice, topServices, favouriteStaff, recentFeedback] = await Promise.all([
    prisma.appointment.findFirst({
      where: { customerId: id, startAt: { gte: new Date() }, status: { in: ['BOOKED', 'CONFIRMED'] } },
      orderBy: { startAt: 'asc' },
      include: {
        services: { include: { service: { select: { name: true } }, staff: { select: { displayName: true } } } },
      },
    }),
    prisma.invoice.findFirst({
      where: { customerId: id, status: { not: 'VOID' } },
      orderBy: { invoiceDate: 'desc' },
      select: { id: true, invoiceNumber: true, grandTotal: true, invoiceDate: true, dueAmount: true },
    }),
    prisma.invoiceItem.groupBy({
      by: ['name'],
      where: { invoice: { customerId: id, status: { not: 'VOID' } }, itemType: 'SERVICE' },
      _count: { _all: true },
      _sum: { lineTotal: true },
      orderBy: { _count: { name: 'desc' } },
      take: 5,
    }),
    prisma.appointmentService.groupBy({
      by: ['staffId'],
      where: { appointment: { customerId: id, status: 'COMPLETED' }, staffId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { staffId: 'desc' } },
      take: 1,
    }),
    prisma.feedback.findMany({
      where: { customerId: id },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, rating: true, comment: true, createdAt: true },
    }),
  ]);

  const favouriteStaffId = favouriteStaff[0]?.staffId ?? null;
  const favourite = favouriteStaffId
    ? await prisma.staff.findUnique({ where: { id: favouriteStaffId }, select: { id: true, displayName: true } })
    : null;

  const daysSinceLastVisit = customer.lastVisitAt
    ? dayjs().diff(dayjs(customer.lastVisitAt), 'day')
    : null;

  return {
    ...customer,
    stats: {
      totalVisits: customer.totalVisits,
      totalSpent: customer.totalSpent,
      avgBill: customer.avgBill,
      loyaltyPoints: customer.loyaltyPoints,
      walletBalance: customer.walletBalance,
      outstanding: customer.outstanding,
      daysSinceLastVisit,
      isAtRisk: daysSinceLastVisit !== null && daysSinceLastVisit > 60,
    },
    nextAppointment,
    lastInvoice,
    favouriteStaff: favourite,
    topServices: topServices.map((s) => ({ name: s.name, count: s._count._all, revenue: s._sum.lineTotal })),
    recentFeedback,
  };
}

/** Full timeline: appointments, invoices, messages, loyalty and feedback. */
export async function getCustomerHistory(id: string, input: { page?: number; pageSize?: number }) {
  const { skip, take, page, pageSize } = pageParams(input);

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where: { customerId: id },
      orderBy: { startAt: 'desc' },
      skip,
      take,
      include: {
        branch: { select: { name: true } },
        services: {
          include: {
            service: { select: { id: true, name: true } },
            staff: { select: { id: true, displayName: true } },
          },
        },
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            grandTotal: true,
            paidAmount: true,
            dueAmount: true,
            status: true,
          },
        },
        feedback: { select: { rating: true, comment: true } },
      },
    }),
    prisma.appointment.count({ where: { customerId: id } }),
  ]);

  return { items: appointments, total, page, pageSize };
}

export async function listCustomerInvoices(id: string, input: { page?: number; pageSize?: number }) {
  const { skip, take, page, pageSize } = pageParams(input);
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where: { customerId: id },
      orderBy: { invoiceDate: 'desc' },
      skip,
      take,
      include: { items: true, payments: true },
    }),
    prisma.invoice.count({ where: { customerId: id } }),
  ]);
  return { items, total, page, pageSize };
}

// ------------------------------------------------------------------ notes ---

export async function addNote(customerId: string, note: string, userId: string | null) {
  const tenantId = requireTenantId();
  await assertCustomerExists(customerId);
  return prisma.customerNote.create({ data: { tenantId, customerId, note, createdById: userId } });
}

export async function listNotes(customerId: string) {
  return prisma.customerNote.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

export async function addPhoto(
  customerId: string,
  input: { url: string; kind?: string; caption?: string; appointmentId?: string },
) {
  const tenantId = requireTenantId();
  await assertCustomerExists(customerId);
  return prisma.customerPhoto.create({
    data: {
      tenantId,
      customerId,
      url: input.url,
      kind: input.kind ?? 'AFTER',
      caption: input.caption ?? null,
      appointmentId: input.appointmentId ?? null,
    },
  });
}

export async function listPhotos(customerId: string) {
  return prisma.customerPhoto.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
}

export async function upsertHairProfile(customerId: string, input: Record<string, unknown>) {
  const tenantId = requireTenantId();
  await assertCustomerExists(customerId);
  const existing = await prisma.hairProfile.findUnique({ where: { customerId } });
  if (existing) {
    return prisma.hairProfile.update({ where: { customerId }, data: input as Prisma.HairProfileUpdateInput });
  }
  return prisma.hairProfile.create({
    data: { ...(input as Record<string, unknown>), tenantId, customerId } as Prisma.HairProfileUncheckedCreateInput,
  });
}

export async function updateConsent(
  customerId: string,
  input: { whatsappConsent?: ConsentStatus; smsConsent?: ConsentStatus; emailConsent?: ConsentStatus },
) {
  await assertCustomerExists(customerId);
  return prisma.customer.update({
    where: { id: customerId },
    data: { ...input, consentUpdatedAt: new Date() },
  });
}

async function assertCustomerExists(customerId: string): Promise<void> {
  const exists = await prisma.customer.count({ where: { id: customerId } });
  if (!exists) throw NotFound('Customer');
}

// ----------------------------------------------------------------- import ---

export interface ImportRow {
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  gender?: string;
  dob?: string;
  tags?: string;
  notes?: string;
}

export async function importCustomers(input: {
  csv?: string;
  rows?: ImportRow[];
  branchId?: string;
  source?: LeadSource;
  skipDuplicates?: boolean;
}) {
  const tenantId = requireTenantId();

  let rows: ImportRow[] = input.rows ?? [];
  let ignoredColumns: string[] = [];
  if (input.csv) {
    const parsed = Papa.parse<Record<string, string>>(input.csv.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''),
    });
    if (parsed.errors.length) {
      logger.warn({ errors: parsed.errors.slice(0, 3) }, 'csv parse warnings');
    }
    // Headers arrive lowercased with spaces, underscores and hyphens stripped,
    // so "Email ID", "email_id" and "EMAIL-ID" all reach here as "emailid".
    // Every column takes a list of spellings because a salon's previous system
    // exported whatever it felt like, and a receptionist should not have to
    // rename columns in Excel before the import will take their data.
    //
    // Missing an alias is worse than rejecting the file: the row imports
    // looking fine, and the value is gone with nothing to say so.
    const pick = (row: Record<string, string>, ...names: string[]): string => {
      for (const name of names) {
        const value = row[name];
        if (value !== undefined && value !== null && value.trim() !== '') return value;
      }
      return '';
    };

    rows = parsed.data.map((r) => ({
      firstName: pick(r, 'firstname', 'name', 'customername', 'fullname', 'clientname'),
      lastName: pick(r, 'lastname', 'surname'),
      phone: pick(r, 'phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber', 'contactno'),
      email: pick(r, 'email', 'emailid', 'emailaddress', 'mail', 'emailaddresss'),
      gender: pick(r, 'gender', 'sex'),
      dob: pick(r, 'dob', 'birthday', 'dateofbirth', 'birthdate'),
      tags: pick(r, 'tags', 'tag', 'labels', 'category'),
      notes: pick(r, 'notes', 'note', 'remarks', 'comments', 'comment'),
    }));

    // Anything in the file we did not read. Silence here is how a salon loses
    // every email address without noticing, so the caller gets told and can
    // put it in front of whoever ran the import.
    const known = new Set([
      'firstname', 'name', 'customername', 'fullname', 'clientname',
      'lastname', 'surname',
      'phone', 'mobile', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber', 'contactno',
      'email', 'emailid', 'emailaddress', 'mail', 'emailaddresss',
      'gender', 'sex',
      'dob', 'birthday', 'dateofbirth', 'birthdate',
      'tags', 'tag', 'labels', 'category',
      'notes', 'note', 'remarks', 'comments', 'comment',
    ]);
    ignoredColumns = (parsed.meta.fields ?? []).filter((f) => f && !known.has(f));
  }

  if (!rows.length) throw BadRequest('Nothing to import: provide csv text or rows');

  const existingPhones = new Set(
    (await prisma.customer.findMany({ where: { tenantId }, select: { phone: true } })).map((c) => c.phone),
  );

  const created: string[] = [];
  /**
   * A rejected row has to be findable in the file the person is looking at.
   * `row` is its position among the data rows; `line` is the line number they
   * will see in Excel or a text editor, which is one higher because of the
   * header. Name and email ride along so a wrong number is recognisable
   * without cross-referencing anything.
   */
  const skipped: {
    row: number;
    line: number;
    name: string;
    phone: string;
    email: string;
    reason: string;
  }[] = [];

  const reject = (index: number, row: ImportRow, phone: string, reason: string) => {
    skipped.push({
      row: index + 1,
      line: index + 2,
      name: (row.firstName ?? '').trim(),
      phone: phone || (row.phone ?? '').trim(),
      email: (row.email ?? '').trim(),
      reason,
    });
  };
  let counter = await prisma.customer.count({ where: { tenantId } });

  const toCreate: Prisma.CustomerCreateManyInput[] = [];

  rows.forEach((row, index) => {
    const name = (row.firstName ?? '').trim();
    const phone = normalizePhone(row.phone ?? '');

    // Separate reasons, because "fix the name" and "fix the number" are
    // different jobs and a single combined message makes the person check both.
    if (!name && phone.length < 6) {
      reject(index, row, phone, 'No name and no valid phone number');
      return;
    }
    if (!name) {
      reject(index, row, phone, 'Name is blank');
      return;
    }
    if (!(row.phone ?? '').trim()) {
      reject(index, row, phone, 'Phone number is blank');
      return;
    }
    if (phone.length < 6) {
      reject(index, row, phone, `Phone number is not valid (${phone.length} digits after cleaning)`);
      return;
    }
    if (existingPhones.has(phone)) {
      reject(index, row, phone, 'Already in your customer list — same phone number');
      return;
    }
    existingPhones.add(phone);
    counter += 1;

    const parts = name.split(/\s+/);
    const genderValue = (row.gender ?? '').trim().toUpperCase();
    const gender: Gender | null =
      genderValue.startsWith('M') ? 'MALE' : genderValue.startsWith('F') ? 'FEMALE' : null;

    const dob = row.dob ? dayjs(row.dob, ['YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'MM/DD/YYYY']) : null;

    toCreate.push({
      tenantId,
      code: sequenceNumber('C', counter, 5),
      // A spreadsheet is where lower-case names arrive by the hundred, so the
      // import needs this more than the form does.
      firstName: toDisplayName(row.lastName ? name : (parts[0] ?? name)) as string,
      lastName: toDisplayName(row.lastName?.trim() || (parts.length > 1 ? parts.slice(1).join(' ') : null)) ?? null,
      phone,
      email: row.email?.trim() || null,
      gender,
      dob: dob?.isValid() ? dob.toDate() : null,
      tags: row.tags ? row.tags.split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [],
      notes: row.notes?.trim() || null,
      branchId: input.branchId ?? null,
      source: input.source ?? 'CSV_IMPORT',
    });
    created.push(phone);
  });

  if (toCreate.length) {
    // Checked once for the whole batch: a 5,000-row CSV must not creep a salon
    // past its customer limit one row at a time.
    await assertCustomerAllowed(tenantId, toCreate.length);
    await prisma.customer.createMany({ data: toCreate, skipDuplicates: true });
  }

  return {
    imported: toCreate.length,
    skipped: skipped.length,
    skippedRows: skipped.slice(0, 1000),
    total: rows.length,
    ignoredColumns,
  };
}

export async function exportCustomers(input: ListCustomersInput) {
  const tenantId = requireTenantId();
  const where = buildCustomerWhere(tenantId, input);
  const customers = await prisma.customer.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 50_000,
    select: {
      code: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      gender: true,
      dob: true,
      tier: true,
      totalVisits: true,
      totalSpent: true,
      avgBill: true,
      loyaltyPoints: true,
      lastVisitAt: true,
      tags: true,
      createdAt: true,
    },
  });

  return Papa.unparse(
    customers.map((c) => ({
      ...c,
      dob: c.dob ? dateKey(c.dob) : '',
      lastVisitAt: c.lastVisitAt ? dateKey(c.lastVisitAt) : '',
      createdAt: dateKey(c.createdAt),
      tags: c.tags.join('|'),
      totalSpent: c.totalSpent.toString(),
      avgBill: c.avgBill.toString(),
    })),
  );
}

/**
 * Merge a duplicate into the surviving record: history moves across, rollups are
 * recalculated, and the duplicate is deactivated rather than deleted.
 */
export async function mergeCustomers(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw BadRequest('Cannot merge a customer into themselves');

  const [source, target] = await Promise.all([
    prisma.customer.findUnique({ where: { id: sourceId } }),
    prisma.customer.findUnique({ where: { id: targetId } }),
  ]);
  if (!source || !target) throw NotFound('Customer');

  await prisma.$transaction(async (tx) => {
    await tx.appointment.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.invoice.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.payment.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.customerNote.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.customerPhoto.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.loyaltyTransaction.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.walletTransaction.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.packagePurchase.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.membershipSubscription.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.feedback.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });
    await tx.messageLog.updateMany({ where: { customerId: sourceId }, data: { customerId: targetId } });

    await tx.customer.update({
      where: { id: sourceId },
      data: {
        isActive: false,
        phone: `merged:${source.phone}:${Date.now()}`,
        notes: `${source.notes ?? ''}\n[Merged into ${targetId}]`.trim(),
      },
    });
  });

  await recalculateCustomerRollups(targetId);
  return getCustomerProfile(targetId);
}

/**
 * Recompute visit counts, spend and outstanding from invoices. Billing keeps
 * these up to date incrementally; this is the repair/backfill path.
 */
export async function recalculateCustomerRollups(customerId: string) {
  const [agg, firstInvoice, lastInvoice, outstandingAgg, visitDates, noShows, lastCategory] = await Promise.all([
    prisma.invoice.aggregate({
      where: { customerId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    }),
    prisma.invoice.findFirst({
      where: { customerId, status: { not: 'VOID' } },
      orderBy: { invoiceDate: 'asc' },
      select: { invoiceDate: true },
    }),
    prisma.invoice.findFirst({
      where: { customerId, status: { not: 'VOID' } },
      orderBy: { invoiceDate: 'desc' },
      select: { invoiceDate: true },
    }),
    prisma.invoice.aggregate({
      where: { customerId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      _sum: { dueAmount: true },
    }),

    /**
     * Every billed visit date, for the customer's own cycle. Capped and taken
     * newest-first: the rhythm only looks at the recent handful of intervals,
     * so there is no reason to read ten years of a regular's history to find
     * out they come every four weeks.
     */
    prisma.invoice.findMany({
      where: { customerId, status: { not: 'VOID' } },
      orderBy: { invoiceDate: 'desc' },
      take: 40,
      select: { invoiceDate: true },
    }),

    prisma.appointment.count({ where: { customerId, status: 'NO_SHOW' } }),

    /**
     * The last thing they actually bought. A colour reminder sent to somebody
     * who only ever books waxing is the noise that teaches people to ignore
     * the salon's messages.
     */
    prisma.invoiceItem.findFirst({
      where: { invoice: { customerId, status: { not: 'VOID' } }, itemType: 'SERVICE' },
      orderBy: { invoice: { invoiceDate: 'desc' } },
      select: { refId: true },
    }),
  ]);

  const visits = agg._count._all;
  const spent = agg._sum.grandTotal ?? 0;

  const rhythm = visitRhythm(visitDates.map((v) => v.invoiceDate));

  // The service row stores a bare refId with no relation, so the category is
  // one lookup away rather than part of the query above.
  const lastServiceCategoryId = lastCategory?.refId
    ? ((await prisma.service.findUnique({ where: { id: lastCategory.refId }, select: { categoryId: true } }))
        ?.categoryId ?? null)
    : null;

  return prisma.customer.update({
    where: { id: customerId },
    data: {
      totalVisits: visits,
      totalSpent: spent,
      avgBill: visits > 0 ? round2(div(spent, visits)) : 0,
      firstVisitAt: firstInvoice?.invoiceDate ?? null,
      lastVisitAt: lastInvoice?.invoiceDate ?? null,
      outstanding: outstandingAgg._sum.dueAmount ?? 0,

      visitIntervalDays: rhythm.intervalDays,
      visitIntervalBasis: rhythm.basedOnIntervals,
      expectedNextVisitAt: rhythm.expectedNextVisitAt,
      lifecycleStage: rhythm.stage,
      noShowCount: noShows,
      lastServiceCategoryId,
    },
  });
}

/** Tier thresholds are a tenant setting; these are the defaults. */
export async function refreshCustomerTier(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return null;

  const spent = Number(customer.totalSpent);
  const tier: CustomerTier = spent >= 50_000 ? 'VIP' : spent >= 25_000 ? 'GOLD' : spent >= 10_000 ? 'SILVER' : 'BRONZE';

  if (tier === customer.tier) return customer;
  return prisma.customer.update({ where: { id: customerId }, data: { tier } });
}

export async function birthdaysAndAnniversaries(input: { window?: 'today' | 'week' | 'month'; branchId?: string }) {
  const tenantId = requireTenantId();
  const today = dayjs().tz(DEFAULT_TZ);
  const days =
    input.window === 'today' ? 1 : input.window === 'month' ? today.daysInMonth() - today.date() + 1 : 7;

  const targets = Array.from({ length: days }, (_, i) => today.add(i, 'day')).map((d) => ({
    month: d.month() + 1,
    day: d.date(),
  }));

  const where = { tenantId, isActive: true, ...optionalBranchFilter(input.branchId) };

  const customers = await prisma.customer.findMany({
    where: { ...where, OR: [{ dob: { not: null } }, { anniversary: { not: null } }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      dob: true,
      anniversary: true,
      tier: true,
      totalSpent: true,
      whatsappConsent: true,
    },
  });

  const matches = (date: Date | null) =>
    date ? targets.some((t) => t.month === date.getUTCMonth() + 1 && t.day === date.getUTCDate()) : false;

  return {
    birthdays: customers.filter((c) => matches(c.dob)),
    anniversaries: customers.filter((c) => matches(c.anniversary)),
  };
}

/** Customers who have gone quiet — the core of the win-back motion. */
export async function inactiveCustomers(input: { days?: number; minVisits?: number; branchId?: string; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const days = input.days ?? 45;
  const cutoff = dayjs().subtract(days, 'day').toDate();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.CustomerWhereInput = {
    tenantId,
    isActive: true,
    ...optionalBranchFilter(input.branchId),
    lastVisitAt: { lte: cutoff, not: null },
    ...(input.minVisits ? { totalVisits: { gte: input.minVisits } } : {}),
  };

  const [items, total, valueAgg] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip,
      take,
      orderBy: { totalSpent: 'desc' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        lastVisitAt: true,
        totalVisits: true,
        totalSpent: true,
        avgBill: true,
        tier: true,
      },
    }),
    prisma.customer.count({ where }),
    prisma.customer.aggregate({ where, _sum: { totalSpent: true }, _avg: { avgBill: true } }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    lifetimeValueAtRisk: valueAgg._sum.totalSpent ?? 0,
    averageBill: valueAgg._avg.avgBill ?? 0,
    recoveryPotential: round2(add(0, Number(valueAgg._avg.avgBill ?? 0) * total)),
  };
}
