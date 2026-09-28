import { describe, expect, it } from 'vitest';
import {
  MIN_SUPPORT,
  type CatalogueService,
  type PurchaseRow,
  suggestNextService,
} from '../src/modules/marketing/next-service';

const HAIR = 'cat_hair';
const NAILS = 'cat_nails';

const CATALOGUE: CatalogueService[] = [
  { id: 'cut', name: 'Haircut (Women)', categoryId: HAIR, isActive: true },
  { id: 'spa', name: 'Hair Spa', categoryId: HAIR, isActive: true },
  { id: 'colour', name: 'Hair Colour', categoryId: HAIR, isActive: true },
  { id: 'pedicure', name: 'Pedicure', categoryId: NAILS, isActive: true },
  { id: 'retired', name: 'Thermal Reconditioning', categoryId: HAIR, isActive: false },
];

/** n customers who each bought all of `services`. */
function customers(n: number, services: string[], prefix = 'c'): PurchaseRow[] {
  return Array.from({ length: n }).flatMap((_, index) =>
    services.map((serviceId) => ({ customerId: `${prefix}${index}`, serviceId })),
  );
}

describe('what to suggest after a service', () => {
  it('suggests what this salon’s customers actually pair with it', () => {
    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: customers(5, ['cut', 'spa']),
      catalogue: CATALOGUE,
    });

    expect(result).toEqual({ serviceId: 'spa', name: 'Hair Spa', support: 5, basis: 'PAIRED' });
  });

  it('will not call a coincidence a pattern', () => {
    /**
     * Two customers who both had a cut and a pedicure is an accident. Sent as
     * "people who have a cut here usually have a pedicure" it is an accident
     * dressed as a fact, signed by the salon. Below the threshold it falls
     * back to the category instead of asserting something it cannot support.
     */
    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: customers(MIN_SUPPORT - 1, ['cut', 'pedicure']),
      catalogue: CATALOGUE,
    });

    expect(result?.basis).toBe('SAME_CATEGORY');
    expect(result?.serviceId).not.toBe('pedicure');
  });

  it('counts each customer once, however often they come', () => {
    // One regular booking the same pair fifteen times is one piece of
    // evidence, not fifteen — otherwise the salon's most frequent customer
    // decides what everybody else is shown.
    const oneRegular: PurchaseRow[] = Array.from({ length: 15 }).flatMap(() => [
      { customerId: 'loyal', serviceId: 'cut' },
      { customerId: 'loyal', serviceId: 'pedicure' },
    ]);

    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: oneRegular,
      catalogue: CATALOGUE,
    });

    expect(result?.basis).toBe('SAME_CATEGORY');
  });

  it('never suggests something they already buy', () => {
    // Showing a colour customer the colour work tells them nothing they do not
    // know, and spends the one message they will open on it.
    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut', 'spa'],
      history: customers(6, ['cut', 'spa']),
      catalogue: CATALOGUE,
    });

    expect(result?.serviceId).not.toBe('spa');
  });

  it('never suggests a retired service', () => {
    // It cannot be booked. A message inviting somebody to book it is a message
    // that ends at the counter with an apology.
    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: customers(9, ['cut', 'retired']),
      catalogue: CATALOGUE,
    });

    expect(result?.serviceId).not.toBe('retired');
  });

  it('prefers the same category when the numbers tie', () => {
    // Somebody who came in for a cut is in a hair frame of mind. A pedicure
    // level with a hair spa on the count is the weaker thing to put in front
    // of them.
    const history = [...customers(4, ['cut', 'spa'], 'a'), ...customers(4, ['cut', 'pedicure'], 'b')];

    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history,
      catalogue: CATALOGUE,
    });

    expect(result?.serviceId).toBe('spa');
  });

  it('still suggests across categories when the evidence is clearly there', () => {
    // The point of counting rather than hardcoding: if this salon's cut
    // customers really do book pedicures, that is what they are shown.
    const history = [...customers(8, ['cut', 'pedicure'], 'a'), ...customers(3, ['cut', 'spa'], 'b')];

    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history,
      catalogue: CATALOGUE,
    });

    expect(result).toMatchObject({ serviceId: 'pedicure', basis: 'PAIRED' });
  });

  it('falls back to the most popular other service in the category', () => {
    // A new salon with no pairs yet. "You had a cut, here is our colour work"
    // is still a fair thing to show somebody — labelled so the salon's screen
    // never claims it came from their customers' behaviour.
    const result = suggestNextService({
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: [
        { customerId: 'x', serviceId: 'colour' },
        { customerId: 'y', serviceId: 'colour' },
        { customerId: 'z', serviceId: 'spa' },
      ],
      catalogue: CATALOGUE,
    });

    expect(result).toMatchObject({ serviceId: 'colour', basis: 'SAME_CATEGORY' });
  });

  it('says nothing rather than something useless', () => {
    // No history, no other service in the category, or no category at all.
    // The caller sends the plain gallery link, which is honest.
    expect(
      suggestNextService({
        lastServiceId: 'pedicure',
        lastCategoryId: NAILS,
        alreadyHad: ['pedicure'],
        history: [],
        catalogue: CATALOGUE,
      }),
    ).toBeNull();

    expect(
      suggestNextService({
        lastServiceId: 'cut',
        lastCategoryId: null,
        alreadyHad: ['cut'],
        history: [],
        catalogue: CATALOGUE,
      }),
    ).toBeNull();
  });

  it('gives the same answer twice for the same input', () => {
    // A suggestion that changes between two runs of the same job is one
    // nobody can debug when a salon asks why a customer got that message.
    const args = {
      lastServiceId: 'cut',
      lastCategoryId: HAIR,
      alreadyHad: ['cut'],
      history: [...customers(4, ['cut', 'spa'], 'a'), ...customers(4, ['cut', 'colour'], 'b')],
      catalogue: CATALOGUE,
    };

    expect(suggestNextService(args)).toEqual(suggestNextService(args));
  });
});
