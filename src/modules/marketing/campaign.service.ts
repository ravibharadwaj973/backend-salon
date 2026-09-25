import type { Channel, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { currentUserId, requireTenantId, runUnscoped } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound, PaymentRequired } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, mul, pctOf, round2 } from '../../core/money';
import { enqueue } from '../../jobs/queue';
import { queueMessage } from '../../messaging/dispatcher';
import { campaignReadiness, readinessProblem } from '../../messaging/template-variables';
import { resolveMembers } from './segment.service';
import { logger } from '../../core/logger';
import { assertCampaignAllowed } from '../quotas/limits.service';
import { canAfford, meterFor } from '../quotas/quota.service';
import { sendabilityProblem } from '../../messaging/whatsapp-templates';

export interface CampaignInput {
  name: string;
  channel: Channel;
  templateId?: string;
  segmentId?: string;
  branchId?: string;
  scheduledAt?: Date;
  costPerMessage?: number;
  attributionWindowDays?: number;
  variables?: Record<string, string>;
}

export async function listCampaigns(input: { page?: number; pageSize?: number; status?: string; channel?: Channel }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.CampaignWhereInput = {
    tenantId,
    ...(input.status ? { status: input.status as Prisma.EnumCampaignStatusFilter['equals'] } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        segment: { select: { id: true, name: true, lastCount: true } },
        template: { select: { id: true, name: true, category: true } },
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getCampaign(id: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      segment: true,
      template: true,
      _count: { select: { messages: true } },
    },
  });
  if (!campaign) throw NotFound('Campaign');

  const [statusCounts, revenue] = await Promise.all([
    prisma.messageLog.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
    prisma.messageLog.aggregate({ where: { campaignId: id }, _sum: { attributedRevenue: true, cost: true } }),
  ]);

  const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  const spend = revenue._sum.cost ?? 0;
  const earned = revenue._sum.attributedRevenue ?? 0;

  return {
    ...campaign,
    messageStatus: byStatus,
    performance: {
      sent: campaign.sentCount,
      delivered: campaign.deliveredCount,
      read: campaign.readCount,
      clicked: campaign.clickedCount,
      failed: campaign.failedCount,
      bookings: campaign.bookingCount,
      revenue: earned,
      cost: spend,
      roi: Number(spend) > 0 ? Number(round2(d(earned).minus(spend).dividedBy(spend)).times(100)) : null,
      deliveryRatePct: pctOf(campaign.deliveredCount, campaign.sentCount || 1),
      readRatePct: pctOf(campaign.readCount, campaign.deliveredCount || 1),
      conversionRatePct: pctOf(campaign.bookingCount, campaign.sentCount || 1),
    },
  };
}

export async function createCampaign(input: CampaignInput) {
  const tenantId = requireTenantId();
  await assertCampaignAllowed(tenantId);

  if (input.templateId) {
    const template = await prisma.messageTemplate.findUnique({ where: { id: input.templateId } });
    if (!template) throw NotFound('Message template');
    if (template.channel !== input.channel) throw BadRequest('The template is for a different channel');

    // Refuse rather than warn. This used to log and carry on, which meant a
    // campaign to 500 customers was accepted, scheduled, and failed one
    // message at a time inside a job nobody reads.
    const problem = sendabilityProblem(template);
    if (problem) throw BadRequest(problem);
  }

  let targetCount = 0;
  if (input.segmentId) {
    const segment = await prisma.segment.findUnique({ where: { id: input.segmentId } });
    if (!segment) throw NotFound('Segment');
    targetCount = segment.lastCount;
  }

  return prisma.campaign.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      name: input.name,
      channel: input.channel,
      templateId: input.templateId ?? null,
      segmentId: input.segmentId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      status: input.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      costPerMessage: input.costPerMessage ?? 0,
      attributionWindowDays: input.attributionWindowDays ?? 14,
      variables: (input.variables ?? {}) as Prisma.InputJsonValue,
      targetCount,
      createdById: currentUserId(),
    },
  });
}

export async function updateCampaign(id: string, input: Partial<CampaignInput> & { status?: string }) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw NotFound('Campaign');
  if (campaign.status === 'RUNNING' || campaign.status === 'COMPLETED') {
    throw Conflict('A running or completed campaign can no longer be edited');
  }

  const { variables, ...rest } = input;
  return prisma.campaign.update({
    where: { id },
    data: {
      ...(rest as Prisma.CampaignUpdateInput),
      ...(variables ? { variables: variables as Prisma.InputJsonValue } : {}),
    },
  });
}

