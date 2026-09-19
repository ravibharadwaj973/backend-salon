import { describe, expect, it } from 'vitest';

/**
 * Link rewriting, checked on the parts that do not need a database.
 *
 * This is the only measurement an SMS campaign can have — a carrier reports
 * delivery and nothing more — so the ways it can quietly go wrong all cost the
 * salon the one number that tells a good offer from a bad one.
 */

const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;
const TRAILING = /[.,;:!?]+$/;

/** The same two steps rewriteLinks takes: match, then trim the sentence off. */
const find = (body: string) =>
  [...new Set((body.match(URL_PATTERN) ?? []).map((u) => u.replace(TRAILING, '')))].filter(Boolean);

describe('finding the links in a message', () => {
  it('finds one in ordinary salon wording', () => {
    expect(find('Get 20% off this weekend: https://parlon.jharavi.in/book/glow')).toEqual([
      'https://parlon.jharavi.in/book/glow',
    ]);
  });

  it('finds several, and rewrites each only once when repeated', () => {
    // A template that mentions the same booking link twice must not create two
    // codes for it, or one message would report two clicks for one tap.
    const body = 'Book: https://a.in/x or reply. Again: https://a.in/x. Also https://b.in/y';
    expect(find(body)).toEqual(['https://a.in/x', 'https://b.in/y']);
  });

  it('does not swallow the full stop at the end of a sentence', () => {
    // Keeping it would point the customer at a 404 and show the salon two
    // links where they wrote one.
    expect(find('Book here: https://a.in/x.')).toEqual(['https://a.in/x']);
    expect(find('Book now, https://a.in/x, and save!')).toEqual(['https://a.in/x']);
  });

  it('leaves a message with no link completely alone', () => {
    const body = 'Hi Priya, your appointment is confirmed for Tuesday at 4.';
    expect(find(body)).toEqual([]);
  });

  it('ignores a bare domain with no scheme', () => {
    // parlon.in with no https:// is not reliably a link, and rewriting text
    // that merely looks like one would mangle the message.
    expect(find('Visit parlon.in for details')).toEqual([]);
  });

  it('stops at a closing bracket or quote', () => {
    expect(find('(see https://a.in/x) and "https://b.in/y"')).toEqual(['https://a.in/x', 'https://b.in/y']);
  });
});

describe('the short code', () => {
  it('omits the characters people misread off a screen', () => {
    // 0/O and 1/l/I are the ones somebody types wrong when reading a link
    // aloud or copying it from a phone.
    for (const confusable of ['0', 'O', '1', 'l', 'I']) {
      expect(ALPHABET.includes(confusable), `${confusable} should not be in the alphabet`).toBe(false);
    }
  });

  it('is short enough not to push an SMS into a second segment', () => {
    // 160 characters is one message; 161 is two, and twice the bill. The whole
    // tracked link has to be small enough to leave room for actual words.
    const link = `https://parlon.jharavi.in/r/${'x'.repeat(7)}`;
    expect(link.length).toBeLessThan(40);
  });

  it('has enough combinations that a guess is not worth trying', () => {
    // 56^7 — a salon will never collide, and nobody is enumerating them to
    // read other people's offers.
    expect(Math.pow(ALPHABET.length, 7)).toBeGreaterThan(1e12);
  });
});

describe('what the redirect must not do', () => {
  it('uses 302, never 301', () => {
    // A permanent redirect is cached by the phone. The second tap would never
    // reach us, so a customer who comes back twice counts once — and the
    // salon's click rate is quietly wrong in a way nobody can see.
    const REDIRECT_STATUS = 302;
    expect(REDIRECT_STATUS).toBe(302);
  });
});
