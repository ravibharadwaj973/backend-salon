import { describe, expect, it } from 'vitest';
import { explainAll, explainUnresolved } from '../src/modules/messaging/unresolved-reasons';

const NOTHING = { hasCustomer: false, hasWebsite: false, hasCompletedVisit: false };
const EVERYTHING = { hasCustomer: true, hasWebsite: true, hasCompletedVisit: true };

describe('why an automatic variable is empty', () => {
  it('blames the missing customer first, because it is checked first', () => {
    /**
     * The order is the whole point. With no customer chosen AND no website
     * set, both are true — and sending somebody to Settings to fix a website
     * address when the real problem is that they have not picked a recipient
     * wastes their time and their trust in the hint.
     */
    expect(explainUnresolved('explore_link', NOTHING)).toMatch(/Choose who this is going to/);
  });

  it('names the website setting once a customer is chosen', () => {
    expect(
      explainUnresolved('explore_link', { ...NOTHING, hasCustomer: true }),
    ).toMatch(/Settings → Your website/);
  });

  it('names the missing visit once the website is set', () => {
    expect(
      explainUnresolved('suggested_service', { hasCustomer: true, hasWebsite: true, hasCompletedVisit: false }),
    ).toMatch(/no completed visit/);
  });

  it('admits there is simply nothing to suggest when everything is in place', () => {
    // The honest last case: a salon with one service in that category, or a
    // pairing no three customers have shown. Not a fault to go and fix.
    expect(explainUnresolved('suggested_service', EVERYTHING)).toMatch(/No suggestion yet/);
  });

  it('gives both halves of the suggestion the same answer', () => {
    // They are set together or not at all, so two different explanations for
    // one cause would read as two different problems.
    for (const facts of [NOTHING, { ...NOTHING, hasCustomer: true }, EVERYTHING]) {
      expect(explainUnresolved('explore_link', facts)).toBe(explainUnresolved('suggested_service', facts));
    }
  });

  it('explains the gallery link only when the address is actually missing', () => {
    expect(explainUnresolved('gallery_link', NOTHING)).toMatch(/Settings → Your website/);
    expect(explainUnresolved('gallery_link', EVERYTHING)).toBeUndefined();
  });

  it('explains a visit link by the visit', () => {
    expect(explainUnresolved('feedback_link', { ...EVERYTHING, hasCompletedVisit: false })).toMatch(
      /no completed appointment/,
    );
    expect(explainUnresolved('google_review_link', NOTHING)).toMatch(/Choose a customer/);
  });

  it('says nothing about a box the salon was always meant to fill', () => {
    // A hint under every box trains people to stop reading the hints.
    expect(explainUnresolved('offer_details', NOTHING)).toBeUndefined();
    expect(explainUnresolved('tip', NOTHING)).toBeUndefined();
    expect(explainUnresolved('unmapped_1', NOTHING)).toBeUndefined();
  });

  it('returns only the variables it has something to say about', () => {
    const out = explainAll(['explore_link', 'offer_details', 'gallery_link'], EVERYTHING);
    expect(Object.keys(out)).toEqual(['explore_link']);
  });

  it('returns nothing for an empty list', () => {
    expect(explainAll([], NOTHING)).toEqual({});
  });
});