/**
 * SEND THIS CAMPAIGN AGAIN — AS A NEW CAMPAIGN.
 *
 * A finished campaign cannot be re-run in place, and that is not a missing
 * feature. Its numbers belong to one send: sentCount, deliveredCount, the
 * bookings attributed inside its window, the cost. Running the same row twice
 * mixes two sends into one set of figures, and the figure is the entire point
 * of the screen — a salon deciding whether an offer was worth sending cannot
 * be handed the average of two attempts a month apart.
 *
 * So "send again" copies it. The first send keeps its history and its ROI; the
 * copy starts at zero and earns its own. It is created as a DRAFT rather than
 * sent, because the audience, the wording or the offer usually wants a look
 * before it goes out a second time — and because a button that silently
 * messages a few hundred people is the wrong button to build.
 *
 * The segment is REFERENCED, not copied: a rule segment is meant to move, and
 * the second send should reach whoever matches now rather than whoever matched
 * in September.
 */
export async function duplicateCampaign(id: string) {
  const tenantId = requireTenantId();
  const original = await prisma.campaign.findUnique({ where: { id } });
  if (!original) throw NotFound('Campaign');

  await assertCampaignAllowed(tenantId);

  const segment = original.segmentId
    ? await prisma.segment.findUnique({ where: { id: original.segmentId } })
    : null;

  return prisma.campaign.create({
    data: {
      tenantId,
      branchId: original.branchId,
      name: nextCopyName(original.name),
      channel: original.channel,
      templateId: original.templateId,
      segmentId: original.segmentId,
      costPerMessage: original.costPerMessage,
      attributionWindowDays: original.attributionWindowDays,
      variables: (original.variables ?? {}) as Prisma.InputJsonValue,
      // Everything the first send earned stays with the first send.
      status: 'DRAFT',
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      failedCount: 0,
      bookingCount: 0,
      revenue: 0,
      cost: 0,
      targetCount: segment?.lastCount ?? 0,
      createdById: currentUserId(),
    },
  });
}

/**
 * "Diwali offer" becomes "Diwali offer (2)", and its copy "(3)".
 *
 * Counting rather than appending "copy of copy of": the fourth send of a
 * seasonal campaign is a normal thing for a salon to do, and by then the name
 * should still be readable in a list.
 */
function nextCopyName(name: string): string {
  const match = /^(.*?)\s*\((\d+)\)$/.exec(name);
  const base = match ? match[1]! : name;
  const next = match ? Number(match[2]) + 1 : 2;
  return `${base} (${next})`.slice(0, 120);
}

/** Queues the campaign for the worker to fan out. */
export async function launchCampaign(id: string, sendAt?: Date) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw NotFound('Campaign');
  if (campaign.status === 'RUNNING') throw Conflict('This campaign is already running');
  if (campaign.status === 'COMPLETED') throw Conflict('This campaign has already been sent');
  if (!campaign.segmentId) throw BadRequest('The campaign has no audience segment');
  if (!campaign.templateId) throw BadRequest('The campaign has no message template');

  // Afford it before starting it. A campaign that runs out of allowance halfway
  // leaves some customers messaged and the rest not, which is worse for the
  // salon than not sending at all — and the overdraft is there to finish a run,
  // not to fund one.
  const template = await prisma.messageTemplate.findUnique({ where: { id: campaign.templateId } });
  const segment = await prisma.segment.findUnique({ where: { id: campaign.segmentId } });
  const meter = meterFor(campaign.channel, template?.category ?? 'MARKETING');

  /**
   * CAN THIS TEMPLATE EVEN BE SENT TO A LIST?
   *
   * Checked here, once, before anything is scheduled. A campaign called
   * "test-utilty" using the appointment_cancelled template reported success,
   * charged nothing and sent nothing: every message was skipped because
   * {{appointment_date}} had no value and never could have — a campaign has a
   * segment, and a segment contains people, not appointments.
   *
   * The failure was discovered once per recipient, after the owner had been
   * told the campaign was away. One check up front, naming the field and what
   * to do about it, replaces four hundred identical skip rows.
   */
  if (template) {
    const readiness = campaignReadiness(
      [template.bodyText, template.headerText, JSON.stringify(template.buttons ?? [])],
      (campaign.variables as Record<string, string>) ?? {},
    );
    const problem = readinessProblem(readiness);
    if (problem) {
      throw BadRequest(problem, {
        blocked: readiness.blocked.map((v) => v.name),
        missing: readiness.missing.map((v) => v.name),
      });
    }
  }

  if (meter && segment) {
    const affordability = await canAfford(campaign.tenantId, meter, segment.lastCount);
    if (!affordability.affordable) {
      throw PaymentRequired(affordability.reason ?? 'Not enough message allowance to send this campaign', {
        meter: affordability.meter,
        needed: affordability.needed,
        available: affordability.available,
        shortfall: affordability.shortfall,
      });
    }
  }

  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'SCHEDULED', scheduledAt: sendAt ?? new Date() },
  });

  await enqueue('campaign.dispatch', { campaignId: id }, { runAt: sendAt ?? new Date(), uniqueKey: `campaign:${id}` });
  return updated;
}

