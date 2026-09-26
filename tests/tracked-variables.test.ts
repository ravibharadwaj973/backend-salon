import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * THE BUG THAT MADE EVERY WHATSAPP CLICK INVISIBLE.
 *
 * rewriteLinks rewrote the rendered body, and for email or a free-text reply
 * that body IS the message, so tracking worked and looked fine.
 *
 * But an approved WhatsApp template goes to Meta as a template NAME plus
 * parameters, and Meta renders its own stored copy of the wording. The
 * rewritten body is never transmitted. So every marketing and utility message
 * outside the 24-hour window — almost all of them — carried {{booking_link}}
 * exactly as the app built it: untracked.
 *
 * The consequences ran the whole length of the feature. No click was recorded,
 * so the funnel showed nobody ever tapping anything; the arrival token never
 * reached the salon's website, so there were no site visits; and with no site
 * visits there was no recorded interest to segment on. An entire chain, dead at
 * its first link, with the code that was supposed to build it running without
 * error on every single send.
 */

const created: { targetUrl: string; destination: string }[] = [];

vi.mock('../src/core/prisma', () => ({
  prisma: {
    trackedLink: {
      create: ({ data }: { data: { targetUrl: string; destination: string; code: string } }) => {
        created.push({ targetUrl: data.targetUrl, destination: data.destination });
        return Promise.resolve({ ...data, id: `link_${created.length}` });
      },
    },
  },
}));

vi.mock('../src/config/env', () => ({
  // isTest and LOG_LEVEL are here because core/logger reads them at import
  // time; without them the mock takes the logger down and no test runs.
  env: {
    PUBLIC_API_URL: 'https://api.example.com',
    PUBLIC_APP_URL: 'https://app.example.com',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
  isTest: true,
  isProd: false,
  PUBLIC_API_BASE: 'https://api.example.com/api/v1',
}));

const { rewriteVariableLinks, shortUrl } = await import('../src/messaging/tracked-links');

const OWNER = { tenantId: 't1', messageLogId: 'm1', campaignId: null, customerId: 'c1' };

beforeEach(() => {
  created.length = 0;
});

describe('links inside a template’s variables', () => {
  it('rewrites a variable that is a link', async () => {
    const out = await rewriteVariableLinks({ booking_link: 'https://app.example.com/book/glow' }, OWNER);

    expect(out.booking_link).toMatch(/^https:\/\/api\.example\.com\/r\/.{7}$/);
    expect(created).toHaveLength(1);
    expect(created[0]!.targetUrl).toBe('https://app.example.com/book/glow');
    // The destination is read off the URL, so a funnel can tell a booking link
    // from a gallery link in the same message.
    expect(created[0]!.destination).toBe('BOOKING');
  });

  it('leaves variables that are not links completely alone', async () => {
    const out = await rewriteVariableLinks(
      { customer_name: 'Priya', days_since_visit: '42', last_service: 'Hair Spa' },
      OWNER,
    );

    expect(out).toEqual({ customer_name: 'Priya', days_since_visit: '42', last_service: 'Hair Spa' });
    expect(created).toHaveLength(0);
  });

  it('tracks each link in a message separately, so the salon can tell them apart', async () => {
    const out = await rewriteVariableLinks(
      { gallery_link: 'https://glow.in/gallery', booking_link: 'https://app.example.com/book/glow' },
      OWNER,
    );

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.destination).sort()).toEqual(['BOOKING', 'GALLERY']);
    expect(out.gallery_link).not.toBe(out.booking_link);
  });

  it('does not re-track a link that is already tracked', async () => {
    // Double rewriting would bounce the customer through two redirects and
    // count one tap twice.
    const already = shortUrl('abc1234');
    const out = await rewriteVariableLinks({ booking_link: already }, OWNER);

    expect(out.booking_link).toBe(already);
    expect(created).toHaveLength(0);
  });

  it('handles a variable holding a sentence with a link in it', async () => {
    const out = await rewriteVariableLinks({ offer: 'Book at https://glow.in/offers/diwali before Friday' }, OWNER);

    expect(out.offer).toContain('Book at https://api.example.com/r/');
    expect(out.offer).toContain('before Friday');
    expect(created[0]!.destination).toBe('OFFER');
  });

  it('sends the ORIGINAL values when anything goes wrong, never a half-rewritten set', async () => {
    /**
     * A partially rewritten map would give some recipients of one campaign a
     * tracked link and others the raw one. The click rate would then be a
     * fraction of an unknown denominator, and nothing anywhere would say so —
     * which is worse than tracking none of it.
     */
    const { prisma } = (await import('../src/core/prisma')) as unknown as {
      prisma: { trackedLink: { create: unknown } };
    };
    const original = prisma.trackedLink.create;
    prisma.trackedLink.create = () => Promise.reject(new Error('database is having a moment'));

    const input = { gallery_link: 'https://glow.in/gallery', booking_link: 'https://glow.in/book' };
    const out = await rewriteVariableLinks(input, OWNER);

    expect(out).toEqual(input);
    prisma.trackedLink.create = original;
  });
});
