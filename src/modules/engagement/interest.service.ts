import { prisma } from '../../core/prisma';
import { runUnscoped, requireTenantId } from '../../core/context';
import { logger } from '../../core/logger';
import { interestFrom, interestIsFresh, type InterestSignal } from './engagement';
import { rollUpInterest } from './gallery-interest';
import { addDays } from '../../core/dates';

/**
 * WHAT A CUSTOMER HAS BEEN LOOKING AT, ROLLED UP.
 *
 * The SiteVisit rows are the record. This is the answer to the only question a
 * campaign ever asks of them — "who has been looking at hair spa?" — without
 * scanning an event log that grows forever and never shrinks.
 *
 * Nothing here decides to message anybody. See the note on CustomerInterest in
 * the schema for why that separation is the whole point.
 */

/**
 * Turn one reported event into interest rows, if it says anything.
 *
 * The service is looked up in THIS salon before anything is written: the id
 * arrives from a public endpoint, so without the check anybody could write rows
 * naming services that are not theirs, and a campaign reading the rollup would
 * join them to nothing.
 */
export async function recordInterest(input: {
  tenantId: string;
  customerId: string;
  event: string;
  metadata: Record<string, unknown> | null;
}): Promise<number> {
  const serviceId = typeof input.metadata?.serviceId === 'string' ? input.metadata.serviceId : null;

  const service = serviceId
    ? await runUnscoped(() =>
        prisma.service.findFirst({
          where: { id: serviceId, tenantId: input.tenantId },
          select: { id: true, name: true, categoryId: true, category: { select: { name: true } } },
        }),
      )
    : null;

  const signals: InterestSignal[] = interestFrom(input.event, input.metadata, () =>
    service
      ? {
          id: service.id,
          name: service.name,
          categoryId: service.categoryId,
          categoryName: service.category?.name ?? null,
        }
      : null,
  );

  for (const signal of signals) {
    /**
     * An upsert per signal, not a transaction over all of them.
     *
     * Two signals (the service and its category) and either can fail on its own
     * without making the other wrong. A customer whose category row was written
     * and whose service row was not is still correctly interested in colour;
     * rolling both back would lose that for no gain.
     */
    await runUnscoped(() =>
      prisma.customerInterest.upsert({
        where: {
          customerId_kind_refId: {
            customerId: input.customerId,
            kind: signal.kind,
            refId: signal.refId,
          },
        },
        create: {
          tenantId: input.tenantId,
          customerId: input.customerId,
          kind: signal.kind,
          refId: signal.refId,
          label: signal.label,
          views: 1,
        },
        update: {
          views: { increment: 1 },
          lastViewedAt: new Date(),
          // Refreshed so a renamed service reads correctly from here on, while
          // an interest in something since deleted keeps the name it had.
          label: signal.label,
        },
      }),
    ).catch((err: unknown) =>
      logger.warn({ err, customerId: input.customerId, signal }, 'interest not recorded'),
    );
  }

  return signals.length;
}

/**
 * What one customer has shown interest in, for their profile.
 *
 * Services first and then categories, each newest-first. Stale ones are
 * returned but flagged rather than filtered: "she was looking at hair spa, but
 * that was in March" is worth a salon knowing, and a list that silently drops
 * rows is a list somebody eventually stops believing.
 */
export async function customerInterests(customerId: string) {
  const tenantId = requireTenantId();

  const rows = await prisma.customerInterest.findMany({
    where: { tenantId, customerId },
    orderBy: [{ lastViewedAt: 'desc' }],
    take: 40,
  });

  return rows.map((row) => ({
    kind: row.kind,
    refId: row.refId,
    label: row.label,
    views: row.views,
    lastViewedAt: row.lastViewedAt,
    fresh: interestIsFresh(row.lastViewedAt),
  }));
}

/**
 * One customer's own activity, as a list of what they did and when.
 *
 * Grouped by session, because the journey is the interesting part: "opened the
 * gallery, looked at hair, looked at hair spa, started booking and stopped" is
 * a story, and the same four rows ungrouped are not.
 */
export async function customerActivity(customerId: string, limit = 60) {
  const tenantId = requireTenantId();

  const events = await prisma.siteVisit.findMany({
    where: { tenantId, customerId },
    orderBy: { at: 'desc' },
    take: Math.min(200, limit),
    select: {
      id: true,
      event: true,
      path: true,
      label: true,
      sessionId: true,
      metadata: true,
      at: true,
      campaignId: true,
    },
  });

  /**
   * Sessions in the order they last happened, events inside them oldest-first.
   *
   * The two orders are different on purpose: the salon wants the most recent
   * visit at the top, and inside it wants to read the journey forwards.
   */
  const sessions = new Map<string, typeof events>();
  for (const event of events) {
    const key = event.sessionId ?? `single:${event.id}`;
    const list = sessions.get(key);
    if (list) list.push(event);
    else sessions.set(key, [event]);
  }

  return [...sessions.entries()].map(([sessionId, list]) => ({
    sessionId: sessionId.startsWith('single:') ? null : sessionId,
    startedAt: list[list.length - 1]!.at,
    endedAt: list[0]!.at,
    campaignId: list[0]!.campaignId,
    events: [...list].reverse().map((event) => ({
      event: event.event,
      path: event.path,
      label: event.label,
      metadata: event.metadata,
      at: event.at,
    })),
  }));
}

/**
 * WHAT EVERYBODY LOOKED AT, NOT WHAT ONE PERSON LOOKED AT.
 *
 * customerInterests answers "what has Priya been looking at". This answers the
 * question the salon owner actually asks first: of everybody who opened the
 * gallery this month, which work did they open, and how many different people
 * were there.
 *
 * It is the number that says what to photograph next. A bridal section opened
 * by forty people and a nails section opened by four is an instruction about
 * where to point the camera, and no amount of per-customer detail says it.
 *
 * Counted in memory rather than by the database, because "how many different
 * people" spans two identifiers — a known customer by id, everybody else by
 * their browser tab — and a GROUP BY cannot dedupe across the two. Bounded by
 * MAX_EVENTS so a busy year cannot turn one screen into a table scan; the
 * result says when it hit the ceiling rather than quietly reporting a
 * fraction as though it were the whole.
 */
const MAX_EVENTS = 50_000;

export async function galleryInterest(input: { from?: Date; to?: Date }) {
  const tenantId = requireTenantId();

  const from = input.from ?? addDays(new Date(), -30);
  const to = input.to ?? new Date();

  const rows = await prisma.siteVisit.findMany({
    where: {
      tenantId,
      at: { gte: from, lte: to },
      event: { in: ['gallery_filter', 'service_view'] },
    },
    select: { event: true, label: true, metadata: true, customerId: true, sessionId: true },
    orderBy: { at: 'desc' },
    take: MAX_EVENTS + 1,
  });

  const truncated = rows.length > MAX_EVENTS;
  const rollup = rollUpInterest(truncated ? rows.slice(0, MAX_EVENTS) : rows);

  return {
    from,
    to,
    ...rollup,
    /**
     * Said out loud. A report quietly showing the most recent 50,000 events as
     * though it were the period is worse than one that admits the period was
     * too big, because nobody can tell by looking.
     */
    truncated,
  };
}
