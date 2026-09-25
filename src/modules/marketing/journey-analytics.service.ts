import type { Channel, MessageStatus, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { pctOf, round2 } from '../../core/money';
import { dateKey, dayjs, eachDay, endOfDay, startOfDay } from '../../core/dates';
import { CAPABILITIES } from '../analytics/messaging-analytics.service';

/**
 * AN AUTOMATION IS A CAMPAIGN THAT NEVER STOPS.
 *
 * Campaigns got a funnel, a delivery breakdown and a recipient list; automations
 * got a toggle and a run count. That is backwards for a salon: a campaign is
 * sent deliberately and watched, while an automation runs unattended for months.
 * If a birthday journey quietly stops reaching anybody, nobody finds out —
 * there is no send button to press and no result screen to open.
 *
 * So the same questions are answered here, with one difference that matters.
 * A campaign has ONE audience and one moment; an automation has a rate. "Did it
 * work?" for a campaign is a single figure; for an automation it is a figure
 * over time, and a drop in the rate is the thing worth seeing — a journey that
 * fired forty times a week and now fires twice has broken, even though every
 * one of those two arrived perfectly.
 */

export interface JourneyFunnel {
  /** Runs that entered the journey in the period. */
  entered: number;
  /** Messages the journey attempted. One run can send several. */
  attempted: number;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  replied: number;
  failed: number;
  /** Never attempted: no consent, a dead address, a missing value. */
  skipped: number;
  /** Handed over and nothing heard back — not a failure. */
  awaitingReceipt: number;
  cost: Prisma.Decimal;
  deliveryRatePct: number | null;
  readRatePct: number | null;
}

const AT_LEAST_SENT: MessageStatus[] = ['SENT', 'DELIVERED', 'READ', 'CLICKED', 'COMPLAINED', 'DELAYED'];
const AT_LEAST_DELIVERED: MessageStatus[] = ['DELIVERED', 'READ', 'CLICKED', 'COMPLAINED'];
const AT_LEAST_READ: MessageStatus[] = ['READ', 'CLICKED'];

export interface JourneyRange {
  from?: Date;
  to?: Date;
}

/**
 * The longest run of days this screen will chart.
 *
 * The range is clamped HERE rather than when the chart is built, so that the
 * period the page prints and the period it draws are the same period. Trimming
 * the series instead would leave the header saying "1 Jan 2016 to today" above
 * a chart that starts in 2025, and a date range that cannot be trusted is
 * worse than a shorter one.
 */
const MAX_DAYS = 400;

export function rangeOf(input: JourneyRange) {
  const to = endOfDay(input.to ?? new Date());
  const asked = startOfDay(input.from ?? dayjs(to).subtract(90, 'day').toDate());
  const earliest = startOfDay(dayjs(to).subtract(MAX_DAYS - 1, 'day').toDate());
  return { from: asked < earliest ? earliest : asked, to };
}

/**
 * Whether a read figure means anything for the channels this automation used.
 *
 * Extracted and exported so the rule can be tested on its own, because getting
 * it wrong is silent: an SMS journey reporting "Read 0%" is a sentence the app
 * has no business saying, and it reads as nobody opening the message rather
 * than as nobody being able to tell.
 *
 * MIXED CHANNELS FAIL THE TEST DELIBERATELY. A journey that sends WhatsApp and
 * then falls back to SMS would otherwise divide its WhatsApp reads by every
 * message including the SMS ones, and would look worse the more often the
 * fallback fired — a rate that moves for a reason that has nothing to do with
 * whether anyone read anything.
 *
 * No channels at all is also false: nothing has been sent, so there is nothing
 * to have read, and 0% would again be a claim rather than a measurement.
 */
export function readIsMeasurable(channels: Channel[]): boolean {
  return channels.length > 0 && channels.every((channel) => CAPABILITIES[channel]?.read === true);
}

/**
 * How an automation is doing, and — the part a campaign does not need — how
 * often it is firing at all.
 */
export async function journeyPerformance(journeyId: string, input: JourneyRange = {}) {
  const tenantId = requireTenantId();
  const { from, to } = rangeOf(input);

  const journey = await prisma.journey.findFirst({
    where: { id: journeyId, tenantId },
    include: { steps: { orderBy: { sortOrder: 'asc' }, include: { template: { select: { name: true, channel: true } } } } },
  });
  if (!journey) return null;

  const messageWhere: Prisma.MessageLogWhereInput = {
    tenantId,
    journeyRun: { journeyId },
    queuedAt: { gte: from, lte: to },
  };

  const [runsByStatus, entered, statusCounts, money, awaiting, replied, channels, timeline] = await Promise.all([
    prisma.journeyRun.groupBy({
      by: ['status'],
      where: { journeyId, startedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.journeyRun.count({ where: { journeyId, startedAt: { gte: from, lte: to } } }),
    prisma.messageLog.groupBy({ by: ['status'], where: messageWhere, _count: { _all: true } }),
    prisma.messageLog.aggregate({ where: messageWhere, _sum: { cost: true } }),
    // Accepted by the provider and never reported on. Counted apart so a
    // missing receipt is never drawn as a failure.
    prisma.messageLog.count({
      where: { ...messageWhere, status: 'SENT', deliveredAt: null, errorCode: null },
    }),
    // A reply is recorded on its own column, not as a status, so it has to be
    // counted separately — a customer who replies stays DELIVERED.
    prisma.messageLog.count({ where: { ...messageWhere, repliedAt: { not: null } } }),
    prisma.messageLog.groupBy({ by: ['channel'], where: messageWhere, _count: { _all: true } }),
    /**
     * When it fired, day by day.
     *
     * The figure a campaign has no use for and an automation lives by: a
     * journey that ran forty times a week and now runs twice has broken, and
     * no total will ever show that.
     */
    prisma.journeyRun.findMany({
      where: { journeyId, startedAt: { gte: from, lte: to } },
      select: { startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: 20_000,
    }),
  ]);

  const byStatus = new Map(statusCounts.map((s) => [s.status, s._count._all]));
  const count = (list: MessageStatus[]) => list.reduce((n, s) => n + (byStatus.get(s) ?? 0), 0);

  const sent = count(AT_LEAST_SENT) + (byStatus.get('BOUNCED') ?? 0);
  const delivered = count(AT_LEAST_DELIVERED);
  const read = count(AT_LEAST_READ);
  const attempted = statusCounts.reduce((n, s) => n + s._count._all, 0);

  /**
   * Which channels this journey actually used, so the rates can say what they
   * can and cannot measure. A journey that sends by SMS has no read figure at
   * all, and printing 0% would read as nobody opening it.
   */
  const readMeasurable = readIsMeasurable(channels.map((c) => c.channel));

  const perDay = new Map<string, number>();
  for (const run of timeline) {
    const key = dateKey(run.startedAt);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  return {
    journey: {
      id: journey.id,
      name: journey.name,
      trigger: journey.trigger,
      isActive: journey.isActive,
      steps: journey.steps.map((s) => ({
        id: s.id,
        channel: s.channel,
        templateName: s.template?.name ?? null,
        actionType: s.actionType,
      })),
    },
    period: { from: dateKey(from), to: dateKey(to) },
    runs: {
      entered,
      ...Object.fromEntries(runsByStatus.map((r) => [r.status.toLowerCase(), r._count._all])),
    },
    funnel: {
      entered,
      attempted,
      sent,
      delivered,
      read,
      clicked: byStatus.get('CLICKED') ?? 0,
      replied,
      failed: (byStatus.get('FAILED') ?? 0) + (byStatus.get('BOUNCED') ?? 0),
      skipped: byStatus.get('SKIPPED') ?? 0,
      awaitingReceipt: awaiting,
      cost: round2(money._sum.cost ?? 0),
      deliveryRatePct: sent > 0 ? pctOf(delivered, sent) : null,
      // null rather than 0 where the channel cannot report it.
      readRatePct: readMeasurable && delivered > 0 ? pctOf(read, delivered) : null,
    } satisfies JourneyFunnel & { deliveryRatePct: number | null },
    channels: channels.map((c) => ({
      channel: c.channel,
      count: c._count._all,
      capability: CAPABILITIES[c.channel] ?? null,
    })),
    /** One point per day, zero-filled, so a gap reads as a gap. */
    activity: fillDays(from, to, perDay),
    readMeasurable,
  };
}

/**
 * Zero-filled, because a sparse series hides exactly what this chart is for.
 *
 * A journey that stopped firing three weeks ago draws, without the zeros, as a
 * continuous line straight from its last run to today — which looks like
 * steady activity rather than three weeks of silence.
 *
 * The calendar comes from eachDay, in the salon's own timezone, rather than
 * from a dayjs loop over the raw timestamps. Those are not the same calendar:
 * a range covering ten days in IST spans eleven UTC days, and a hand-rolled
 * loop silently produced an extra leading bucket for a day that was not in the
 * period at all. A test caught it. In production, where the container runs UTC
 * and the salon runs IST, every one of these charts would have opened with a
 * phantom empty day.
 */
export function fillDays(from: Date, to: Date, counts: Map<string, number>) {
  return eachDay({ from, to }).map((date) => ({ date, runs: counts.get(date) ?? 0 }));
}

/**
 * WHO THIS AUTOMATION ACTUALLY WROTE TO.
 *
 * The address is shown as it was used — the email for an email, the number for
 * WhatsApp and SMS — because that is the thing somebody checks when a message
 * did not arrive, and it is the field they would otherwise go hunting through
 * the customer record for. It is also what was really used: a customer whose
 * number changed last week still received the old one on Monday, and the
 * profile no longer says so.
 */
export async function journeyMessages(
  journeyId: string,
  input: { page?: number; pageSize?: number; status?: string } = {},
) {
  const tenantId = requireTenantId();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  const where: Prisma.MessageLogWhereInput = {
    tenantId,
    journeyRun: { journeyId },
    ...(input.status ? { status: input.status as MessageStatus } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.messageLog.findMany({
      where,
      orderBy: { queuedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        channel: true,
        status: true,
        toAddress: true,
        errorMessage: true,
        queuedAt: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        clickedAt: true,
        customer: { select: { id: true, firstName: true, lastName: true } },
        template: { select: { name: true } },
      },
    }),
    prisma.messageLog.count({ where }),
  ]);

  return {
    items: items.map((m) => ({
      ...m,
      customerName: m.customer ? `${m.customer.firstName} ${m.customer.lastName ?? ''}`.trim() : 'Unknown',
      /** Named for what it is on this channel, so the column header can follow. */
      addressKind: m.channel === 'EMAIL' ? ('email' as const) : ('phone' as const),
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * Every automation at a glance, for the list page.
 *
 * Deliberately one query rather than one per journey: a salon has a dozen
 * automations and this is the screen that loads first.
 */
export async function journeyOverview(input: JourneyRange = {}) {
  const tenantId = requireTenantId();
  const { from, to } = rangeOf(input);

  const [journeys, runCounts, messageCounts] = await Promise.all([
    prisma.journey.findMany({
      where: { tenantId },
      select: { id: true, name: true, trigger: true, isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.journeyRun.groupBy({
      by: ['journeyId'],
      where: { journey: { tenantId }, startedAt: { gte: from, lte: to } },
      _count: { _all: true },
      _max: { startedAt: true },
    }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where: { tenantId, journeyRunId: { not: null }, queuedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
  ]);

  const runs = new Map(runCounts.map((r) => [r.journeyId, r]));

  return {
    period: { from: dateKey(from), to: dateKey(to) },
    journeys: journeys.map((j) => {
      const stat = runs.get(j.id);
      return {
        ...j,
        runs: stat?._count._all ?? 0,
        lastRunAt: stat?._max.startedAt ?? null,
        /**
         * An automation that is switched on and has not fired in the period is
         * the single most useful thing this screen can point at: it is the
         * failure that makes no noise.
         */
        silent: j.isActive && (stat?._count._all ?? 0) === 0,
      };
    }),
    messagesByStatus: Object.fromEntries(messageCounts.map((m) => [m.status, m._count._all])),
    totalMessages: messageCounts.reduce((n, m) => n + m._count._all, 0),
  };
}
