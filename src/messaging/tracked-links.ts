import crypto from 'node:crypto';
import { prisma } from '../core/prisma';
import { env } from '../config/env';
import { logger } from '../core/logger';

/**
 * COUNTING THE TAP.
 *
 * A carrier tells you an SMS was delivered and nothing else. There is no read
 * receipt and never will be, so without this an SMS campaign is money spent
 * with no outcome attached to it — the salon sees "450 delivered" and has no
 * way to tell a good offer from a bad one.
 *
 * Rewriting the links fixes that, and it is worth doing on WhatsApp and email
 * as well: a click is the closest thing to intent that a message can produce,
 * one step from a booking.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not track people who never clicked. A link is only created when a
 *    message contains one, and nothing is recorded until somebody taps it.
 *  - It does not interpret. A tap is a tap; the dashboard says "clicked", not
 *    "interested".
 *  - It does not break when it fails. If the rewrite throws, the original link
 *    goes out untouched — an unmeasured message that works beats a measured
 *    one that does not.
 */

/**
 * Codes are short because SMS is billed by the character: a 160-character
 * segment is one message and 161 is two. Seven base58-ish characters give
 * ~3.5 trillion combinations, which is far beyond what a salon will send, and
 * the alphabet omits the characters people misread when typing a link by hand
 * off a screen — 0/O and 1/l/I.
 */
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 7;

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i]! % ALPHABET.length];
  return code;
}

/** Finds http(s) links in a message body. */
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;

/**
 * Sentence punctuation that follows a link rather than belonging to it.
 *
 * "Book here: https://parlon.in/book/glow." ends with a full stop that is part
 * of the sentence. Keeping it produces a second, different link pointing at a
 * URL with a stray dot — the customer lands on a 404, and the salon sees two
 * links where they wrote one.
 */
const TRAILING = /[.,;:!?]+$/;

function tidy(url: string): string {
  return url.replace(TRAILING, '');
}

/**
 * What a rewritten link looks like to the customer.
 *
 * THE API'S ORIGIN, NOT THE APP'S. This was PUBLIC_APP_URL, and the /r/:code
 * handler lives in app.ts on the API — a different host. So every tracked link
 * a customer tapped arrived at the Next.js app, which has no such route, and
 * its auth middleware turned an invoice link into
 *
 *     /login?next=%2Fr%2FTbHnkMy
 *
 * A customer opening their bill was asked to sign in to a salon system they
 * have no account for. The redirect had been correct all along; it was simply
 * never reachable at the address we printed.
 */
export function shortUrl(code: string): string {
  return `${env.PUBLIC_API_URL}/r/${code}`;
}

/**
 * Replace every link in a message with a tracked one.
 *
 * Returns the body unchanged when there is nothing to rewrite, so the caller
 * never has to care whether tracking applied.
 */
export async function rewriteLinks(input: {
  body: string;
  tenantId: string;
  messageLogId: string;
  campaignId?: string | null;
  customerId?: string | null;
}): Promise<string> {
  const found = [...new Set((input.body.match(URL_PATTERN) ?? []).map(tidy))].filter(Boolean);
  if (found.length === 0) return input.body;

  /**
   * No API origin, no tracking.
   *
   * Tracking is a nice-to-have; the link working is not. Without
   * PUBLIC_API_URL every rewritten link would point at `/r/xxx` with no host
   * in front of it, which resolves against wherever the customer's mail client
   * happens to be — that is, nowhere. Leaving the real link alone loses a click
   * count. Rewriting it loses the customer.
   */
  if (!env.PUBLIC_API_URL) {
    logger.warn(
      { messageLogId: input.messageLogId },
      'links not tracked: PUBLIC_API_URL is not set, so a tracked link would have no host to resolve against',
    );
    return input.body;
  }

  try {
    let body = input.body;

    for (const target of found) {
      // Already a tracked link — rewriting it again would bounce the customer
      // through two redirects and count the tap twice.
      if (target.startsWith(shortUrl(''))) continue;

      const link = await prisma.trackedLink.create({
        data: {
          tenantId: input.tenantId,
          code: newCode(),
          targetUrl: target,
          messageLogId: input.messageLogId,
          campaignId: input.campaignId ?? null,
          customerId: input.customerId ?? null,
        },
      });

      body = body.split(target).join(shortUrl(link.code));
    }

    return body;
  } catch (err) {
    // Tracking is a nice-to-have; delivering the message is not. A failure
    // here sends the original text rather than nothing at all.
    logger.warn({ err, messageLogId: input.messageLogId }, 'link tracking skipped; sending the original message');
    return input.body;
  }
}

/**
 * Record a tap and say where to send them.
 *
 * Returns null for an unknown code, which the route turns into a plain "this
 * link has expired" page rather than an error — an old message forwarded to a
 * friend is a normal thing to happen, not a fault.
 */
export async function resolveClick(code: string): Promise<{ targetUrl: string; messageLogId: string | null } | null> {
  const link = await prisma.trackedLink.findUnique({ where: { code } });
  if (!link) return null;

  const now = new Date();

  // The redirect must not wait on bookkeeping: a customer standing outside the
  // salon with one bar of signal should get their page, and a failed count is
  // a smaller problem than a slow link.
  void prisma.trackedLink
    .update({
      where: { id: link.id },
      data: {
        clickCount: { increment: 1 },
        lastClickAt: now,
        ...(link.firstClickAt ? {} : { firstClickAt: now }),
      },
    })
    .catch((err: unknown) => logger.warn({ err, code }, 'click count not recorded'));

  return { targetUrl: link.targetUrl, messageLogId: link.messageLogId };
}
