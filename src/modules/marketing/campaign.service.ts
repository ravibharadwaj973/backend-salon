import type { CampaignAudience, CampaignObjective, Channel, ConversionEvent, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { currentUserId, requireTenantId, runUnscoped } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, Conflict, NotFound, PaymentRequired } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d, mul, pctOf, round2 } from '../../core/money';
import { enqueue } from '../../jobs/queue';
import { queueMessage } from '../../messaging/dispatcher';
import { campaignReadiness, readinessProblem } from '../../messaging/template-variables';
import { computeLift, objectiveInfo, windowEnd, windowStart } from './attribution';
import { resolveFollowUpMembers } from './campaign-audiences';
import { resolveMembers } from './segment.service';
import { logger } from '../../core/logger';
import { assertCampaignAllowed } from '../quotas/limits.service';
import { canAfford, meterFor } from '../quotas/quota.service';
import { sendabilityProblem } from '../../messaging/whatsapp-templates';

export interface CampaignInput {
  name: string;
  channel: Channel;
  /** What this campaign is for — decides the suggested attribution window. */
  objective?: CampaignObjective;
  /** The campaign whose recipients this one follows up, instead of a segment. */
  followUpOfId?: string;
  followUpAudience?: CampaignAudience;
  /** How long after each recipient's delivery a booking or visit still counts. */
  attributionWindowDays?: number;
  /** Which of booking, visit and revenue this campaign is judged on. */
  conversionEvents?: ConversionEvent[];
  templateId?: string;
  segmentId?: string;
  branchId?: string;
  scheduledAt?: Date;
  costPerMessage?: number;
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

  const [statusCounts, revenue, awaitingReceipt, lastReceipt, tenantLastReceipt] = await Promise.all([
    prisma.messageLog.groupBy({ by: ['status'], where: { campaignId: id }, _count: { _all: true } }),
    prisma.messageLog.aggregate({ where: { campaignId: id }, _sum: { attributedRevenue: true, cost: true } }),
    /**
     * HANDED TO THE PROVIDER, NOTHING HEARD BACK.
     *
     * The difference between "it did not arrive" and "we do not know whether it
     * arrived", which the screen had no way to express. A campaign showing
     *
     *     Sent 4 · Delivered 0 · 4 did not get this far
     *
     * was asserting that four messages failed. What had actually happened is
     * that WhatsApp accepted all four and no status callback ever came back, so
     * the app knows nothing about them either way. Those are opposite
     * conclusions: one says the phone numbers are wrong, the other says the
     * webhook is not wired up, and the salon acts very differently on each.
     *
     * A message sitting at SENT with no delivery timestamp and no error is
     * precisely that unknown.
     */
    prisma.messageLog.count({
      where: { campaignId: id, status: 'SENT', deliveredAt: null, errorCode: null },
    }),
    prisma.messageLog.findFirst({
      where: { campaignId: id, OR: [{ deliveredAt: { not: null } }, { readAt: { not: null } }] },
      orderBy: { deliveredAt: 'desc' },
      select: { deliveredAt: true, readAt: true },
    }),
    // Tenant-wide, because "no receipt has arrived for ANY message in weeks" is
    // a far stronger signal than one quiet campaign — that is a broken webhook
    // rather than four bad numbers.
    prisma.messageLog.findFirst({
      where: { tenantId: campaign.tenantId, deliveredAt: { not: null } },
      orderBy: { deliveredAt: 'desc' },
      select: { deliveredAt: true },
    }),
  ]);

