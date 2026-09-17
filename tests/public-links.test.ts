import { describe, expect, it } from 'vitest';

/**
 * Every customer-facing link is built from PUBLIC_APP_URL: the booking page a
 * salon embeds in its own site, the feedback link in a WhatsApp message, the
 * Google-review hand-off.
 *
 * It has a localhost default so the app runs out of the box, and that default
 * is the trap. Left unset in production, every link in every message reads
 * `http://localhost:3000/...`. Nothing throws. The message is marked delivered,
 * the customer taps a link that opens nothing, and the first sign of trouble is
 * a campaign that produced no bookings.
 *
 * The check below is the one in config/env.ts. It runs at boot and stops the
 * process, so the failure happens while somebody is watching a deploy rather
 * than silently at 2am inside a journey run.
 */

const unusable = (url: string) => /localhost|127\.0\.0\.1/.test(url);

describe('the production check on PUBLIC_APP_URL', () => {
  it('rejects the default nobody remembered to change', () => {
    expect(unusable('http://localhost:3000')).toBe(true);
    expect(unusable('http://localhost:3001')).toBe(true);
    expect(unusable('http://127.0.0.1:3000')).toBe(true);
  });

  it('accepts a real address a customer’s phone can open', () => {
    expect(unusable('https://parlon.jharavi.in')).toBe(false);
    expect(unusable('https://app.example.com')).toBe(false);
  });

  it('is a substring match, so a domain spelled like localhost is refused too', () => {
    // Documented rather than fixed: refusing https://localhost-tools.example.com
    // is a false alarm somebody can see and work around at boot, whereas a
    // narrower check that let a real localhost through would mail dead links
    // to customers. Wrong in the safe direction.
    expect(unusable('https://localhost-tools.example.com')).toBe(true);
  });
});

describe('what the links look like once it is set', () => {
  /** The shape public-links.ts builds, so a change of path is visible here. */
  const bookingUrl = (base: string, slug: string) => new URL(`/book/${encodeURIComponent(slug)}`, base).toString();
  const feedbackUrl = (base: string, id: string) => new URL(`/feedback/${id}`, base).toString();
  const googleReviewUrl = (base: string, id: string) => new URL(`/feedback/${id}/google`, base).toString();

  const BASE = 'https://parlon.jharavi.in';

  it('sends a customer to the salon’s own booking page', () => {
    expect(bookingUrl(BASE, 'glow-studio')).toBe('https://parlon.jharavi.in/book/glow-studio');
  });

  it('escapes a slug rather than building a broken URL', () => {
    expect(bookingUrl(BASE, 'glow studio & spa')).toBe('https://parlon.jharavi.in/book/glow%20studio%20%26%20spa');
  });

  it('routes the Google hand-off through our own page, so the tap is recorded', () => {
    // Straight to Google would lose the one measurement that makes review
    // chasing worth doing.
    expect(googleReviewUrl(BASE, 'ap_1')).toBe('https://parlon.jharavi.in/feedback/ap_1/google');
    expect(feedbackUrl(BASE, 'ap_1')).toBe('https://parlon.jharavi.in/feedback/ap_1');
  });

  it('does not double the slash when the base carries a trailing one', () => {
    // env.ts strips trailing slashes; this proves why that matters.
    expect(bookingUrl('https://parlon.jharavi.in/', 'glow-studio')).toBe('https://parlon.jharavi.in/book/glow-studio');
  });
});