export async function pauseCampaign(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw NotFound('Campaign');
  return prisma.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
}

/**
 * Fan-out, run by the worker. Every recipient gets a MessageLog row, which is
 * what later makes attribution possible.
 */
export async function dispatchCampaign(campaignId: string) {
  const campaign = await runUnscoped(() =>
    prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true } }),
  );
  if (!campaign) return { sent: 0, skipped: 0, reason: 'not_found' };
  if (!campaign.segmentId || !campaign.template) return { sent: 0, skipped: 0, reason: 'incomplete' };

  /**
   * CLAIM THE CAMPAIGN, OR DO NOTHING.
   *
   * This read the status, checked two of the six values, and then set RUNNING
   * unconditionally. Jobs retry five times. So a dispatch that failed partway
   * -- one provider timeout, one database blip -- came back and messaged
   * EVERYONE again from the beginning, including the people it had already
   * reached, and did that up to five times. A five-person segment produced
   * twenty-eight sends, and every one of them was a real message to a real
   * customer.
   *
   * launchCampaign already refuses to re-send a completed campaign, so this
   * was never somebody pressing the button twice. It was the retry, which
   * nobody presses and nobody sees.
   *
   * updateMany with the status in the WHERE clause is the fix: the database
   * decides who runs. Two workers racing, or a retry arriving late, find zero
   * rows updated and stop. PAUSED and CANCELLED are excluded by not being on
   * the list, which is the same check as before and one fewer place to forget.
   */
  const claimed = await runUnscoped(() =>
    prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['DRAFT', 'SCHEDULED', 'RUNNING'] } },
      data: { status: 'RUNNING', startedAt: campaign.startedAt ?? new Date() },
    }),
  );

  if (claimed.count === 0) {
    logger.warn(
      { campaignId, status: campaign.status },
      'campaign dispatch refused: it is not in a state that can be sent',
    );
    return { sent: 0, skipped: 0, reason: 'not_active' };
  }

  const members = await runUnscoped(() =>
    resolveMembers(campaign.segmentId!, {
      requireConsent: campaign.template!.category === 'MARKETING' ? (campaign.channel as 'WHATSAPP' | 'SMS' | 'EMAIL') : undefined,
      // Nobody without an address on this channel. They cannot be sent to and
      // must not be billed for.
      reachableOn: campaign.channel as 'WHATSAPP' | 'SMS' | 'EMAIL',
    }),
  );

  const variables = (campaign.variables as Record<string, string>) ?? {};

  /**
   * ANYBODY THIS CAMPAIGN HAS ALREADY MESSAGED.
   *
   * RUNNING stays on the claim list above so a genuinely interrupted campaign
   * can finish -- refusing the retry outright would leave half a segment
   * messaged and the other half not, which is the worse failure. What makes
   * that safe is this: the retry RESUMES instead of restarting, because
   * everybody already written to the message log is skipped.
   *
   * One query rather than one per member: a campaign's log is small, and this
   * runs once at the top of a fan-out that is about to do real work per row.
   */
  const alreadySent = await runUnscoped(() =>
    prisma.messageLog.findMany({
      where: { campaignId: campaign.id, customerId: { not: null } },
      select: { customerId: true },
    }),
  );
  const messaged = new Set(alreadySent.map((log) => log.customerId));

  let queued = 0;
  let skipped = 0;

  for (const member of members) {
    if (messaged.has(member.id)) {
      skipped += 1;
      continue;
    }

    const log = await runUnscoped(() =>
      queueMessage({
        tenantId: campaign.tenantId,
        branchId: campaign.branchId,
        channel: campaign.channel,
        customerId: member.id,
        templateId: campaign.templateId,
        campaignId: campaign.id,
        variables,
        attributionWindowDays: campaign.attributionWindowDays,
        cost: Number(campaign.costPerMessage),
      }),
    );
    if (log && log.status === 'QUEUED') queued += 1;
    else skipped += 1;
  }

  await runUnscoped(() =>
    prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        targetCount: members.length,
        cost: round2(mul(campaign.costPerMessage, queued)),
      },
    }),
  );

  // Attribution runs once the window closes.
  await enqueue(
    'campaign.attribute',
    { campaignId },
    {
      tenantId: campaign.tenantId,
      runAt: new Date(Date.now() + campaign.attributionWindowDays * 24 * 60 * 60 * 1000),
      uniqueKey: `campaign:attr:${campaignId}`,
    },
  );

  logger.info({ campaignId, queued, skipped }, 'campaign dispatched');
  return { sent: queued, skipped };
}

