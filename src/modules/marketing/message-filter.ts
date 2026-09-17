import { MessageStatus } from '@prisma/client';

/**
 * Turn the `status` query string on the message log into a list of enum values.
 *
 * Two reasons this is not a straight cast:
 *
 * 1. "Everything that went wrong" is one filter to the person reading the log,
 *    but four values in the database (DELAYED, BOUNCED, COMPLAINED, FAILED).
 *    Commas let one chip ask for all four.
 * 2. Anything reaching Prisma as a status has to be a real enum member. A cast
 *    would let `?status=delivere` through to the query, where Postgres rejects
 *    the unknown enum label and the whole page becomes a 500 — a typo in a
 *    bookmark should show the unfiltered log, not an error.
 *
 * Unknown values are dropped rather than rejected, so one bad entry in a list
 * does not throw away the good ones.
 */
export function parseStatusFilter(value: string | undefined): MessageStatus[] {
  const allowed = new Set<string>(Object.values(MessageStatus));
  const seen = new Set<MessageStatus>();

  for (const part of (value ?? '').split(',')) {
    const candidate = part.trim().toUpperCase();
    if (allowed.has(candidate)) seen.add(candidate as MessageStatus);
  }

  return [...seen];
}
