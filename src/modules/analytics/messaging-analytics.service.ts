import { Prisma } from '@prisma/client';
import type { Channel, MessagePurpose, MessageStatus } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { add, d, round2 } from '../../core/money';
import { dateKey, dayjs, endOfDay, startOfDay } from '../../core/dates';
import { PURPOSE_LABELS, PURPOSE_ORDER } from '../../messaging/purpose';

/**
 * DID THE MESSAGE ARRIVE, AND DID ANYBODY LOOK AT IT?
 *
 * A salon pays per message and has no way to tell a campaign that worked from
 * one that was never delivered. Both look identical from the inside: the
 * screen said "sent 400", the bill said 400, and the shop was empty on
 * Saturday either way.
 *
 * ── The one thing this file is careful about ──────────────────────────────
 *
 * The three channels do not report the same events, and pretending otherwise
 * is the failure this whole module exists to avoid:
 *
 *   WhatsApp  sent → delivered → read (blue ticks). Clicks only where we
 *             rewrote the link ourselves.
 *   Email     sent → delivered → opened → clicked, plus bounces and spam
 *             complaints, which no other channel reports.
 *   SMS       sent → delivered. That is all. The operator never tells us
 *             whether it was read, because nobody can know.
 *
 * So "SMS read rate: 0%" is not a result — it is a measurement that does not
 * exist, and shown as 0% next to WhatsApp's 71% it reads as catastrophic
 * failure. Every rate here is therefore `number | null`, and null means NOT
 * MEASURED rather than zero. The UI is required to render the two
 * differently.
 *
 * Email opens carry their own asterisk: Apple Mail Privacy Protection fetches
 * the tracking pixel whether or not a human looked, so email open rates run
 * high and are not comparable with WhatsApp's. That is flagged rather than
 * silently corrected, because any correction would be a guess.
 */

// ---------------------------------------------------------------- shapes ---

/** What a channel is physically able to tell us. */
export interface ChannelCapability {
  delivery: boolean;
  read: boolean;
  click: boolean;
  bounce: boolean;
  complaint: boolean;
  /** Shown beside the numbers when a rate is missing for a reason, not by accident. */
  note: string | null;
}

export const CAPABILITIES: Record<Channel, ChannelCapability> = {
  WHATSAPP: {
    delivery: true,
    read: true,
    click: true,
    bounce: false,
    complaint: false,
    note: 'WhatsApp reports delivery and blue ticks. Clicks are counted only on links the app shortened.',
  },
  EMAIL: {
    delivery: true,
    read: true,
    click: true,
    bounce: true,
    complaint: true,
    note: 'Email opens are approximate — some mail apps, Apple Mail in particular, load the tracking pixel whether or not anyone read it. Treat opens as an upper bound and clicks as the real signal.',
  },
  SMS: {
    delivery: true,
    read: false,
    click: false,
    bounce: false,
    complaint: false,
    note: 'SMS operators report delivery only. Nobody can tell whether an SMS was read, so those figures are left blank rather than shown as zero.',
  },
  /**
   * In-app notices never leave the building: there is no provider, no charge
   * and no receipt of any kind. Included so the enum is covered, and reported
   * as measuring nothing rather than as a channel performing badly.
   */
  IN_APP: {
    delivery: false,
    read: false,
    click: false,
    bounce: false,
    complaint: false,
    note: 'In-app notices are shown inside the app, so there is nothing to deliver and no receipt to read. They cost nothing and are not counted in delivery figures.',
  },
};

/** The channels a message is actually sent over, in the order they are shown. */
export const SENDING_CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS'] as const;

/** One row of the funnel: raw counts plus the rates that channel can support. */
export interface Funnel {
  /** Everything queued in the period, whatever became of it. */
  total: number;
  /** Handed to the provider. */
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  replied: number;
  bounced: number;
  complained: number;
  failed: number;
  /** Never attempted: no consent, no plan, a dead address, a missing variable. */
  skipped: number;
  /** Still waiting. */
  queued: number;
  /** Of the skipped, the ones this feature suppressed to save money. */
  suppressed: number;
  /** null where the channel cannot measure it. */
  deliveryRate: number | null;
  readRate: number | null;
  clickRate: number | null;
  replyRate: number | null;
  bounceRate: number | null;
  cost: Prisma.Decimal;
  revenue: Prisma.Decimal;
}

