import { describe, expect, it } from 'vitest';
import { type VisitRow, rollUpInterest } from '../src/modules/engagement/gallery-interest';

function filter(collection: string, label: string, who: Partial<VisitRow> = {}): VisitRow {
  return {
    event: 'gallery_filter',
    label,
    metadata: { collection },
    customerId: null,
    sessionId: 'tab1',
    ...who,
  };
}

function view(serviceId: string, label: string, who: Partial<VisitRow> = {}): VisitRow {
  return {
    event: 'service_view',
    label,
    metadata: { serviceId },
    customerId: null,
    sessionId: 'tab1',
    ...who,
  };
}

describe('what the gallery is being looked at for', () => {
  it('counts views and separates collections from services', () => {
    const out = rollUpInterest([
      filter('cat_hair', 'Hair', { sessionId: 'a' }),
      filter('cat_hair', 'Hair', { sessionId: 'b' }),
      filter('cat_nails', 'Nails', { sessionId: 'a' }),
      view('svc_spa', 'Hair Spa', { sessionId: 'a' }),
    ]);

    expect(out.collections.map((r) => [r.label, r.views, r.people])).toEqual([
      ['Hair', 2, 2],
      ['Nails', 1, 1],
    ]);
    expect(out.services.map((r) => [r.label, r.views])).toEqual([['Hair Spa', 1]]);
  });

  it('ignores the chip that clears the filter', () => {
    // "Everything" would otherwise sit at the top of every salon's table
    // saying that the most popular section is all of them.
    const out = rollUpInterest([filter('all', 'Everything'), filter('cat_hair', 'Hair')]);
    expect(out.collections.map((r) => r.key)).toEqual(['cat_hair']);
  });

  it('counts a known customer once across tabs and days', () => {
    // Somebody who opens the message on their phone and again on a laptop is
    // one interested person, not two.
    const out = rollUpInterest([
      filter('cat_hair', 'Hair', { customerId: 'cus1', sessionId: 'phone' }),
      filter('cat_hair', 'Hair', { customerId: 'cus1', sessionId: 'laptop' }),
    ]);

    expect(out.collections[0]).toMatchObject({ views: 2, people: 1, customers: 1 });
  });

  it('counts an anonymous visitor by tab, and says how many were named', () => {
    const out = rollUpInterest([
      filter('cat_hair', 'Hair', { sessionId: 'x' }),
      filter('cat_hair', 'Hair', { sessionId: 'y' }),
      filter('cat_hair', 'Hair', { customerId: 'cus1', sessionId: 'z' }),
    ]);

    expect(out.collections[0]).toMatchObject({ views: 3, people: 3, customers: 1 });
  });

  it('counts a row with nobody attached as a view but not as a person', () => {
    // Inventing an identity to make a number bigger is how a report stops
    // being evidence.
    const out = rollUpInterest([filter('cat_hair', 'Hair', { sessionId: null, customerId: null })]);
    expect(out.collections[0]).toMatchObject({ views: 1, people: 0 });
  });

  it('does not add up the rows to get the total', () => {
    // One person who looked at Hair and Nails is one person, not two. A total
    // taken by summing the column would overstate reach on every report.
    const out = rollUpInterest([
      filter('cat_hair', 'Hair', { sessionId: 'a' }),
      filter('cat_nails', 'Nails', { sessionId: 'a' }),
    ]);

    expect(out.collections[0]?.people).toBe(1);
    expect(out.collections[1]?.people).toBe(1);
    expect(out.totalPeople).toBe(1);
    expect(out.totalViews).toBe(2);
  });

  it('sorts by views, breaking ties on how many different people', () => {
    // Four views from four people is a bigger fact than four from one.
    const out = rollUpInterest([
      ...['a', 'b', 'c', 'd'].map((s) => filter('cat_hair', 'Hair', { sessionId: s })),
      ...['z', 'z', 'z', 'z'].map((s) => filter('cat_nails', 'Nails', { sessionId: s })),
    ]);

    expect(out.collections.map((r) => r.label)).toEqual(['Hair', 'Nails']);
  });

  it('survives rows that are not what they claim', () => {
    // These arrive from a public endpoint on a website. Nothing here is
    // trusted to be the shape it should be.
    const out = rollUpInterest([
      { event: 'gallery_filter', label: null, metadata: null, customerId: null, sessionId: 'a' },
      { event: 'gallery_filter', label: null, metadata: 'nope', customerId: null, sessionId: 'a' },
      { event: 'service_view', label: null, metadata: { serviceId: 42 }, customerId: null, sessionId: 'a' },
      { event: 'page_view', label: 'Home', metadata: {}, customerId: null, sessionId: 'a' },
      { event: 'booked', label: null, metadata: {}, customerId: 'c', sessionId: 'a' },
    ]);

    expect(out.collections).toEqual([]);
    expect(out.services).toEqual([]);
    expect(out.totalViews).toBe(0);
  });

  it('falls back to the key when no label was sent, then upgrades it', () => {
    // A renamed category should print its current name rather than an id.
    const out = rollUpInterest([
      filter('cat_hair', '', { sessionId: 'a' }),
      filter('cat_hair', 'Hair & Styling', { sessionId: 'b' }),
    ]);

    expect(out.collections[0]?.label).toBe('Hair & Styling');
  });

  it('returns empty totals for no rows at all', () => {
    expect(rollUpInterest([])).toEqual({ collections: [], services: [], totalPeople: 0, totalViews: 0 });
  });
});
