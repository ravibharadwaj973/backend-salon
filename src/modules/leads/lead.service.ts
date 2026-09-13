import type { LeadSource, LeadStatus, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { currentUserId, requireTenantId } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { normalizePhone, sequenceNumber } from '../../core/ids';
import { add, d, pctOf } from '../../core/money';
import { enqueueSafe } from '../../jobs/queue';

export interface LeadInput {
  name: string;
  phone: string;
  email?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNISEX';
  branchId?: string;
  source?: LeadSource;
  sourceDetail?: string;
  campaignId?: string;
  assignedToId?: string;
  interestedServiceIds?: string[];
  notes?: string;
  followUpAt?: Date;
}

export async function listLeads(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: LeadStatus;
  source?: LeadSource;
  assignedToId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  dueOnly?: boolean;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.LeadWhereInput = {
    tenantId,
    ...optionalBranchFilter(input.branchId),
    ...(input.status ? { status: input.status } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.assignedToId ? { assignedToId: input.assignedToId } : {}),
    ...(input.dueOnly ? { followUpAt: { lte: new Date() }, status: { notIn: ['CONVERTED', 'LOST'] } } : {}),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { phone: { contains: normalizePhone(input.q) } },
            { email: { contains: input.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      skip,
      take,
      orderBy: [{ followUpAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        assignedTo: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true } },
        _count: { select: { activities: true } },
      },
    }),
    prisma.lead.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getLead(id: string) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      assignedTo: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
      campaign: { select: { id: true, name: true } },
      convertedCustomer: { select: { id: true, firstName: true, lastName: true, totalSpent: true } },
      activities: { orderBy: { createdAt: 'desc' } },
      messages: { orderBy: { queuedAt: 'desc' }, take: 20 },
    },
  });
  if (!lead) throw NotFound('Lead');
  return lead;
}

export async function createLead(input: LeadInput) {
  const tenantId = requireTenantId();
  const phone = normalizePhone(input.phone);

  const existingLead = await prisma.lead.findFirst({ where: { tenantId, phone } });
  if (existingLead) {
    // Repeat enquiry: log it against the existing lead rather than duplicating.
    await prisma.leadActivity.create({
      data: {
        tenantId,
        leadId: existingLead.id,
        type: 'NOTE',
        notes: `Repeat enquiry from ${input.source ?? 'unknown source'}`,
        createdById: currentUserId(),
      },
    });
    return existingLead;
  }

  const existingCustomer = await prisma.customer.findFirst({ where: { tenantId, phone } });
  if (existingCustomer) {
    throw Conflict('This phone number already belongs to a customer', { customerId: existingCustomer.id });
  }

  const lead = await prisma.lead.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      name: input.name,
      phone,
      email: input.email ?? null,
      gender: input.gender ?? null,
      source: input.source ?? 'MANUAL',
      sourceDetail: input.sourceDetail ?? null,
      campaignId: input.campaignId ?? null,
      assignedToId: input.assignedToId ?? null,
      interestedServiceIds: input.interestedServiceIds ?? [],
      notes: input.notes ?? null,
      followUpAt: input.followUpAt ?? null,
    },
  });

  await prisma.leadActivity.create({
    data: { tenantId, leadId: lead.id, type: 'NOTE', notes: 'Lead created', createdById: currentUserId() },
  });

  enqueueSafe('journey.trigger', { trigger: 'LEAD_CREATED', leadId: lead.id });
  return lead;
}

export async function updateLead(id: string, input: Partial<LeadInput> & { status?: LeadStatus; lostReason?: string }) {
  const tenantId = requireTenantId();
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) throw NotFound('Lead');

  if (input.status && input.status !== lead.status) {
    await prisma.leadActivity.create({
      data: {
        tenantId,
        leadId: id,
        type: 'STATUS_CHANGE',
        notes: `${lead.status} → ${input.status}`,
        createdById: currentUserId(),
      },
    });
  }

  return prisma.lead.update({
    where: { id },
    data: {
      ...(input as Prisma.LeadUpdateInput),
      ...(input.phone ? { phone: normalizePhone(input.phone) } : {}),
    },
  });
}

export async function addActivity(leadId: string, input: { type: string; notes?: string; followUpAt?: Date }) {
  const tenantId = requireTenantId();
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw NotFound('Lead');

  const activity = await prisma.leadActivity.create({
    data: { tenantId, leadId, type: input.type, notes: input.notes ?? null, createdById: currentUserId() },
  });

  if (input.followUpAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { followUpAt: input.followUpAt } });
  }

  return activity;
}

/**
 * Converts a lead into a customer, carrying the acquisition source across so
 * revenue can be traced back to the channel that produced it.
 */
