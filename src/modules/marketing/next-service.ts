/**
 * WHAT TO SHOW SOMEBODY NEXT, LEARNED FROM THE SALON'S OWN BOOK.
 *
 * A follow-up that says "come back" is a reminder. One that says "people who
 * have their hair cut here usually have a spa next — here is that work" is a
 * suggestion, and it is the difference between a message that gets read and
 * one that gets a booking.
 *
 * ── Why this is not a hardcoded list ──────────────────────────────────────
 *
 * The obvious version is a table: haircut leads to hair spa, facial leads to
 * cleanup. It is obvious and it is wrong, because it encodes ONE salon's idea
 * of what goes together and then ships it to every salon. A men's grooming
 * bar and a bridal studio pair completely different things, and neither
 * resembles the guess.
 *
 * So the pairing is counted from what this salon's own customers actually buy
 * together. The salon teaches the software, not the other way round.
 *
 * ── Why a minimum before it will speak ───────────────────────────────────
 *
 * Two customers who both had a cut and a pedicure is a coincidence. Sent as
 * "people who have a cut here usually have a pedicure", it is a coincidence
 * dressed as a fact, in a message signed by the salon. So a pairing has to be
 * seen across at least MIN_SUPPORT different customers before it is allowed
 * to be a suggestion; below that the function says nothing, and the caller
 * sends the plain gallery link instead.
 *
 * Everything here is pure. The rows come from the database; the judgement
 * about what they are worth is tested without one.
 */

/** One service, bought once, by one customer. */
export interface PurchaseRow {
  customerId: string;
  serviceId: string;
}

export interface CatalogueService {
  id: string;
  name: string;
  categoryId: string | null;
  /** A retired service must never be suggested — it cannot be booked. */
  isActive: boolean;
}

/**
 * Three customers, not two.
 *
 * Two is the smallest number that can look like a pattern and the largest
 * that is routinely an accident. Three is still thin, which is why a thin
 * answer loses to a same-category one below rather than winning by default.
 */
export const MIN_SUPPORT = 3;

export interface Suggestion {
  serviceId: string;
  name: string;
  /** How many different customers paired it with the service they just had. */
  support: number;
  /** How it was chosen — shown to the salon, never to the customer. */
  basis: 'PAIRED' | 'SAME_CATEGORY';
}

export function suggestNextService(input: {
  /** What they had, and what not to suggest back to them. */
  lastServiceId: string;
  lastCategoryId: string | null;
  /** Everything this customer has ever had — never suggest what they always buy. */
  alreadyHad: readonly string[];
  /** The salon's recent purchases, any customers, for counting pairs. */
  history: readonly PurchaseRow[];
  catalogue: readonly CatalogueService[];
}): Suggestion | null {
  const bookable = new Map(input.catalogue.filter((s) => s.isActive).map((s) => [s.id, s]));
  const exclude = new Set<string>([input.lastServiceId, ...input.alreadyHad]);

  /**
   * Who bought what, so a customer who had the same service five times counts
   * once. Otherwise a single regular's habit outvotes the rest of the salon.
   */
  const byCustomer = new Map<string, Set<string>>();
  for (const row of input.history) {
    const set = byCustomer.get(row.customerId) ?? new Set<string>();
    set.add(row.serviceId);
    byCustomer.set(row.customerId, set);
  }

  const paired = new Map<string, number>();
  for (const services of byCustomer.values()) {
    if (!services.has(input.lastServiceId)) continue;
    for (const serviceId of services) {
      if (exclude.has(serviceId) || !bookable.has(serviceId)) continue;
      paired.set(serviceId, (paired.get(serviceId) ?? 0) + 1);
    }
  }

  /**
   * Best pairing wins, and ties break towards the same category.
   *
   * Somebody who came in for a cut is in a hair frame of mind; a pedicure that
   * ties with a hair spa on the numbers is the weaker suggestion to put in
   * front of them. The name is the last tiebreak purely so the same input
   * always produces the same output — a suggestion that changes between two
   * runs of the same job is not one anybody can debug.
   */
  const ranked = [...paired.entries()]
    .filter(([, support]) => support >= MIN_SUPPORT)
    .map(([serviceId, support]) => ({ serviceId, support, service: bookable.get(serviceId)! }))
    .sort(
      (a, b) =>
        b.support - a.support ||
        sameCategoryFirst(a.service, b.service, input.lastCategoryId) ||
        a.service.name.localeCompare(b.service.name),
    );

  const best = ranked[0];
  if (best) {
    return { serviceId: best.serviceId, name: best.service.name, support: best.support, basis: 'PAIRED' };
  }

  /**
   * Nothing is paired often enough yet — a new salon, or a quiet service.
   *
   * Rather than say nothing, offer the most-bought OTHER service in the same
   * category. "You had a cut; here is our colour work" is a fair thing to show
   * somebody, and it is honestly labelled SAME_CATEGORY so the salon's screen
   * never claims it is based on their customers' behaviour.
   */
  if (!input.lastCategoryId) return null;

  const popularity = new Map<string, number>();
  for (const services of byCustomer.values()) {
    for (const serviceId of services) popularity.set(serviceId, (popularity.get(serviceId) ?? 0) + 1);
  }

  const sameCategory = [...bookable.values()]
    .filter((service) => service.categoryId === input.lastCategoryId && !exclude.has(service.id))
    .sort(
      (a, b) =>
        (popularity.get(b.id) ?? 0) - (popularity.get(a.id) ?? 0) || a.name.localeCompare(b.name),
    );

  const fallback = sameCategory[0];
  if (!fallback) return null;

  return {
    serviceId: fallback.id,
    name: fallback.name,
    support: popularity.get(fallback.id) ?? 0,
    basis: 'SAME_CATEGORY',
  };
}

function sameCategoryFirst(
  a: CatalogueService,
  b: CatalogueService,
  lastCategoryId: string | null,
): number {
  if (!lastCategoryId) return 0;
  const aSame = a.categoryId === lastCategoryId ? 1 : 0;
  const bSame = b.categoryId === lastCategoryId ? 1 : 0;
  return bSame - aSame;
}
