import type { LinkDestination } from '@prisma/client';

/**
 * CUSTOMER ENGAGEMENT: THE RULES, WITH NO DATABASE IN THEM.
 *
 * Every decision in here is about what the app is allowed to conclude from
 * somebody opening a web page, and each one is quiet when it goes wrong — a
 * click filed under the wrong destination, an interest recorded for a link a
 * customer forwarded to her sister, a page view treated as intent. So they live
 * apart from the queries that use them, under test.
 */

/**
 * WHAT A LINK WAS FOR, FROM ITS ADDRESS.
 *
 * Inferred rather than asked for, because every send path in the app already
 * builds its links and none of them would be changed to pass a label. A message
 * with three buttons — gallery, offer, book — produces three tracked links, and
 * without this the salon learns that one of them was tapped.
 *
 * Ordered from most specific to least. `/book/glow/offer` is a booking page
 * reached from an offer, and it is the BOOKING that matters: the funnel stage
 * after "opened the offer" is "reached the booking page", so filing it as OFFER
 * would lose the step it represents.
 */
export function destinationOf(url: string): LinkDestination {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // Not a URL we can read. OTHER is the honest answer, and it is not a
    // reason to refuse to track the link.
    return 'OTHER';
  }

  /**
   * A WHOLE PATH SEGMENT, not a word anywhere in the path.
   *
   * This was `\b` and a test caught it: `\b` matches before a hyphen, so
   * /blog/gallery-of-mistakes was filed as GALLERY. A blog post about a gallery
   * is not the gallery, and the funnel would have shown people reaching a page
   * they never opened.
   */
  const has = (...words: string[]) =>
    new RegExp(`(?:^|/)(?:${words.join('|')})(?:/|$)`).test(path);

  /**
   * Invoice and feedback first, and separately, because neither is marketing.
   * Opening your own bill is not interest in anything, and counting it as
   * engagement would flatter every campaign that ever attached a receipt.
   */
  if (has('invoice', 'invoices', 'bill', 'bills', 'receipt', 'receipts')) return 'INVOICE';
  if (has('feedback')) return 'FEEDBACK';

  if (has('book', 'booking')) return 'BOOKING';
  if (has('gallery', 'our-work', 'portfolio')) return 'GALLERY';
  if (has('offer', 'offers', 'deal', 'deals', 'promo')) return 'OFFER';
  if (has('service', 'services', 'treatment', 'treatments', 'menu')) return 'SERVICE';
  if (has('branch', 'branches', 'location', 'locations')) return 'BRANCH';

  return 'OTHER';
}

/**
 * HOW LONG A LINK KEEPS SAYING WHO TAPPED IT.
 *
 * Thirty days from the send. Long enough that somebody who reads a message a
 * fortnight late is still counted, short enough that a link forwarded to a
 * friend months later does not file the friend's browsing under the customer's
 * name — and then segment on it.
 *
 * INVOICE links are exempt and get null, which means forever. A customer opens
 * their bill from March in October, and "this link has expired" where somebody's
 * own receipt should be is indefensible. Nothing is being inferred from an
 * invoice view anyway, so there is nothing to misattribute.
 */
export const IDENTIFY_DAYS = 30;

export function identifiesUntil(destination: LinkDestination, sentAt: Date = new Date()): Date | null {
  if (destination === 'INVOICE') return null;
  return new Date(sentAt.getTime() + IDENTIFY_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Whether a tap still counts as this customer's.
 *
 * The redirect happens either way — see the comment on identifiesUntil in the
 * schema. This only decides whether anything is written against their name.
 */
export function stillIdentifies(link: { identifiesUntil: Date | null }, now: Date = new Date()): boolean {
  return link.identifiesUntil === null || link.identifiesUntil.getTime() >= now.getTime();
}

/**
 * The events the website may report, and what each one means for interest.
 *
 * A closed list, because this endpoint is public: an open one is a way to write
 * arbitrary strings into a salon's engagement data from a laptop.
 */
export const TRACKED_EVENTS = [
  'page_view',
  'gallery_filter',
  /** Looked at one service. The only event that records an interest. */
  'service_view',
  'booking_started',
  'booked',
  'feedback_left',
] as const;

export type TrackedEvent = (typeof TRACKED_EVENTS)[number];

export function isTrackedEvent(value: string): value is TrackedEvent {
  return (TRACKED_EVENTS as readonly string[]).includes(value);
}

export interface InterestSignal {
  kind: 'SERVICE' | 'CATEGORY';
  refId: string;
  label: string;
}

/**
 * Whether an event says a customer is interested in something, and in what.
 *
 * DELIBERATELY NARROW. Only a service_view naming a real service counts. A
 * page_view on the gallery says somebody looked at the gallery, which is not
 * interest in anything in particular, and recording it as such would fill the
 * rollup with noise that then drives a campaign.
 *
 * A gallery_filter is the interesting middle case and it is EXCLUDED on
 * purpose: tapping "Colour" to see colour pictures is a hint, but it is one tap
 * on a chip while browsing, and treating it the same as opening a service page
 * means the loudest signal in the table belongs to whoever clicked through all
 * six filters. It stays in the event log, where the salon can see it.
 */
export function interestFrom(
  event: string,
  metadata: Record<string, unknown> | null | undefined,
  resolve: (serviceId: string) => { id: string; name: string; categoryId: string | null; categoryName: string | null } | null,
): InterestSignal[] {
  if (event !== 'service_view') return [];

  const serviceId = typeof metadata?.serviceId === 'string' ? metadata.serviceId : null;
  if (!serviceId) return [];

  /**
   * The service has to exist, in this salon.
   *
   * The id arrives from a public endpoint, so without this anybody could write
   * rows naming services that are not theirs or do not exist — and the rollup
   * would then be joined to nothing when a campaign read it.
   */
  const service = resolve(serviceId);
  if (!service) return [];

  const signals: InterestSignal[] = [{ kind: 'SERVICE', refId: service.id, label: service.name }];

  /**
   * And the category, as its own row.
   *
   * A customer who looked at three colour services has shown interest in
   * colour, and a campaign is almost always about the category while the page
   * was about one service. Rolling up only the service means "who is interested
   * in colour?" needs the caller to know every colour service, every time.
   */
  if (service.categoryId && service.categoryName) {
    signals.push({ kind: 'CATEGORY', refId: service.categoryId, label: service.categoryName });
  }

  return signals;
}

/**
 * Whether an interest is recent enough to act on.
 *
 * Exported so the segment field and any screen that says "interested in" agree
 * on what recent means. A view from eight months ago is not a reason to send
 * anybody anything.
 */
export const INTEREST_STALE_DAYS = 120;

export function interestIsFresh(lastViewedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lastViewedAt.getTime() <= INTEREST_STALE_DAYS * 24 * 60 * 60 * 1000;
}
