import { describe, expect, it } from 'vitest';
import {
  IDENTIFY_DAYS,
  destinationOf,
  identifiesUntil,
  interestFrom,
  interestIsFresh,
  isTrackedEvent,
  stillIdentifies,
} from '../src/modules/engagement/engagement';

/**
 * WHAT THE APP IS ALLOWED TO CONCLUDE FROM SOMEBODY OPENING A PAGE.
 *
 * Every rule here fails quietly. A click filed under the wrong destination
 * makes a funnel stage lie. An interest recorded from a forwarded link puts one
 * customer's browsing on another customer's record. A page view treated as
 * intent drives a campaign at somebody who glanced at something. None of them
 * throw, and all of them end up in a message a real person receives.
 */

describe('what a link was for', () => {
  it('reads the destination off the address', () => {
    expect(destinationOf('https://glowstudio.in/gallery')).toBe('GALLERY');
    expect(destinationOf('https://glowstudio.in/offers/diwali')).toBe('OFFER');
    expect(destinationOf('https://glowstudio.in/services/hair-spa')).toBe('SERVICE');
    expect(destinationOf('https://glowstudio.in/branches/indiranagar')).toBe('BRANCH');
    expect(destinationOf('https://app.parlon.in/book/glow')).toBe('BOOKING');
  });

  it('treats a booking page reached from an offer as a booking page', () => {
    /**
     * The stage after "opened the offer" is "reached the booking page". Filing
     * this as OFFER would lose exactly the step it represents, and the funnel
     * would show people opening the offer and never reaching booking — when
     * they did.
     */
    expect(destinationOf('https://app.parlon.in/book/glow?offer=diwali')).toBe('BOOKING');
    expect(destinationOf('https://app.parlon.in/book/glow/offer')).toBe('BOOKING');
  });

  it('keeps invoices and feedback out of the marketing destinations', () => {
    // Opening your own bill is not interest in anything. Counted as
    // engagement, it would flatter every campaign that attached a receipt.
    expect(destinationOf('https://app.parlon.in/invoice/abc123')).toBe('INVOICE');
    expect(destinationOf('https://app.parlon.in/feedback/appt-1')).toBe('FEEDBACK');
    expect(destinationOf('https://app.parlon.in/feedback/appt-1/google')).toBe('FEEDBACK');
  });

  it('says OTHER rather than guessing, and never throws on rubbish', () => {
    expect(destinationOf('https://glowstudio.in/about')).toBe('OTHER');
    expect(destinationOf('https://glowstudio.in/')).toBe('OTHER');
    // An unparseable link is still a link worth tracking; it just has no
    // destination anybody can name.
    expect(destinationOf('not a url at all')).toBe('OTHER');
    expect(destinationOf('')).toBe('OTHER');
  });

  it('is not fooled by the word appearing somewhere else in the path', () => {
    // A blog post about a gallery is not the gallery.
    expect(destinationOf('https://glowstudio.in/blog/gallery-of-mistakes')).toBe('OTHER');
  });
});

describe('how long a link keeps saying who tapped it', () => {
  const sent = new Date('2026-03-01T10:00:00Z');

  it('identifies for a month, so a message read late still counts', () => {
    const until = identifiesUntil('GALLERY', sent)!;
    expect(Math.round((until.getTime() - sent.getTime()) / 86_400_000)).toBe(IDENTIFY_DAYS);
  });

  it('stops crediting the customer once the window has passed', () => {
    /**
     * The failure this prevents: Priya forwards the gallery link to her sister
     * in June. Without a window, the sister's browsing is recorded as Priya's
     * interest, and the next campaign is aimed at Priya on the strength of it.
     */
    const link = { identifiesUntil: identifiesUntil('GALLERY', sent) };
    expect(stillIdentifies(link, new Date('2026-03-20T10:00:00Z'))).toBe(true);
    expect(stillIdentifies(link, new Date('2026-06-01T10:00:00Z'))).toBe(false);
  });

  it('never expires an invoice link', () => {
    // A customer opens their March bill in October. "This link has expired"
    // where their own receipt should be is indefensible — and nothing is
    // inferred from an invoice view, so there is nothing to misattribute.
    expect(identifiesUntil('INVOICE', sent)).toBeNull();
    expect(stillIdentifies({ identifiesUntil: null }, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('which events the public endpoint accepts', () => {
  it('takes the ones the website sends', () => {
    expect(isTrackedEvent('service_view')).toBe(true);
    expect(isTrackedEvent('booked')).toBe(true);
  });

  it('refuses anything else, because the endpoint is public', () => {
    // An open list is a way to write arbitrary strings into a salon's
    // engagement data from a laptop.
    expect(isTrackedEvent('admin')).toBe(false);
    expect(isTrackedEvent('')).toBe(false);
    expect(isTrackedEvent('page_view; DROP TABLE')).toBe(false);
  });
});

describe('when a page view becomes a recorded interest', () => {
  const SERVICES: Record<string, { id: string; name: string; categoryId: string | null; categoryName: string | null }> = {
    'svc-spa': { id: 'svc-spa', name: 'Hair Spa', categoryId: 'cat-hair', categoryName: 'Hair' },
    'svc-thread': { id: 'svc-thread', name: 'Threading', categoryId: null, categoryName: null },
  };
  const resolve = (id: string) => SERVICES[id] ?? null;

  it('records the service and its category', () => {
    const signals = interestFrom('service_view', { serviceId: 'svc-spa' }, resolve);
    expect(signals).toEqual([
      { kind: 'SERVICE', refId: 'svc-spa', label: 'Hair Spa' },
      { kind: 'CATEGORY', refId: 'cat-hair', label: 'Hair' },
    ]);
  });

  it('records the service alone when it has no category', () => {
    expect(interestFrom('service_view', { serviceId: 'svc-thread' }, resolve)).toEqual([
      { kind: 'SERVICE', refId: 'svc-thread', label: 'Threading' },
    ]);
  });

  it('records nothing for a service this salon does not have', () => {
    // The id comes from a public endpoint. Without this check anybody could
    // write rows naming services that do not exist, and the rollup would be
    // joined to nothing the moment a campaign read it.
    expect(interestFrom('service_view', { serviceId: 'svc-someone-elses' }, resolve)).toEqual([]);
    expect(interestFrom('service_view', { serviceId: 42 }, resolve)).toEqual([]);
    expect(interestFrom('service_view', null, resolve)).toEqual([]);
  });

  it('records nothing for merely opening the gallery', () => {
    // Somebody looked at the gallery. That is not interest in anything in
    // particular, and recording it as such fills the rollup with noise that
    // then drives a campaign.
    expect(interestFrom('page_view', { serviceId: 'svc-spa' }, resolve)).toEqual([]);
  });

  it('records nothing for tapping a filter chip', () => {
    /**
     * The interesting middle case, excluded on purpose. Tapping "Colour" to see
     * colour pictures is a hint — but it is one tap while browsing, and if it
     * counted the same as opening a service page, the strongest signal in the
     * table would belong to whoever clicked through all six filters. It stays
     * in the event log where the salon can see it.
     */
    expect(interestFrom('gallery_filter', { collection: 'colour' }, resolve)).toEqual([]);
  });
});

describe('when an interest is too old to act on', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('counts a recent view', () => {
    expect(interestIsFresh(new Date('2026-09-01T00:00:00Z'), now)).toBe(true);
  });

  it('does not count one from last year', () => {
    // A page opened eight months ago is not a reason to send anybody anything.
    expect(interestIsFresh(new Date('2025-11-01T00:00:00Z'), now)).toBe(false);
  });
});