export async function convertLead(id: string, input: { branchId?: string; preferredStaffId?: string } = {}) {
  const tenantId = requireTenantId();
  const lead = await prisma.lead.findUnique({ where: { id } });
  if (!lead) throw NotFound('Lead');
  if (lead.convertedCustomerId) throw Conflict('This lead has already been converted');

  const existing = await prisma.customer.findFirst({ where: { tenantId, phone: lead.phone } });
  if (existing) {
    await prisma.lead.update({
      where: { id },
      data: { status: 'CONVERTED', convertedCustomerId: existing.id, convertedAt: new Date() },
    });
    return existing;
  }

  const count = await prisma.customer.count({ where: { tenantId } });
  const parts = lead.name.trim().split(/\s+/);

  const customer = await prisma.customer.create({
    data: {
      tenantId,
      branchId: input.branchId ?? lead.branchId,
      code: sequenceNumber('C', count + 1, 5),
      firstName: parts[0] ?? lead.name,
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
      phone: lead.phone,
      email: lead.email,
      gender: lead.gender,
      source: lead.source,
      sourceDetail: lead.sourceDetail,
      preferredStaffId: input.preferredStaffId ?? null,
      notes: lead.notes,
    },
  });

  await prisma.$transaction([
    prisma.lead.update({
      where: { id },
      data: { status: 'CONVERTED', convertedCustomerId: customer.id, convertedAt: new Date() },
    }),
    prisma.leadActivity.create({
      data: { tenantId, leadId: id, type: 'STATUS_CHANGE', notes: 'Converted to customer', createdById: currentUserId() },
    }),
  ]);

  return customer;
}

export async function importLeads(rows: { name: string; phone: string; email?: string; source?: LeadSource; notes?: string }[]) {
  const tenantId = requireTenantId();

  const existing = new Set(
    (await prisma.lead.findMany({ where: { tenantId }, select: { phone: true } })).map((l) => l.phone),
  );

  const toCreate: Prisma.LeadCreateManyInput[] = [];
  let skipped = 0;

  for (const row of rows) {
    const phone = normalizePhone(row.phone);
    if (!row.name?.trim() || phone.length < 6 || existing.has(phone)) {
      skipped += 1;
      continue;
    }
    existing.add(phone);
    toCreate.push({
      tenantId,
      name: row.name.trim(),
      phone,
      email: row.email ?? null,
      source: row.source ?? 'CSV_IMPORT',
      notes: row.notes ?? null,
    });
  }

  if (toCreate.length) await prisma.lead.createMany({ data: toCreate, skipDuplicates: true });
  return { imported: toCreate.length, skipped };
}

/**
 * The question owners actually ask: which channel produced revenue, not just
 * which produced leads.
 */
export async function leadFunnel(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const where: Prisma.LeadWhereInput = {
    tenantId,
    ...optionalBranchFilter(input.branchId),
    createdAt: { gte: input.from, lte: input.to },
  };

  const [bySource, byStatus, converted] = await Promise.all([
    prisma.lead.groupBy({ by: ['source'], where, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.lead.findMany({
      where: { ...where, convertedCustomerId: { not: null } },
      select: { source: true, convertedCustomerId: true },
    }),
  ]);

  const convertedIds = converted.map((c) => c.convertedCustomerId!).filter(Boolean);

  const revenueByCustomer = convertedIds.length
    ? await prisma.invoice.groupBy({
        by: ['customerId'],
        where: { customerId: { in: convertedIds }, status: { not: 'VOID' } },
        _sum: { grandTotal: true },
        _count: { _all: true },
      })
    : [];

  const revenueMap = new Map(revenueByCustomer.map((r) => [r.customerId, r]));

  const sourceRows = bySource.map((row) => {
    const convertedForSource = converted.filter((c) => c.source === row.source);
    const revenue = convertedForSource.reduce(
      (acc, c) => add(acc, revenueMap.get(c.convertedCustomerId!)?._sum.grandTotal ?? 0),
      d(0),
    );
    const appointments = convertedForSource.reduce(
      (acc, c) => acc + (revenueMap.get(c.convertedCustomerId!)?._count._all ?? 0),
      0,
    );

    return {
      source: row.source,
      leads: row._count._all,
      converted: convertedForSource.length,
      conversionRatePct: pctOf(convertedForSource.length, row._count._all),
      visits: appointments,
      revenue,
      revenuePerLead: row._count._all > 0 ? d(revenue).dividedBy(row._count._all).toDecimalPlaces(2) : d(0),
    };
  });

  const totalLeads = bySource.reduce((acc, s) => acc + s._count._all, 0);

  return {
    period: { from: input.from, to: input.to },
    totalLeads,
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    bySource: sourceRows.sort((a, b) => Number(b.revenue) - Number(a.revenue)),
    overallConversionRatePct: pctOf(converted.length, totalLeads || 1),
  };
}

export async function markLost(id: string, reason: string) {
  if (!reason) throw BadRequest('A reason is required when marking a lead lost');
  return updateLead(id, { status: 'LOST', lostReason: reason });
}
