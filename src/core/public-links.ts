import { env } from '../config/env';

/**
 * Every customer-facing link in one place.
 *
 * These end up in WhatsApp messages, in emails, on printed QR codes and inside
 * the snippet a salon pastes into their own website — places we cannot go back
 * and edit. Building them from one configured origin means moving the app to a
 * real domain is a change to PUBLIC_APP_URL and nothing else.
 */

/** The booking page for one salon. Safe to print, share and embed. */
export function bookingUrl(slug: string, options: BookingLinkOptions = {}): string {
  const url = new URL(`/book/${encodeURIComponent(slug)}`, env.PUBLIC_APP_URL);

  if (options.branchId) url.searchParams.set('branch', options.branchId);
  if (options.serviceId) url.searchParams.set('service', options.serviceId);
  if (options.ref) url.searchParams.set('ref', options.ref);
  // Chrome-free, for rendering inside someone else's page.
  if (options.embed) url.searchParams.set('embed', '1');

  return url.toString();
}

export interface BookingLinkOptions {
  branchId?: string;
  serviceId?: string;
  /** A label the salon chooses, so they can tell their website from Instagram. */
  ref?: string;
  embed?: boolean;
}

/** Where a customer leaves feedback after a visit. */
export function feedbackUrl(appointmentId: string): string {
  return new URL(`/feedback/${appointmentId}`, env.PUBLIC_APP_URL).toString();
}

/**
 * The Google-review hand-off. Deliberately routed through our own page rather
 * than straight to Google, so the tap is recorded before the customer leaves.
 */
export function googleReviewUrl(appointmentId: string): string {
  return new URL(`/feedback/${appointmentId}/google`, env.PUBLIC_APP_URL).toString();
}

/** The one-line script a salon pastes into their own website. */
export function embedScriptUrl(slug: string): string {
  return new URL(`${env.API_PREFIX}/public/${encodeURIComponent(slug)}/embed.js`, apiOrigin()).toString();
}

/**
 * This API's own public origin. Falls back to the app origin, which is right
 * whenever the two are served from one domain behind a reverse proxy — the
 * usual arrangement.
 */
function apiOrigin(): string {
  return (process.env.PUBLIC_API_URL ?? env.PUBLIC_APP_URL).replace(/\/+$/, '');
}

/**
 * The hostname a request came from, for attributing a booking when the salon
 * did not label it themselves. Never trusted for anything but display — a
 * Referer header is whatever the browser felt like sending.
 */
export function refererHost(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).hostname.replace(/^www\./, '').slice(0, 60) || undefined;
  } catch {
    return undefined;
  }
}
