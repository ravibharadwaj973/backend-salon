import { describe, expect, it } from 'vitest';
import { withVisitToken } from '../src/messaging/tracked-links';

/**
 * THE TOKEN THAT MUST NOT LEAVE THE SALON'S OWN HOSTS.
 *
 * The redirect knows which message a tap came from, and passing that code on
 * to the destination is what lets the salon's website report back what the
 * visitor did next. It is also, by construction, a per-person identifier.
 *
 * A salon's messages contain links to Google reviews, to Instagram, to a map.
 * Appending the token to those hands a third party an identifier for one named
 * customer, for no benefit whatsoever — the kind of leak that is one line to
 * write, invisible afterwards, and impossible to take back once it is in
 * somebody else's logs.
 */

const SITE = 'https://glowstudio.in';
const APP = 'https://app.parlon.in';

describe('the arrival token goes on the salon’s own pages and nowhere else', () => {
  it('adds it to the salon’s own website', () => {
    expect(withVisitToken(`${SITE}/gallery`, 'Tb7nkMy', [SITE, APP])).toBe(`${SITE}/gallery?pv=Tb7nkMy`);
  });

  it('adds it to the booking app', () => {
    expect(withVisitToken(`${APP}/book/glow`, 'Tb7nkMy', [SITE, APP])).toBe(`${APP}/book/glow?pv=Tb7nkMy`);
  });

  it('never adds it to somebody else’s host', () => {
    const google = 'https://g.page/r/abc/review';
    expect(withVisitToken(google, 'Tb7nkMy', [SITE, APP])).toBe(google);

    const insta = 'https://instagram.com/glowstudio';
    expect(withVisitToken(insta, 'Tb7nkMy', [SITE, APP])).toBe(insta);
  });

  it('is not fooled by a host that merely starts the same way', () => {
    // glowstudio.in.evil.example is not glowstudio.in. A startsWith check on
    // the URL would have handed the token over.
    const lookalike = 'https://glowstudio.in.evil.example/gallery';
    expect(withVisitToken(lookalike, 'Tb7nkMy', [SITE])).toBe(lookalike);
  });

  it('treats a different port or scheme as a different host', () => {
    expect(withVisitToken('http://glowstudio.in/gallery', 'x', [SITE])).toBe('http://glowstudio.in/gallery');
  });

  it('keeps the query string that was already there', () => {
    const url = withVisitToken(`${SITE}/gallery?service=colour`, 'Tb7nkMy', [SITE]);
    expect(url).toContain('service=colour');
    expect(url).toContain('pv=Tb7nkMy');
  });

  it('leaves a link that already carries a token alone', () => {
    // A link the salon built by hand with its own pv means something by it.
    const url = `${SITE}/gallery?pv=hand-made`;
    expect(withVisitToken(url, 'Tb7nkMy', [SITE])).toBe(url);
  });

  it('hands back anything it cannot parse, untouched', () => {
    // Tracking is a nice-to-have. The link working is not.
    expect(withVisitToken('not a url', 'x', [SITE])).toBe('not a url');
    expect(withVisitToken(`${SITE}/gallery`, 'x', ['also not a url'])).toBe(`${SITE}/gallery`);
    expect(withVisitToken(`${SITE}/gallery`, 'x', [null, undefined])).toBe(`${SITE}/gallery`);
  });
});