  const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all]));
  const spend = revenue._sum.cost ?? 0;
  const earned = revenue._sum.attributedRevenue ?? 0;

  /**
   * THE FUNNEL, ALL THE WAY TO THE MONEY.
   *
   * It used to stop at "delivered to 930 people", which answers a question
   * about messaging rather than about the business. Each stage is measured
   * against the one above it, so a campaign that arrived everywhere and
   * converted nobody is tellable apart from one that barely arrived.
   */
  const info = objectiveInfo(campaign.objective);

  return {
    ...campaign,
    messageStatus: byStatus,
    objectiveLabel: info.label,
    windowRationale: info.rationale,
    funnel: {
      targeted: campaign.targetCount,
      sent: campaign.sentCount,
      delivered: campaign.deliveredCount,
      engaged: campaign.engagedCount,
      booked: campaign.bookingCount,
      visited: campaign.visitCount,
      revenue: earned,
      cost: spend,
    },
    performance: {
      sent: campaign.sentCount,
      delivered: campaign.deliveredCount,
      read: campaign.readCount,
      clicked: campaign.clickedCount,
      failed: campaign.failedCount,
      engaged: campaign.engagedCount,
      bookings: campaign.bookingCount,
      visits: campaign.visitCount,
      revenue: earned,
      cost: spend,
      roi: Number(spend) > 0 ? Number(round2(d(earned).minus(spend).dividedBy(spend)).times(100)) : null,
      deliveryRatePct: pctOf(campaign.deliveredCount, campaign.sentCount || 1),
      readRatePct: pctOf(campaign.readCount, campaign.deliveredCount || 1),
      engagementRatePct: pctOf(campaign.engagedCount, campaign.deliveredCount || 1),
      /**
       * Against DELIVERED, not against sent. A message that never arrived
       * cannot have failed to convert, and dividing by the wrong denominator
       * punishes a campaign twice for a bad phone list.
       */
      bookingRatePct: pctOf(campaign.bookingCount, campaign.deliveredCount || 1),
      visitRatePct: pctOf(campaign.visitCount, campaign.deliveredCount || 1),
      /** What each visit cost to buy — the number that decides the next campaign. */
      costPerVisit: campaign.visitCount > 0 ? round2(d(spend).dividedBy(campaign.visitCount)) : null,
      revenuePerMessageSent: campaign.sentCount > 0 ? round2(d(earned).dividedBy(campaign.sentCount)) : null,
    },
    /**
     * Null figures until attribution has run — the honest answer while the
     * window is still open, rather than a zero that reads as failure.
     */
    attributionPending: campaign.attributedAt === null && campaign.status === 'COMPLETED',
    /**
     * What the app actually KNOWS about delivery, as opposed to what it can
     * show. Lets the screen say "no receipt yet" where it used to say nobody
     * received it.
     */
    receipts: {
      /** Sent, accepted by the provider, and nothing heard since. */
      awaiting: awaitingReceipt,
      /** Whether any receipt at all has arrived for this campaign. */
      anyForCampaign: Boolean(lastReceipt),
      /** The most recent receipt for ANY message this salon has sent. */
      lastAnywhereAt: tenantLastReceipt?.deliveredAt ?? null,
      /**
       * Nothing back on a single message. With no receipt anywhere either, the
       * webhook is the thing to check rather than the customers' numbers.
       */
      looksUnwired: awaitingReceipt > 0 && !lastReceipt && !tenantLastReceipt,
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
  } else if (input.followUpOfId && input.followUpAudience) {
    const source = await prisma.campaign.findUnique({ where: { id: input.followUpOfId } });
    if (!source) throw NotFound('The campaign being followed up');
    // A count for the screen only. The real audience is resolved again at send
    // time, and will differ if anybody books in between — which is the point.
    targetCount = (await resolveFollowUpMembers(input.followUpOfId, input.followUpAudience)).length;
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
      objective: input.objective ?? 'OTHER',
      followUpOfId: input.followUpOfId ?? null,
      followUpAudience: input.followUpAudience ?? null,
      // The objective's suggestion, not a fixed fortnight: the right window is
      // a property of what the campaign is trying to do. An explicit value
      // always wins — the preset fills the box, it does not overrule the owner.
      attributionWindowDays:
        input.attributionWindowDays ?? objectiveInfo(input.objective ?? 'OTHER').suggestedWindowDays,
      conversionEvents:
        input.conversionEvents ?? objectiveInfo(input.objective ?? 'OTHER').suggestedEvents,
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
      // A copy is being sent again for the same reason, so it is measured the
      // same way. Carrying one across without the other would make the two
      // runs incomparable, which is the point of duplicating.
      objective: original.objective,
      conversionEvents: original.conversionEvents,
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
  if (!campaign.segmentId && !(campaign.followUpOfId && campaign.followUpAudience)) {
    throw BadRequest('The campaign has no audience — pick a segment, or follow up on an earlier campaign.');
  }
  if (!campaign.templateId) throw BadRequest('The campaign has no message template');

  // Afford it before starting it. A campaign that runs out of allowance halfway
  // leaves some customers messaged and the rest not, which is worse for the
  // salon than not sending at all — and the overdraft is there to finish a run,
  // not to fund one.
  const template = await prisma.messageTemplate.findUnique({ where: { id: campaign.templateId } });
  const segment = campaign.segmentId
    ? await prisma.segment.findUnique({ where: { id: campaign.segmentId } })
    : null;
  const meter = meterFor(campaign.channel, template?.category ?? 'MARKETING');

  /**
   * How many this will reach, for the affordability check. A follow-up has no
   * segment to ask, so the group is counted — and counted again at send time,
   * because anybody who books in between drops out of it.
   */
  const expectedRecipients = segment
    ? segment.lastCount
    : campaign.followUpOfId && campaign.followUpAudience
      ? (await resolveFollowUpMembers(campaign.followUpOfId, campaign.followUpAudience)).length
      : 0;

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

  if (meter && expectedRecipients > 0) {
    const affordability = await canAfford(campaign.tenantId, meter, expectedRecipients);
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
  const isFollowUp = Boolean(campaign.followUpOfId && campaign.followUpAudience);
  // A follow-up draws its audience from another campaign's recipients rather
  // than from a segment, so requiring a segment would refuse it outright.
  if ((!campaign.segmentId && !isFollowUp) || !campaign.template) {
    return { sent: 0, skipped: 0, reason: 'incomplete' };
  }

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

  /**
   * WHO THIS GOES TO, DECIDED NOW RATHER THAN WHEN IT WAS CREATED.
   *
   * For a follow-up this is the whole design. The audience is a rule — "read
   * it and has not booked" — evaluated at this moment, so anybody who booked
   * between the follow-up being scheduled and it going out has already left
   * the group. There is no stop-the-follow-up step anywhere because none is
   * needed: they are simply not in it.
   *
   * A copied list would have messaged them, asking people who have already
   * said yes whether they are still thinking about it.
   */
  const members = isFollowUp
    ? await (async () => {
        const ids = await resolveFollowUpMembers(campaign.followUpOfId!, campaign.followUpAudience!);
        if (!ids.length) return [];
        return runUnscoped(() =>
          prisma.customer.findMany({
            where: {
              id: { in: ids },
              isActive: true,
              // The same two gates a segment send passes: consent for
              // marketing, and an address on this channel.
              ...(campaign.template!.category === 'MARKETING'
                ? {
                    [campaign.channel === 'EMAIL'
                      ? 'emailConsent'
                      : campaign.channel === 'SMS'
                        ? 'smsConsent'
                        : 'whatsappConsent']: 'OPTED_IN',
                  }
                : {}),
              ...(campaign.channel === 'EMAIL'
                ? { email: { not: null }, NOT: { email: '' } }
                : { NOT: { phone: '' } }),
            },
            select: { id: true, dob: true, anniversary: true, phone: true, email: true },
          }),
        );
      })()
    : await runUnscoped(() =>
        resolveMembers(campaign.segmentId!, {
          requireConsent: campaign.template!.category === 'MARKETING' ? (campaign.channel as 'WHATSAPP' | 'SMS' | 'EMAIL') : undefined,
          // Nobody without an address on this channel. They cannot be sent to
          // and must not be billed for.
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
 * CREDITS BOOKINGS, VISITS AND REVENUE BACK TO A CAMPAIGN.
 *
 * Rewritten, because the previous version counted the wrong thing and said so
 * in the wrong words. It looked for the first INVOICE in each recipient's
 * window and called it a booking:
 *
 *     if (!invoice) continue;
 *     bookings += 1;          // this is a visit
 *
 * So a campaign's "74 bookings" meant 74 people who had been billed. Somebody
 * who booked and then did not turn up counted as nothing, and the gap between
 * deciding to come and coming — which is a no-show problem rather than a
 * campaign problem — was invisible. They are separate stages now.
 *
 * It also took only the FIRST invoice. On a 30-day win-back window a customer
 * who came three times contributed one visit and one bill, which understates
 * exactly the campaigns that worked best.
 *
 * Each recipient is measured against their OWN window, anchored on their own
 * delivery. A campaign that goes out over five days must not give the person
 * reached on the fifth day a shorter window than the first, or the people
 * reached last look like the people who did not respond.
 */
export async function attributeCampaign(campaignId: string) {
  const campaign = await runUnscoped(() => prisma.campaign.findUnique({ where: { id: campaignId } }));
  if (!campaign) return { attributed: 0 };

  const messages = await runUnscoped(() =>
    prisma.messageLog.findMany({
      where: { campaignId, customerId: { not: null } },
      select: {
        id: true,
        customerId: true,
        status: true,
        queuedAt: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        clickedAt: true,
        repliedAt: true,
      },
    }),
  );

  let engaged = 0;
  let booked = 0;
  let visited = 0;
  let revenue = d(0);

  // Split for the lift comparison: recipients who never opened it are the
  // closest thing to a control group this data can offer — same segment, same
  // day, same rule.
  let engagedRecipients = 0;
  let engagedConverted = 0;
  let quietRecipients = 0;
  let quietConverted = 0;

  for (const message of messages) {
    const start = windowStart(message);
    // Nothing left the building for this recipient, so there is nothing their
    // behaviour could be evidence of either way.
    if (!message.customerId || !start) continue;
    if (message.status === 'SKIPPED' || message.status === 'FAILED') continue;

    const until = windowEnd(start, campaign.attributionWindowDays);
    const didEngage = Boolean(message.readAt ?? message.clickedAt ?? message.repliedAt);
    if (didEngage) engaged += 1;

    const [appointment, invoices] = await Promise.all([
      runUnscoped(() =>
        prisma.appointment.findFirst({
          where: {
            customerId: message.customerId!,
            // When they DECIDED to come, which is what the message could have
            // caused — not when the appointment happens to fall.
            createdAt: { gte: start, lte: until },
            status: { not: 'CANCELLED' },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        }),
      ),
      runUnscoped(() =>
        prisma.invoice.findMany({
          where: {
            customerId: message.customerId!,
            status: { not: 'VOID' },
            invoiceDate: { gte: start, lte: until },
          },
          orderBy: { invoiceDate: 'asc' },
          select: { id: true, grandTotal: true },
        }),
      ),
    ]);

    const theirRevenue = invoices.reduce<Prisma.Decimal>((acc, i) => add(acc, i.grandTotal), d(0));
    const converted = invoices.length > 0 || Boolean(appointment);

    if (appointment) booked += 1;
    if (invoices.length) {
      visited += 1;
      revenue = add(revenue, theirRevenue);
    }

    if (didEngage) {
      engagedRecipients += 1;
      if (converted) engagedConverted += 1;
    } else {
      quietRecipients += 1;
      if (converted) quietConverted += 1;
    }

    // Written back even when nothing converted, so the window itself is on the
    // record: "counted because they visited on 2 October, inside 25 September
    // to 16 October" is answerable months later, and a recomputed window is not.
    await runUnscoped(() =>
      prisma.messageLog.update({
        where: { id: message.id },
        data: {
          attributionFrom: start,
          attributionUntil: until,
          attributedAppointmentId: appointment?.id ?? null,
          attributedInvoiceId: invoices[0]?.id ?? null,
          attributedVisits: invoices.length,
          attributedRevenue: theirRevenue,
        },
      }),
    );
  }

  await runUnscoped(() =>
    prisma.campaign.update({
      where: { id: campaignId },
      data: {
        engagedCount: engaged,
        bookingCount: booked,
        visitCount: visited,
        revenue,
        attributedAt: new Date(),
      },
    }),
  );

  return {
    attributed: visited,
    booked,
    visited,
    engaged,
    revenue,
    lift: computeLift({ engagedRecipients, engagedConverted, quietRecipients, quietConverted }),
  };
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
