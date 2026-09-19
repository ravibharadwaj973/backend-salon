/**
 * MSG91's delivery report, translated.
 *
 * SMS is the channel with the least to say: a carrier reports that it handed
 * the message over, and nothing about whether anybody read it. That makes the
 * little it does report worth getting exactly right — a failed SMS that shows
 * as delivered is a customer the salon thinks it reached.
 *
 * Status codes are MSG91's own, from their delivery-report webhook docs:
 *
 *   0   Sent          handed to the carrier
 *   1   Delivered     reached the handset
 *   2   Failed
 *   9   NDNC          on India's Do Not Disturb register (promotional only)
 *   16  Rejected
 *   17  Blocked       the number is blocked
 *   20  Country code blocked
 *   25  Rejected
 *
 * The payload arrives with values as strings ("status": "1"), which is why
 * everything here is compared loosely rather than as numbers.
 */

export type SmsOutcome = 'SENT' | 'DELIVERED' | 'FAILED';

export interface Msg91Report {
  /** MSG91's id for the send, matching what the provider returned to us. */
  requestId: string;
  status: SmsOutcome;
  /** Why it failed, in words a salon can act on. */
  reason: string | null;
  at: Date | null;
}

/**
 * NDNC and a blocked number are not "the network was busy" — they are the
 * salon being told, by law or by the customer, not to message this person.
 * They deserve their own sentence rather than a generic failure.
 */
const REASONS: Record<string, string> = {
  '2': 'The carrier could not deliver it',
  '9': 'This number is on the national Do Not Disturb register, so promotional SMS cannot be sent to it',
  '16': 'The carrier rejected it — usually an unregistered sender ID or template',
  '17': 'This number is blocked',
  '20': 'SMS to this country is not enabled on your account',
  '25': 'The carrier rejected it — usually an unregistered sender ID or template',
};

const DELIVERED = new Set(['1']);
const SENT = new Set(['0']);

/**
 * Turn one report into something the message log understands.
 *
 * Returns null when the payload carries no request id, which is the only case
 * where there is nothing sensible to do: without it there is no way to know
 * which message the report is about.
 */
export function parseReport(raw: Record<string, unknown>): Msg91Report | null {
  const requestId = String(raw.requestId ?? raw.request_id ?? '').trim();
  if (!requestId) return null;

  const code = String(raw.status ?? '').trim();

  const status: SmsOutcome = DELIVERED.has(code) ? 'DELIVERED' : SENT.has(code) ? 'SENT' : 'FAILED';

  // MSG91's own failureReason is more specific than our mapping when it is
  // filled in, so it wins; ours is the fallback for the codes it leaves blank.
  const given = typeof raw.failureReason === 'string' ? raw.failureReason.trim() : '';

  const when = raw.deliveryTime ?? raw.requestedAt;
  const at = typeof when === 'string' && when ? new Date(when) : null;

  return {
    requestId,
    status,
    reason: status === 'FAILED' ? given || REASONS[code] || 'Delivery failed' : null,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

/**
 * MSG91 documents a single object, but webhooks of this kind are routinely
 * batched, and a provider that starts sending arrays should not silently stop
 * every SMS status in the product.
 */
export function parseReports(body: unknown): Msg91Report[] {
  const rows = Array.isArray(body) ? body : [body];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map(parseReport)
    .filter((report): report is Msg91Report => report !== null);
}
