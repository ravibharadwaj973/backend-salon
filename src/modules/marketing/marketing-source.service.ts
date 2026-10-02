import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped, requireTenantId } from '../../core/context';
import { branchFilter } from '../../core/scope';
import { BadRequest, NotFound } from '../../core/errors';
import { add, d, div, round2, toNumber } from '../../core/money';
import { logger } from '../../core/logger';

/**
 * WHAT THE SALON SPENT, AND WHAT CAME BACK.
 *
 * This is the one number Ads Manager can never produce. Meta knows the clicks;
 * it does not know that twelve of those people sat in a chair and paid ₹48,000,
 * because Meta does not have the invoices. Parlon has both ends, and this is
 * where they are joined.
 *
 * The chain, and every link already existed except the first:
 *
 *   a tap on a link        → marketing_clicks
 *   a DM from an ad        → conversations.sourceRef (Meta sends the referral
 *                            once, on the first message, or never)
 *   a booking              → appointments.sourceRef, which the public booking
 *                            route has carried all along
 *   money                  → the invoice raised against that appointment
 */

export interface SourceResult {
  id: string;
  name: string;
  code: string;
  channel: string;
  kind: string;
  isActive: boolean;
  spend: number;
  dailyBudget: number | null;
  clicks: number;
  /** Conversations opened by somebody arriving from this source. */
  conversations: number;
  bookings: number;
  /** Of those bookings, the ones that have actually been billed. */
  billed: number;
  revenue: number;
  /**
   * Null rather than zero or Infinity when there is nothing to divide.
   *
   * A source with no spend has no cost per booking — not a cost of zero, which
   * would sort to the top of "cheapest" and tell the salon their best paid
   * channel is the one they never paid for.
   */
  costPerBooking: number | null;
  /** Revenue per rupee spent. Null when nothing was spent, for the same reason. */
  returnOnSpend: number | null;
}

/** The salon's promoted things, newest first. */
export async function listSources(input: { branchId?: string; activeOnly?: boolean }) {
  const tenantId = requireTenantId();
  return prisma.marketingSource.findMany({
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      ...(input.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });
}

export interface SourceInput {
  name: string;
  code: string;
  channel?: 'INSTAGRAM' | 'MESSENGER' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'IN_APP';
  kind?: 'ORGANIC_POST' | 'BOOSTED_POST' | 'AD' | 'QR' | 'OTHER';
  spend?: number;
  dailyBudget?: number | null;
  startedOn?: Date | null;
  endedOn?: Date | null;
  branchId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

/**
 * The code is lower-cased and stripped here rather than validated into
 * submission, because it is typed by somebody who is also running a salon. It
 * travels in a URL and in Meta's referral payload, so anything that would need
 * escaping in either is simply not allowed to exist.
 */
export function normaliseCode(raw: string): string {
  const code = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!code) throw BadRequest('A code needs at least one letter or number');
  return code;
}

export async function createSource(input: SourceInput) {
  const tenantId = requireTenantId();
  const code = normaliseCode(input.code);

  const clash = await prisma.marketingSource.findFirst({ where: { tenantId, code }, select: { id: true } });
  if (clash) throw BadRequest(`“${code}” is already in use — every link needs its own code`);

  return prisma.marketingSource.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      name: input.name.trim(),
      code,
      channel: input.channel ?? 'INSTAGRAM',
      kind: input.kind ?? 'BOOSTED_POST',
      spend: input.spend ?? 0,
      dailyBudget: input.dailyBudget ?? null,
      startedOn: input.startedOn ?? null,
      endedOn: input.endedOn ?? null,
      notes: input.notes ?? null,
    },
  });
}

export async function updateSource(id: string, input: Partial<SourceInput>) {
  const tenantId = requireTenantId();
  const existing = await prisma.marketingSource.findFirst({ where: { id, tenantId } });
  if (!existing) throw NotFound('Marketing source');

  /**
   * The code may change, and the old links do not stop working by magic — they
   * stop working at all. Refused rather than silently orphaning every printed
   * QR code and every link already in an ad that is live right now.
   */
  if (input.code && normaliseCode(input.code) !== existing.code) {
    throw BadRequest(
      'A code cannot be changed once it exists: links already printed or already inside a live ad point at ' +
        'the old one and would stop being counted. Make a new source instead.',
    );
  }

  return prisma.marketingSource.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.spend !== undefined ? { spend: input.spend } : {}),
      ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget } : {}),
      ...(input.startedOn !== undefined ? { startedOn: input.startedOn } : {}),
      ...(input.endedOn !== undefined ? { endedOn: input.endedOn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
    },
  });
}

/**
 * Somebody tapped the link. Unscoped, because this runs on a public redirect
 * with no session — the code itself is what identifies the salon.
 *
 * Returns the source so the caller can forward them on. Never throws: a
 * counting failure must not stop somebody reaching the booking page, which is
 * the entire point of the link.
 */