type Bucket = Record<MessageStatus, number> & { suppressed: number };

const EMPTY_BUCKET = (): Bucket => ({
  QUEUED: 0,
  SENT: 0,
  DELIVERED: 0,
  READ: 0,
  CLICKED: 0,
  DELAYED: 0,
  BOUNCED: 0,
  COMPLAINED: 0,
  FAILED: 0,
  SKIPPED: 0,
  suppressed: 0,
});

/**
 * Statuses are a LAST-KNOWN state, not a tally of what happened.
 *
 * A message that was delivered and then read sits at READ, and counting
 * `status = 'DELIVERED'` as "delivered" would report it as undelivered. Every
 * stage therefore counts everything at or past it, which is also why delivery
 * can never be lower than reads — a funnel that widens as it goes is a bug
 * somebody would have to reverse-engineer.
 */
const AT_LEAST_SENT: MessageStatus[] = ['SENT', 'DELIVERED', 'READ', 'CLICKED', 'COMPLAINED', 'DELAYED'];
const AT_LEAST_DELIVERED: MessageStatus[] = ['DELIVERED', 'READ', 'CLICKED', 'COMPLAINED'];
const AT_LEAST_READ: MessageStatus[] = ['READ', 'CLICKED'];

const sum = (b: Bucket, keys: MessageStatus[]) => keys.reduce((n, k) => n + b[k], 0);

