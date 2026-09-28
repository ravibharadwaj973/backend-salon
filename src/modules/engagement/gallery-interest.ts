/**
 * WHAT THE SALON'S WORK IS ACTUALLY BEING LOOKED AT.
 *
 * The customer screen already answers "what did Priya look at". This answers
 * the other half: of everybody who opened the gallery this month, what did
 * they look at — which section, which service, and how many different people.
 *
 * It is the number that tells a salon what to photograph next. A salon whose
 * bridal section is opened by forty people a month and whose nails section is
 * opened by four has just been told where to point the camera, and no amount
 * of per-customer detail says that.
 *
 * Pure. The rows come from SiteVisit; the counting is tested without a
 * database.
 */

export interface VisitRow {
  event: string;
  label: string | null;
  metadata: unknown;
  customerId: string | null;
  sessionId: string | null;
}

export interface InterestRow {
  /** The collection key or the service id. */
  key: string;
  /** What to print — the salon's own name for it. */
  label: string;
  /** Every time it was opened, including the same person twice. */
  views: number;
  /**
   * How many different people, as far as this can honestly tell.
   *
   * A customer who arrived from a message is known by id. Everybody else is
   * counted by their browser tab, which means one person who opens the gallery
   * on Monday and again on Friday counts twice, and the same person on a phone
   * and a laptop counts twice. It is a floor on views and a ceiling on people,
   * and it is labelled "people" rather than "visitors" nowhere in the UI
   * without that caveat beside it.
   */
  people: number;
  /** Of those, how many the salon can put a name to. */
  customers: number;
}

export interface InterestRollup {
  collections: InterestRow[];
  services: InterestRow[];
  /** Distinct people across everything, not the sum of the rows above. */
  totalPeople: number;
  totalViews: number;
}

interface Bucket {
  label: string;
  views: number;
  people: Set<string>;
  customers: Set<string>;
}

/**
 * "Everything" is not a category.
 *
 * The chip that clears the filter reports itself like any other, and counting
 * it would put a row at the top of every salon's table that tells them
 * nothing: of course the most-opened section is all of them.
 */
const NOT_A_COLLECTION = new Set(['all', '']);

export function rollUpInterest(rows: readonly VisitRow[]): InterestRollup {
  const collections = new Map<string, Bucket>();
  const services = new Map<string, Bucket>();
  const everyone = new Set<string>();
  let totalViews = 0;

  for (const row of rows) {
    const meta = (typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {}) as Record<
      string,
      unknown
    >;

    let bucket: Map<string, Bucket> | null = null;
    let key: string | null = null;

    if (row.event === 'gallery_filter') {
      const collection = typeof meta.collection === 'string' ? meta.collection : '';
      if (NOT_A_COLLECTION.has(collection)) continue;
      bucket = collections;
      key = collection;
    } else if (row.event === 'service_view') {
      const serviceId = typeof meta.serviceId === 'string' ? meta.serviceId : '';
      if (!serviceId) continue;
      bucket = services;
      key = serviceId;
    } else {
      continue;
    }

    /**
     * Who this was, as well as it can be known.
     *
     * A known customer counts as themselves across tabs and days. Everybody
     * else is their tab. Somebody with neither — an event that arrived without
     * a session, which should not happen but does — is counted as a view and
     * not as a person, because inventing an identity to make a number bigger
     * is how a report stops being evidence.
     */
    const who = row.customerId ? `c:${row.customerId}` : row.sessionId ? `s:${row.sessionId}` : null;

    const existing = bucket.get(key) ?? {
      label: row.label?.trim() || key,
      views: 0,
      people: new Set<string>(),
      customers: new Set<string>(),
    };

    existing.views += 1;
    if (who) {
      existing.people.add(who);
      everyone.add(who);
    }
    if (row.customerId) existing.customers.add(row.customerId);

    // A later row's label wins only when the earlier one fell back to the key,
    // so a renamed category shows its current name rather than an id.
    if (existing.label === key && row.label?.trim()) existing.label = row.label.trim();

    bucket.set(key, existing);
    totalViews += 1;
  }

  return {
    collections: toRows(collections),
    services: toRows(services),
    totalPeople: everyone.size,
    totalViews,
  };
}

function toRows(buckets: Map<string, Bucket>): InterestRow[] {
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      views: bucket.views,
      people: bucket.people.size,
      customers: bucket.customers.size,
    }))
    /**
     * Most-looked-at first, and ties broken by how many different people
     * rather than alphabetically: forty views from forty people is a bigger
     * fact than forty views from three.
     */
    .sort((a, b) => b.views - a.views || b.people - a.people || a.label.localeCompare(b.label));
}