export async function recordClick(code: string): Promise<{ tenantId: string; code: string } | null> {
  const source = await runUnscoped(() =>
    prisma.marketingSource.findFirst({
      where: { code: code.toLowerCase() },
      select: { id: true, tenantId: true, code: true },
    }),
  ).catch(() => null);

  if (!source) return null;

  await runUnscoped(() =>
    prisma.marketingClick.create({ data: { tenantId: source.tenantId, sourceId: source.id } }),
  ).catch((err: unknown) => {
    // Counted or not, they are going to the booking page.
    logger.warn({ err, code }, 'marketing click not recorded');
  });

  return { tenantId: source.tenantId, code: source.code };
}

/**
 * EVERY SOURCE, WITH WHAT IT COST AND WHAT IT RETURNED.
 *
 * ── The date rule, which is the part worth arguing about ─────────────────
 *
 * A booking counts in the range it was MADE in, because that is when the ad did
 * its work. The revenue attached to it is counted whenever it was billed, even
 * if that falls outside the range — a reel that filled next month's diary did
 * that, and crediting the money to the month the customer happened to turn up
 * would make the reel look like a failure in the month it actually worked.
 *
 * So `bookings` and `revenue` are not measured over the same window on purpose,
 * and the screen says so rather than hoping nobody notices.
 */
export async function sourceResults(input: {
  from: Date;
  to: Date;
  branchId?: string;
}): Promise<SourceResult[]> {
  const tenantId = requireTenantId();

  const sources = await prisma.marketingSource.findMany({
    where: { tenantId, ...branchFilter(input.branchId) },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });
  if (sources.length === 0) return [];

  const codes = sources.map((source) => source.code);
  const ids = sources.map((source) => source.id);
  const made = { gte: input.from, lte: input.to };

  const [clicks, conversations, appointments] = await Promise.all([
    prisma.marketingClick.groupBy({
      by: ['sourceId'],
      where: { tenantId, sourceId: { in: ids }, at: made },
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ['sourceRef'],
      where: { tenantId, sourceRef: { in: codes }, createdAt: made },
      _count: { _all: true },
    }),
    prisma.appointment.findMany({
      where: { tenantId, sourceRef: { in: codes }, createdAt: made, status: { not: 'CANCELLED' } },
      select: { id: true, sourceRef: true },
    }),
  ]);

  /**
   * The money, fetched for those appointments alone and with no date filter of
   * its own — see the note above. A voided bill is excluded because it is not
   * revenue; it is a mistake that was corrected.
   */
  const invoices = appointments.length
    ? await prisma.invoice.findMany({
        where: { tenantId, appointmentId: { in: appointments.map((row) => row.id) }, status: { not: 'VOID' } },
        select: { appointmentId: true, grandTotal: true },
      })
    : [];

  const clicksBySource = new Map(clicks.map((row) => [row.sourceId, row._count._all]));
  const conversationsByCode = new Map(conversations.map((row) => [row.sourceRef ?? '', row._count._all]));

  const codeOfAppointment = new Map(appointments.map((row) => [row.id, row.sourceRef ?? '']));
  const bookingsByCode = new Map<string, number>();
  for (const row of appointments) {
    const code = row.sourceRef ?? '';
    bookingsByCode.set(code, (bookingsByCode.get(code) ?? 0) + 1);
  }

  const revenueByCode = new Map<string, Prisma.Decimal>();
  const billedByCode = new Map<string, number>();
  for (const invoice of invoices) {
    const code = invoice.appointmentId ? (codeOfAppointment.get(invoice.appointmentId) ?? '') : '';
    if (!code) continue;
    revenueByCode.set(code, add(revenueByCode.get(code) ?? d(0), invoice.grandTotal));
    billedByCode.set(code, (billedByCode.get(code) ?? 0) + 1);
  }

  return sources.map((source) => {
    const spend = toNumber(source.spend);
    const bookings = bookingsByCode.get(source.code) ?? 0;
    const revenue = toNumber(revenueByCode.get(source.code) ?? d(0));

    return {
      id: source.id,
      name: source.name,
      code: source.code,
      channel: source.channel,
      kind: source.kind,
      isActive: source.isActive,
      spend,
      dailyBudget: source.dailyBudget != null ? toNumber(source.dailyBudget) : null,
      clicks: clicksBySource.get(source.id) ?? 0,
      conversations: conversationsByCode.get(source.code) ?? 0,
      bookings,
      billed: billedByCode.get(source.code) ?? 0,
      revenue,
      // Null, not zero and not Infinity — see the note on the type.
      costPerBooking: spend > 0 && bookings > 0 ? toNumber(round2(div(spend, bookings))) : null,
      returnOnSpend: spend > 0 ? toNumber(round2(div(revenue, spend))) : null,
    };
  });
}
