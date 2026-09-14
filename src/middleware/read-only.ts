import type { Request } from 'express';
import { Forbidden } from '../core/errors';

/**
 * READ-ONLY MODE
 *
 * When a salon's account is switched off, it keeps every screen it had and
 * loses the ability to change anything. Reads pass; writes are refused.
 *
 * Locking them out entirely punishes the wrong thing. Their appointment
 * history, customer book and invoices are their records — needed to serve
 * whoever is standing at the counter, to answer a tax question, to export and
 * leave. What stops is *new work*: no bookings, no bills, no messages. That is
 * the pressure that gets an invoice paid, and it does not hold a salon's own
 * data hostage to apply it.
 *
 * The HTTP method is the test: GET and HEAD are reads, everything else is a
 * write. That holds because this API is honest about verbs — there is no GET
 * that raises an invoice.
 *
 * Checked inside `authenticate` rather than as its own mounted middleware, so
 * it cannot be missed by a router that authenticates itself. One gate at the
 * edge beats the same check scattered through sixty services, where one would
 * eventually be forgotten.
 */

/**
 * The few writes that must still work, or a salon cannot act on the message
 * telling it why it is read-only: signing out, refreshing a token it already
 * holds, and changing its own password — being switched off is exactly when
 * someone discovers they have lost their login.
 */
const ALWAYS_ALLOWED: readonly RegExp[] = [
  /\/auth\/logout$/,
  /\/auth\/logout-all$/,
  /\/auth\/refresh$/,
  /\/auth\/change-password$/,
];

export function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/** Throws when this request would change something a read-only salon may not. */
export function assertWritable(req: Request): void {
  if (!req.auth?.readOnly) return;
  if (!isWrite(req.method)) return;

  const path = req.originalUrl.split('?')[0] ?? '';
  if (ALWAYS_ALLOWED.some((allowed) => allowed.test(path))) return;

  throw Forbidden(req.auth.readOnlyReason ?? 'This salon account is read-only.', {
    readOnly: true,
    // So the interface can show the right banner rather than parsing prose.
    reason: 'TENANT_READ_ONLY',
  });
}