/** A rate, or null when the channel cannot measure that stage. */
function rate(numerator: number, denominator: number, measurable: boolean): number | null {
  if (!measurable) return null;
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function toFunnel(
  bucket: Bucket,
  money: { cost: Prisma.Decimal; revenue: Prisma.Decimal },
  replied: number,
  can: ChannelCapability,
): Funnel {
  // Bounces and hard failures both mean "did not arrive"; a bounce is just an
  // email's word for it. Counted as sent, because the salon was charged.
  const sent = sum(bucket, AT_LEAST_SENT) + bucket.BOUNCED;
  const delivered = sum(bucket, AT_LEAST_DELIVERED);
  const read = sum(bucket, AT_LEAST_READ);
  const total = Object.values(bucket).reduce((n, v) => n + v, 0) - bucket.suppressed;

  return {
    total,
    sent,
    delivered,
    read,
    clicked: bucket.CLICKED,
    replied,
    bounced: bucket.BOUNCED,
    complained: bucket.COMPLAINED,
    failed: bucket.FAILED,
    skipped: bucket.SKIPPED,
    queued: bucket.QUEUED + bucket.DELAYED,
    suppressed: bucket.suppressed,
    deliveryRate: rate(delivered, sent, can.delivery),
    readRate: rate(read, delivered, can.read),
    // Against delivered, not against opens: an open is a pixel, a click is a
    // person, and dividing one soft number by another hides both.
    clickRate: rate(bucket.CLICKED, delivered, can.click),
    replyRate: rate(replied, delivered, true),
    bounceRate: rate(bucket.BOUNCED, sent, can.bounce),
    cost: round2(money.cost),
    revenue: round2(money.revenue),
  };
}

// ----------------------------------------------------------------- input ---

export interface MessagingFilter {
  from: Date;
  to: Date;
  branchId?: string;
  channel?: Channel;
  purpose?: MessagePurpose;
  customerId?: string;
}

function whereOf(filter: MessagingFilter): Prisma.MessageLogWhereInput {
  return {
    tenantId: requireTenantId(),
    ...optionalBranchFilter(filter.branchId),
    queuedAt: { gte: startOfDay(filter.from), lte: endOfDay(filter.to) },
    ...(filter.channel ? { channel: filter.channel } : {}),
    ...(filter.purpose ? { purpose: filter.purpose } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
  };
}

/**
 * One grouped read of the log, turned into buckets.
 *
 * Grouped in the database rather than pulled row by row: a busy salon sends
 * tens of thousands of messages a month and this screen must not be the
 * reason the server falls over.
 */
async function bucketsBy<K extends 'channel' | 'purpose'>(
  key: K,
  filter: MessagingFilter,
): Promise<Map<string, { bucket: Bucket; cost: Prisma.Decimal; revenue: Prisma.Decimal; replied: number }>> {
  const where = whereOf(filter);

  const [rows, replies] = await Promise.all([
    prisma.messageLog.groupBy({
      by: [key, 'status', 'errorCode'] as never,
      where,
      _count: { _all: true },
      _sum: { cost: true, attributedRevenue: true },
    }) as unknown as Promise<
      Array<Record<string, unknown> & {
        status: MessageStatus;
        errorCode: string | null;
        _count: { _all: number };
        _sum: { cost: Prisma.Decimal | null; attributedRevenue: Prisma.Decimal | null };
      }>
    >,
    prisma.messageLog.groupBy({
      by: [key] as never,
      where: { ...where, repliedAt: { not: null } },
      _count: { _all: true },
    }) as unknown as Promise<Array<Record<string, unknown> & { _count: { _all: number } }>>,
  ]);

  const out = new Map<string, { bucket: Bucket; cost: Prisma.Decimal; revenue: Prisma.Decimal; replied: number }>();

  for (const row of rows) {
    const k = String(row[key]);
    const entry = out.get(k) ?? { bucket: EMPTY_BUCKET(), cost: d(0), revenue: d(0), replied: 0 };
    entry.bucket[row.status] += row._count._all;
    // Money saved is worth as much as money earned, and this is the only
    // place it is visible: a suppressed send is one the salon was not billed
    // for because a previous one bounced.
    if (row.status === 'SKIPPED' && row.errorCode === 'UNDELIVERABLE') {
      entry.bucket.suppressed += row._count._all;
    }
    entry.cost = add(entry.cost, row._sum.cost);
    entry.revenue = add(entry.revenue, row._sum.attributedRevenue);
    out.set(k, entry);
  }

  for (const row of replies) {
    const k = String(row[key]);
    const entry = out.get(k);
    if (entry) entry.replied = row._count._all;
  }

  return out;
}

// --------------------------------------------------------------- reports ---

export interface ChannelReport extends Funnel {
  channel: Channel;
  capability: ChannelCapability;
}

export interface PurposeReport extends Funnel {
  purpose: MessagePurpose;
  label: string;
}

/**
 * The whole picture: one funnel overall, one per channel, one per purpose.
 *
 * Purposes are the answer to the question a category can never answer —
 * "utility" covers an appointment reminder, an invoice and a "how was your
 * visit?", and those succeed and fail for entirely different reasons.
 */
export async function messagingOverview(filter: MessagingFilter) {
  const [byChannel, byPurpose] = await Promise.all([
    bucketsBy('channel', filter),
    bucketsBy('purpose', filter),
  ]);

  const channels: ChannelReport[] = SENDING_CHANNELS
    .filter((c) => !filter.channel || filter.channel === c)
    .map((channel) => {
      const entry = byChannel.get(channel) ?? { bucket: EMPTY_BUCKET(), cost: d(0), revenue: d(0), replied: 0 };
      return {
        channel,
        capability: CAPABILITIES[channel],
        ...toFunnel(entry.bucket, entry, entry.replied, CAPABILITIES[channel]),
      };
    });

  /**
   * A cross-channel rate is only honest where every channel in it can measure
   * the stage. Mixing SMS into a read rate silently divides by a bigger
   * number and makes every campaign look worse the more SMS it used.
   */
  const present = channels.filter((c) => c.total > 0);
  const combined: ChannelCapability = {
    delivery: true,
    read: present.length > 0 && present.every((c) => c.capability.read),
    click: present.length > 0 && present.every((c) => c.capability.click),
    bounce: present.some((c) => c.capability.bounce),
    complaint: present.some((c) => c.capability.complaint),
    note:
      present.length > 1 && !present.every((c) => c.capability.read)
        ? 'Open rates are left blank overall because SMS cannot report them. Look at each channel separately.'
        : null,
  };

  const purposes: PurposeReport[] = PURPOSE_ORDER.filter((p) => !filter.purpose || filter.purpose === p)
    .map((purpose) => {
      const entry = byPurpose.get(purpose) ?? { bucket: EMPTY_BUCKET(), cost: d(0), revenue: d(0), replied: 0 };
      return {
        purpose,
        label: PURPOSE_LABELS[purpose],
        ...toFunnel(entry.bucket, entry, entry.replied, combined),
      };
    })
    .filter((p) => p.total > 0);

  const totalBucket = EMPTY_BUCKET();
  let cost = d(0);
  let revenue = d(0);
  let replied = 0;
  for (const entry of byChannel.values()) {
    for (const k of Object.keys(entry.bucket) as (keyof Bucket)[]) {
      totalBucket[k] += entry.bucket[k];
    }
    cost = add(cost, entry.cost);
    revenue = add(revenue, entry.revenue);
    replied += entry.replied;
  }

  return {
    period: { from: dateKey(filter.from), to: dateKey(filter.to) },
    overall: toFunnel(totalBucket, { cost, revenue }, replied, combined),
    combinedCapability: combined,
    channels,
    purposes,
  };
}

/**
 * The same funnel over time.
 *
 * Grouped in SQL by day, week or month. A trend is what turns "our open rate
 * is 40%" into something actionable — 40% and falling is a different problem
 * from 40% and climbing, and the single number cannot tell them apart.
 */
export async function messagingTrend(
  filter: MessagingFilter & { interval?: 'day' | 'week' | 'month' },
) {
  const tenantId = requireTenantId();
  const interval = filter.interval ?? 'day';
  const from = startOfDay(filter.from);
  const to = endOfDay(filter.to);

  /**
   * Raw SQL, because no ORM can group by a truncated date and the alternative
   * is pulling a year of message rows into memory to bucket them here.
   *
   * Two things this has to get right, neither of which fails loudly:
   *
   *   1. The schema declares no @map, so Postgres holds the columns in camel
   *      case and every identifier must be QUOTED. Unquoted, Postgres folds
   *      them to lower case and the query dies on a column nobody can find.
   *   2. Enums are compared as text rather than cast to their Postgres type
   *      name, so renaming a Prisma enum cannot silently break this.
   *
   * tests/messaging-sql.test.ts checks every quoted identifier below against
   * the Prisma schema, so a renamed field is caught at test time rather than
   * by an owner opening a report.
   */
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"tenantId" = ${tenantId}`,
    Prisma.sql`"queuedAt" BETWEEN ${from} AND ${to}`,
  ];
  if (filter.branchId) conditions.push(Prisma.sql`"branchId" = ${filter.branchId}`);
  if (filter.channel) conditions.push(Prisma.sql`"channel"::text = ${filter.channel}`);
  if (filter.purpose) conditions.push(Prisma.sql`"purpose"::text = ${filter.purpose}`);
  if (filter.customerId) conditions.push(Prisma.sql`"customerId" = ${filter.customerId}`);

  const rows = await prisma.$queryRaw<
    Array<{
      bucket: Date;
      sent: bigint;
      delivered: bigint;
      read: bigint;
      clicked: bigint;
      bounced: bigint;
      failed: bigint;
      skipped: bigint;
      cost: Prisma.Decimal | null;
      revenue: Prisma.Decimal | null;
    }>
  >(Prisma.sql`
    SELECT
      date_trunc(${interval}, "queuedAt") AS bucket,
      COUNT(*) FILTER (WHERE "status"::text IN ('SENT','DELIVERED','READ','CLICKED','COMPLAINED','DELAYED','BOUNCED')) AS sent,
      COUNT(*) FILTER (WHERE "status"::text IN ('DELIVERED','READ','CLICKED','COMPLAINED')) AS delivered,
      COUNT(*) FILTER (WHERE "status"::text IN ('READ','CLICKED')) AS read,
      COUNT(*) FILTER (WHERE "status"::text = 'CLICKED') AS clicked,
      COUNT(*) FILTER (WHERE "status"::text = 'BOUNCED') AS bounced,
      COUNT(*) FILTER (WHERE "status"::text = 'FAILED') AS failed,
      COUNT(*) FILTER (WHERE "status"::text = 'SKIPPED') AS skipped,
      COALESCE(SUM("cost"), 0) AS cost,
      COALESCE(SUM("attributedRevenue"), 0) AS revenue
    FROM "message_logs"
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY 1
    ORDER BY 1
  `);

  return rows.map((r) => ({
    date: dateKey(r.bucket),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    read: Number(r.read),
    clicked: Number(r.clicked),
    bounced: Number(r.bounced),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
    cost: round2(r.cost),
    revenue: round2(r.revenue),
  }));
}

/**
 * Which templates earn their place.
 *
 * Ranked by delivery and reading rather than by volume, because the template
 * sent most is usually just the one attached to the busiest automation.
 * Templates under a floor are excluded: a 100% open rate on three messages is
 * noise, and presenting it as a winner sends the salon rewriting the wrong
 * template.
 */
export async function messagingByTemplate(filter: MessagingFilter & { minSent?: number }) {
  const where = whereOf(filter);
  const minSent = filter.minSent ?? 20;

  const rows = await prisma.messageLog.groupBy({
    by: ['templateId', 'status'],
    where: { ...where, templateId: { not: null } },
    _count: { _all: true },
    _sum: { cost: true, attributedRevenue: true },
  });

  const byTemplate = new Map<string, { bucket: Bucket; cost: Prisma.Decimal; revenue: Prisma.Decimal }>();
  for (const row of rows) {
    const id = row.templateId!;
    const entry = byTemplate.get(id) ?? { bucket: EMPTY_BUCKET(), cost: d(0), revenue: d(0) };
    entry.bucket[row.status] += row._count._all;
    entry.cost = add(entry.cost, row._sum.cost);
    entry.revenue = add(entry.revenue, row._sum.attributedRevenue);
    byTemplate.set(id, entry);
  }

  const templates = await prisma.messageTemplate.findMany({
    where: { id: { in: [...byTemplate.keys()] } },
    select: { id: true, name: true, channel: true, category: true },
  });
  const meta = new Map(templates.map((t) => [t.id, t]));

  return [...byTemplate.entries()]
    .map(([id, entry]) => {
      const t = meta.get(id);
      if (!t) return null;
      const funnel = toFunnel(entry.bucket, entry, 0, CAPABILITIES[t.channel]);
      return { id, name: t.name, channel: t.channel, category: t.category, ...funnel };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.sent >= minSent)
    .sort((a, b) => (b.readRate ?? b.deliveryRate ?? 0) - (a.readRate ?? a.deliveryRate ?? 0));
}

/**
 * ONE CUSTOMER'S SIDE OF THE CONVERSATION.
 *
 * The overall numbers say what the salon does; this says what it did to this
 * person. It is the view that stops the awkward conversations — somebody who
 * has been sent eleven offers in a month and opened none of them is not a
 * lead to push harder, and somebody whose last four messages all failed is
 * not ignoring you.
 */
export async function customerMessaging(customerId: string, input: { from?: Date; to?: Date; limit?: number } = {}) {
  const to = input.to ?? new Date();
  const from = input.from ?? dayjs(to).subtract(12, 'month').toDate();
  const filter: MessagingFilter = { from, to, customerId };

  const [overview, recent, first] = await Promise.all([
    messagingOverview(filter),
    prisma.messageLog.findMany({
      where: whereOf(filter),
      orderBy: { queuedAt: 'desc' },
      take: input.limit ?? 20,
      select: {
        id: true,
        channel: true,
        purpose: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        queuedAt: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        clickedAt: true,
        repliedAt: true,
        template: { select: { name: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.messageLog.findFirst({
      where: { tenantId: requireTenantId(), customerId },
      orderBy: { queuedAt: 'asc' },
      select: { queuedAt: true },
    }),
  ]);

  /**
   * How hard this person is being messaged, per month, so "are we pestering
   * them?" has a number. Nobody asks that question until a customer leaves.
   */
  const months = Math.max(1, dayjs(to).diff(dayjs(from), 'month') || 1);

  return {
    ...overview,
    messagesPerMonth: Math.round((overview.overall.total / months) * 10) / 10,
    firstContactedAt: first?.queuedAt ?? null,
    recent: recent.map((m) => ({
      ...m,
      purposeLabel: PURPOSE_LABELS[m.purpose],
      templateName: m.template?.name ?? null,
    })),
  };
}
