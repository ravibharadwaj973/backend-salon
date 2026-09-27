/**
 * PER-SERVICE RATINGS, CHECKED AGAINST THE VISIT THEY CLAIM TO BE ABOUT.
 *
 * Pure, so the rules can be tested without a database. The one that matters:
 * a customer may only rate the services that were actually on their
 * appointment. The feedback page is public and unauthenticated — anybody with
 * the link can post to it — so an unchecked serviceId means anybody can put a
 * 1 against any service in the salon's catalogue, and the service-performance
 * table stops being evidence of anything.
 *
 * Silently dropped rather than rejected with an error. A form that posts a
 * service the appointment no longer has is far more likely to be a stale tab
 * than an attack, and failing the whole submission would throw away the real
 * ratings alongside the bad one.
 */

export interface SubmittedServiceRating {
  serviceId: string;
  rating: number;
  comment?: string;
}

/** As long as the overall comment, and for the same reason: it is a person typing. */
export const MAX_SERVICE_COMMENT = 500;

export function selectServiceRatings(
  submitted: SubmittedServiceRating[] | undefined,
  /** The service ids actually on this appointment. */
  allowed: readonly string[],
): SubmittedServiceRating[] {
  if (!submitted?.length || allowed.length === 0) return [];

  const permitted = new Set(allowed);
  const seen = new Set<string>();
  const kept: SubmittedServiceRating[] = [];

  for (const row of submitted) {
    if (typeof row?.serviceId !== 'string') continue;
    if (!permitted.has(row.serviceId)) continue;
    // First answer wins. A second rating for the same service is a double
    // submit, not a change of mind — the customer only saw one set of stars.
    if (seen.has(row.serviceId)) continue;

    const rating = Number(row.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) continue;

    seen.add(row.serviceId);
    const comment = row.comment?.trim();
    kept.push({
      serviceId: row.serviceId,
      rating,
      ...(comment ? { comment: comment.slice(0, MAX_SERVICE_COMMENT) } : {}),
    });
  }

  return kept;
}

/**
 * The old single `serviceRating`, derived from the new rows.
 *
 * Kept filled so that every report, average and staff score written before
 * this table existed carries on working untouched — a migration that silently
 * flattens a salon's historic service average to zero is worse than no
 * feature. Rounded because the column is an integer, and the per-service rows
 * are where the real precision lives now.
 *
 * Null when nothing was rated, so the column stays honestly empty rather than
 * recording a 0 nobody gave.
 */
export function meanServiceRating(ratings: readonly { rating: number }[]): number | null {
  if (ratings.length === 0) return null;
  const total = ratings.reduce((sum, row) => sum + row.rating, 0);
  return Math.round(total / ratings.length);
}
