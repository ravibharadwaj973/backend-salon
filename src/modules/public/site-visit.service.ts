import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';

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

/** The events the website is allowed to report. Anything else is dropped. */
const EVENTS = new Set(['page_view', 'gallery_filter', 'booking_started', 'booked']);

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
}

export async function recordSiteVisit(tenantId: string, report: VisitReport): Promise<{ recorded: boolean }> {
  if (!EVENTS.has(report.event)) return { recorded: false };

  const link = await runUnscoped(() =>
    prisma.trackedLink.findUnique({
      where: { code: report.code },
      select: { id: true, tenantId: true, messageLogId: true, campaignId: true, customerId: true },
    }),
  );

  /**
   * A code from another salon is not an error to shout about, and it must not
   * be written. The website posts to its own salon's slug, so a mismatch means
   * either a forwarded link or somebody trying it on; either way the row would
   * credit one salon's campaign with another's traffic.
   */
  if (!link || link.tenantId !== tenantId) return { recorded: false };

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
      },
    }),
  );

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