/**
 * Credits bookings and revenue back to the campaign: any invoice a recipient
 * generated inside the attribution window counts.
 */
export async function attributeCampaign(campaignId: string) {
  const campaign = await runUnscoped(() => prisma.campaign.findUnique({ where: { id: campaignId } }));
  if (!campaign) return { attributed: 0 };

  const messages = await runUnscoped(() =>
    prisma.messageLog.findMany({
      where: { campaignId, status: { in: ['SENT', 'DELIVERED', 'READ', 'CLICKED'] }, customerId: { not: null } },
      select: { id: true, customerId: true, sentAt: true, attributionUntil: true },
    }),
  );

  let bookings = 0;
  let revenue = d(0);

  for (const message of messages) {
    if (!message.customerId || !message.sentAt) continue;

    const invoice = await runUnscoped(() =>
      prisma.invoice.findFirst({
        where: {
          customerId: message.customerId!,
          status: { not: 'VOID' },
          invoiceDate: { gte: message.sentAt!, lte: message.attributionUntil ?? new Date() },
        },
        orderBy: { invoiceDate: 'asc' },
        select: { id: true, grandTotal: true },
      }),
    );

    if (!invoice) continue;

    bookings += 1;
    revenue = add(revenue, invoice.grandTotal);

    await runUnscoped(() =>
      prisma.messageLog.update({
        where: { id: message.id },
        data: { attributedInvoiceId: invoice.id, attributedRevenue: invoice.grandTotal },
      }),
    );
  }

  await runUnscoped(() =>
    prisma.campaign.update({ where: { id: campaignId }, data: { bookingCount: bookings, revenue } }),
  );

  return { attributed: bookings, revenue };
}

/** Marketing ROI across campaigns for a period. */
export async function marketingRoi(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const campaigns = await prisma.campaign.findMany({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      startedAt: { gte: input.from, lte: input.to },
    },
    include: { segment: { select: { name: true } }, template: { select: { name: true } } },
  });

  const totals = campaigns.reduce(
    (acc, c) => ({
      sent: acc.sent + c.sentCount,
      delivered: acc.delivered + c.deliveredCount,
      bookings: acc.bookings + c.bookingCount,
      revenue: add(acc.revenue, c.revenue),
      cost: add(acc.cost, c.cost),
    }),
    { sent: 0, delivered: 0, bookings: 0, revenue: d(0), cost: d(0) },
  );

  return {
    period: input,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      segment: c.segment?.name ?? null,
      sent: c.sentCount,
      delivered: c.deliveredCount,
      read: c.readCount,
      bookings: c.bookingCount,
      revenue: c.revenue,
      cost: c.cost,
      roiPct: Number(c.cost) > 0 ? pctOf(d(c.revenue).minus(c.cost), c.cost) : null,
    })),
    totals: {
      ...totals,
      roiPct: Number(totals.cost) > 0 ? pctOf(d(totals.revenue).minus(totals.cost), totals.cost) : null,
      revenuePerMessage: totals.sent > 0 ? round2(d(totals.revenue).dividedBy(totals.sent)) : 0,
    },
  };
}
