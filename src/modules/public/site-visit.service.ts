import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import type { Prisma } from '@prisma/client';
import { logger } from '../../core/logger';
import { isTrackedEvent, stillIdentifies } from '../engagement/engagement';
import { recordInterest } from '../engagement/interest.service';

/**
 * A REPORT FROM THE SALON'S OWN WEBSITE.
 *
 * The one thing the salon's system could never see: what somebody did after
 * they tapped the link. The funnel went "clicked → booked" with a hole in the
 * middle, so a campaign where forty people opened the gallery and nobody
 * booked read exactly like a campaign nobody opened. The salon's next move is
 * completely different for each — rework the offer, or rework the message.
 *
 * The endpoint that calls this is public and unauthenticated, which means
 * everything below is written on the assumption that the body is hostile.
 */

/**
 * The events the website is allowed to report. Anything else is dropped.
 *
 * The list lives in the engagement module, beside the rule about which of them
 * says a customer is interested in something — the two have to agree, and two
 * copies of a list of event names drift the first time a page is added.
 */

/**
 * How many reports one tracked link may ever file.
 *
 * A public write endpoint with no ceiling is a way to fill somebody's disk
 * from a laptop. This is also generous: a customer who reads four pages and
 * comes back twice is well inside it, and the funnel only needs to know THAT
 * they came, so the hundredth report was never going to change an answer.
 */
const MAX_PER_LINK = 100;

export interface VisitReport {
  code: string;
  event: string;
  path: string;
  label?: string;
  /** One tab's worth of events, tied together. See the schema note. */
  sessionId?: string;
  /** What the event is about — a service id for service_view. */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata, cut down to what an event needs.
 *
 * An allow-list rather than a size limit on the whole object: the endpoint is
 * public, and "anything up to 2KB" is still anything. Each key here exists
 * because some page reports it, and a key nothing reads is a key nothing should
 * be able to write.
 */
function sanitizeMetadata(raw: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!raw) return undefined;

  const out: Record<string, string> = {};
  for (const key of ['serviceId', 'categoryId', 'collection', 'branchId', 'offerId'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, 64);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export async function recordSiteVisit(tenantId: string, report: VisitReport): Promise<{ recorded: boolean }> {
  if (!isTrackedEvent(report.event)) return { recorded: false };

  const link = await runUnscoped(() =>
    prisma.trackedLink.findUnique({
      where: { code: report.code },
      select: {
        id: true,
        tenantId: true,
        messageLogId: true,
        campaignId: true,
        customerId: true,
        identifiesUntil: true,
      },
    }),
  );

  /**
   * A code from another salon is not an error to shout about, and it must not
   * be written. The website posts to its own salon's slug, so a mismatch means
   * either a forwarded link or somebody trying it on; either way the row would
   * credit one salon's campaign with another's traffic.
   */
  if (!link || link.tenantId !== tenantId) return { recorded: false };

  /**
   * Past its window, a link is nobody's.
   *
   * This is the case the whole `identifiesUntil` column exists for: a customer
   * forwards the gallery link to her sister in June, the sister browses, and
   * without this the sister's session is written against the customer's name
   * and then fed into the interest rollup a campaign reads. Dropped rather than
   * stored anonymously, because a row with a tracked link and no customer is
   * indistinguishable from a bug.
   */
  if (!stillIdentifies(link)) return { recorded: false };

  const already = await runUnscoped(() => prisma.siteVisit.count({ where: { trackedLinkId: link.id } }));
  if (already >= MAX_PER_LINK) return { recorded: false };

  /**
   * The path, cut back to a path.
   *
   * A query string is where somebody's email address ends up by accident — a
   * booking form that puts the customer's phone in the URL, a link somebody
   * pasted with their own token on it. This table has no use for one, so it
   * never stores one, rather than promising to be careful later.
   */
  const path = ('/' + report.path.replace(/^\/+/, '').split('?')[0]!.split('#')[0]!).slice(0, 200);

  await runUnscoped(() =>
    prisma.siteVisit.create({
      data: {
        tenantId,
        trackedLinkId: link.id,
        messageLogId: link.messageLogId,
        campaignId: link.campaignId,
        customerId: link.customerId,
        event: report.event,
        path,
        label: report.label?.slice(0, 80) ?? null,
        sessionId: report.sessionId?.slice(0, 64) ?? null,
        /**
         * Bounded before it is stored. This is a public endpoint and metadata
         * is a Json column, which together is a way to put a megabyte of
         * anything into a salon's database from a laptop.
         */
        metadata: sanitizeMetadata(report.metadata),
      },
    }),
  );

  /**
   * The rollup, after the event is safely recorded.
   *
   * Order matters: the event log is the record and the rollup is derived from
   * it, so a failure here loses a convenience and not a fact. Awaited rather
   * than fired off, because the alternative is a request that has returned
   * while a write is still in flight — and on a serverless host that write
   * simply does not happen.
   */
  if (link.customerId) {
    await recordInterest({
      tenantId,
      customerId: link.customerId,
      event: report.event,
      metadata: report.metadata ?? null,
    }).catch((err: unknown) => logger.warn({ err }, 'interest rollup skipped'));
  }

  /**
   * Denormalised onto the message as well, so a funnel is one query rather
   * than a join per stage — the same trade the campaign counters already make.
   * First visit only for the timestamp: "when did they come back" is a
   * question about the first time, not the last.
   */
  if (link.messageLogId) {
    await runUnscoped(() =>
      prisma.messageLog.update({
        where: { id: link.messageLogId! },
        data: { siteViews: { increment: 1 } },
      }),
    ).catch((err: unknown) => logger.debug({ err }, 'site visit counter not updated'));

    // updateMany with siteVisitedAt: null in the WHERE is what makes this
    // first-visit-only without reading the row first — a second report finds
    // nothing to update and leaves the original timestamp alone.
    await runUnscoped(() =>
      prisma.messageLog.updateMany({
        where: { id: link.messageLogId!, siteVisitedAt: null },
        data: { siteVisitedAt: new Date() },
      }),
    ).catch(() => undefined);
  }

  return { recorded: true };
}
