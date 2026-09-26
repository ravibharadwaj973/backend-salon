import crypto from 'node:crypto';
import { prisma } from '../core/prisma';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { destinationOf, identifiesUntil, stillIdentifies } from '../modules/engagement/engagement';

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
export interface LinkOwner {
  tenantId: string;
  messageLogId: string;
  campaignId?: string | null;
  customerId?: string | null;
}

/**
 * One target URL in, one tracked URL out.
 *
 * Shared by the body rewriter and the variable rewriter so the two cannot
 * disagree about what a tracked link looks like, which destination it was
 * filed under, or how long it identifies anybody.
 */
async function trackOne(target: string, owner: LinkOwner): Promise<string> {
  // Already a tracked link — rewriting it again would bounce the customer
  // through two redirects and count the tap twice.
  if (target.startsWith(shortUrl(''))) return target;

  /**
   * The destination is worked out here, not asked for.
   *
   * Every send path in the app already builds its own links and none of them
   * would be changed to pass a label, so a message with three buttons —
   * gallery, offer, book — gets three correctly-typed links for free. See
   * destinationOf in the engagement module.
   */
  const destination = destinationOf(target);

  const link = await prisma.trackedLink.create({
    data: {
      tenantId: owner.tenantId,
      code: newCode(),
      targetUrl: target,
      messageLogId: owner.messageLogId,
      campaignId: owner.campaignId ?? null,
      customerId: owner.customerId ?? null,
      destination,
      identifiesUntil: identifiesUntil(destination),
    },
  });

  return shortUrl(link.code);
}

/**
 * TRACK THE LINKS IN A TEMPLATE'S VARIABLES, NOT JUST IN THE BODY.
 *
 * The bug this exists for, and it hid in plain sight for months.
 *
 * rewriteLinks rewrites the rendered body. For email and for a free-text
 * WhatsApp reply, that body IS the message, so tracking worked. But every
 * approved WhatsApp template send — which is every marketing and utility
 * message outside the 24-hour window, and therefore almost all of them — goes
 * to Meta as a template NAME plus parameters. Meta renders its own stored copy
 * of the wording. The rewritten body is never transmitted at all.
 *
 * So the customer received {{booking_link}} exactly as the app built it:
 * untracked. Every click on WhatsApp was invisible, the funnel showed nobody
 * ever tapping anything, and the arrival token never reached the salon's own
 * website — which meant no site visits and no recorded interest either. The
 * whole chain was dead from its first link, while the code that was supposed to
 * create it ran without error on every send.
 *
 * Rewriting the VALUES is what fixes it: Meta substitutes our parameter into
 * its template, so a tracked URL in the parameter is a tracked URL in the
 * message the customer reads. It is also shorter than the original, which an
 * SMS is billed by.
 */
export async function rewriteVariableLinks(
  variables: Record<string, string>,
  owner: LinkOwner,
): Promise<Record<string, string>> {
  if (!env.PUBLIC_API_URL) return variables;

  const out: Record<string, string> = { ...variables };

  try {
    for (const [key, value] of Object.entries(variables)) {
      if (!value) continue;

      const found = [...new Set((value.match(URL_PATTERN) ?? []).map(tidy))].filter(Boolean);
      if (found.length === 0) continue;

      let rewritten = value;
      for (const target of found) {
        rewritten = rewritten.split(target).join(await trackOne(target, owner));
      }
      out[key] = rewritten;
    }
  } catch (err) {
    /**
     * The ORIGINAL variables, not a half-rewritten set.
     *
     * A partially rewritten map would send some customers a tracked link and
     * others the raw one from the same campaign, which is worse than tracking
     * none of it: the click rate would then be a fraction of an unknown
     * denominator and nobody would know to distrust it.
     */
    logger.warn({ err, messageLogId: owner.messageLogId }, 'variable links not tracked; sending the originals');
    return variables;
  }

  return out;
}

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
      body = body.split(target).join(await trackOne(target, input));
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
export async function resolveClick(
  code: string,
): Promise<{
  targetUrl: string;
  messageLogId: string | null;
  trackedLinkId: string;
  /**
   * Whether this tap may still be credited to the customer.
   *
   * False for a link past its window — usually one forwarded to somebody else
   * months later. The redirect happens either way; only the bookkeeping stops.
   */
  identifies: boolean;
} | null> {
  const link = await prisma.trackedLink.findUnique({ where: { code } });
  if (!link) return null;

  /**
   * The salon's own hosts, for the token allow-list above. One small read on a
   * redirect a customer is waiting on; it is a primary-key lookup and it is
   * the only thing between this and handing a per-person token to Google.
   */
  const tenant = await prisma.tenant
    .findUnique({ where: { id: link.tenantId }, select: { websiteUrl: true } })
    .catch(() => null);

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

  const identifies = stillIdentifies(link, now);

  return {
    /**
     * The arrival token goes on only while the link still identifies anybody.
     * Past the window there is nobody to credit, so handing the site a token it
     * would report against is pointless at best and wrong at worst.
     */
    targetUrl: identifies
      ? withVisitToken(link.targetUrl, link.code, [tenant?.websiteUrl, env.PUBLIC_APP_URL])
      : link.targetUrl,
    messageLogId: link.messageLogId,
    trackedLinkId: link.id,
    identifies,
  };
}

/**
 * ADD THE ARRIVAL TOKEN — BUT ONLY TO THE SALON'S OWN PAGES.
 *
 * The redirect already knows which message a tap came from. Handing that code
 * on to the destination is what lets the salon's website report back what the
 * visitor then did, which is the whole gap between "clicked" and "booked".
 *
 * The allow-list is the point of this function. A salon's messages contain
 * links to Google reviews, to Instagram, to a map. Appending a token that
 * identifies one customer to a URL on somebody else's host hands that host a
 * per-person identifier for no reason at all — a small leak, easy to write by
 * accident, and invisible once shipped. So the token goes on only where the
 * origin is one this salon owns.
 *
 * Returns the URL untouched on anything it cannot parse or does not recognise.
 * An unmeasured link that works beats a measured one that does not, which is
 * the rule the rest of this file is built on too.
 */
export function withVisitToken(targetUrl: string, code: string, allowedOrigins: (string | null | undefined)[]): string {
  try {
    const url = new URL(targetUrl);

    const allowed = allowedOrigins
      .filter((value): value is string => Boolean(value))
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      })
      .filter((origin): origin is string => Boolean(origin));

    if (!allowed.includes(url.origin)) return targetUrl;

    // Never overwrite one that is already there: a link built by hand with its
    // own pv is the salon meaning something by it.
    if (url.searchParams.has('pv')) return targetUrl;

    url.searchParams.set('pv', code);
    return url.toString();
  } catch {
    return targetUrl;
  }
}

