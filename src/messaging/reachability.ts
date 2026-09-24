import type { Channel } from '@prisma/client';
import { prisma } from '../core/prisma';
import { runUnscoped } from '../core/context';
import { logger } from '../core/logger';

/**
 * WHETHER AN ADDRESS WORKS, KEPT APART FROM WHETHER THEY WANT TO HEAR FROM US.
 *
 * A salon pays per message. Every send to a number that is not on WhatsApp, or
 * to a mailbox that does not exist, costs the same as one that arrives and can
 * never do anything. Worse, it is charged again every campaign, for ever,
 * because nothing remembered the failure.
 *
 * So the provider's answer is written back onto the customer, and the next send
 * reads it. Three rules decide everything here:
 *
 *   1. Only a PERMANENT failure marks an address unusable. A full mailbox, a
 *      switched-off phone, a deferral — those are bad afternoons, not bad
 *      addresses, and a salon that loses a customer over one has lost more than
 *      the message was worth.
 *
 *   2. A delivery CLEARS it. Numbers get reconnected and mailboxes get emptied.
 *      An address that works is proof, and proof beats a record of an old
 *      failure. Without this, one bad week would exile a customer permanently.
 *
 *   3. A complaint is NOT a delivery failure. Somebody pressing "spam" received
 *      the message perfectly well and does not want another, which is consent,
 *      and consent is theirs to set. That stays where it was.
 */

/** What a provider told us about one attempt. */
export type Outcome =
  | { kind: 'delivered' }
  | { kind: 'permanent'; reason: string }
  | { kind: 'temporary' };

/**
 * WhatsApp error codes that mean the NUMBER is wrong, as against the message,
 * the template, or the moment.
 *
 * Deliberately short. Meta has hundreds of codes and most describe something
 * about the send rather than the recipient, and marking a good customer
 * unreachable because a template was malformed is the expensive mistake here —
 * not the reverse. A code that is not on this list leaves the customer alone.
 *
 *   131026  Message undeliverable — the recipient cannot be reached at all,
 *           most often because the number is not on WhatsApp
 *   1013    Recipient is not a valid WhatsApp user
 *
 * Notably ABSENT, and each for the same reason — the failure is about our
 * message or the moment, not about the person:
 *
 *   131047  Re-engagement: the 24-hour window closed. Says nothing about the
 *           number, which is fine and was fine yesterday.
 *   131051  Unsupported message type. We sent a shape the recipient's client
 *           or the API version will not take — our bug, and silencing a
 *           customer over it would hide the bug behind a dead contact.
 *   131008  A parameter was missing. Ours.
 *   132xxx  Template problems. Also ours.
 *   131049  Meta declined to deliver a marketing message under its own
 *           per-user limits. A throttle, not a bad number.
 *   130429  Rate limit.
 */
const WHATSAPP_BAD_NUMBER = new Set(['131026', '1013']);

/** Reads a Meta error code out of whatever the webhook gave us. */
function whatsappCode(errorCode?: string | null, errorMessage?: string | null): string | null {
  const fromCode = (errorCode ?? '').match(/\d{3,6}/)?.[0];
  if (fromCode) return fromCode;
  return (errorMessage ?? '').match(/\((#?)(\d{3,6})\)/)?.[2] ?? null;
}

/**
 * Decide what one failure means for the address.
 *
 * Errs towards temporary throughout. The cost of calling a bad address
 * temporary is one more wasted message; the cost of calling a good address
 * permanent is a customer the salon can never contact again and will not know
 * they lost.
 */
export function classify(
  channel: Channel,
  status: 'DELIVERED' | 'READ' | 'FAILED' | 'BOUNCED' | 'COMPLAINED' | 'DELAYED' | 'CLICKED',
  detail: { errorCode?: string | null; errorMessage?: string | null; bounceType?: string | null } = {},
): Outcome {
  if (status === 'DELIVERED' || status === 'READ' || status === 'CLICKED') return { kind: 'delivered' };

  // Received and disliked. Their choice, not a broken address.
  if (status === 'COMPLAINED') return { kind: 'temporary' };
  if (status === 'DELAYED') return { kind: 'temporary' };

  if (channel === 'EMAIL') {
    // Resend reports Permanent or Transient. Anything it will not call
    // permanent, we do not either.
    if (status === 'BOUNCED' && (detail.bounceType ?? '').toLowerCase() === 'permanent') {
      return { kind: 'permanent', reason: detail.errorMessage || 'The mailbox does not exist' };
    }
    return { kind: 'temporary' };
  }

  if (channel === 'WHATSAPP') {
    const code = whatsappCode(detail.errorCode, detail.errorMessage);
    if (code && WHATSAPP_BAD_NUMBER.has(code)) {
      return { kind: 'permanent', reason: detail.errorMessage || `WhatsApp could not reach this number (${code})` };
    }
    return { kind: 'temporary' };
  }

  if (channel === 'SMS') {
    // MSG91's delivery reports vary by operator, so this matches on what the
    // report SAYS rather than on a code nobody can rely on. Anything else is a
    // network having a bad day.
    const text = `${detail.errorCode ?? ''} ${detail.errorMessage ?? ''}`.toLowerCase();
    const badNumber = ['invalid number', 'invalid mobile', 'non-existent', 'not exist', 'dnd', 'absent subscriber'];
    if (badNumber.some((phrase) => text.includes(phrase))) {
      return { kind: 'permanent', reason: detail.errorMessage || 'The operator rejected this number' };
    }
    return { kind: 'temporary' };
  }

  return { kind: 'temporary' };
}

const FIELDS: Record<string, { status: string; error: string; checked: string }> = {
  WHATSAPP: { status: 'whatsappStatus', error: 'whatsappLastError', checked: 'whatsappCheckedAt' },
  SMS: { status: 'smsStatus', error: 'smsLastError', checked: 'smsCheckedAt' },
  EMAIL: { status: 'emailStatus', error: 'emailLastError', checked: 'emailCheckedAt' },
};

/**
 * Write what we learned onto the customer.
 *
 * Nothing is written for a temporary failure — not even the timestamp. A row
 * updated on every deferral is a row rewritten constantly to say the same
 * thing, and the audit trail it leaves says nothing either.
 */
export async function recordReachability(input: {
  customerId: string | null;
  channel: Channel;
  outcome: Outcome;
}): Promise<void> {
  if (!input.customerId) return;
  if (input.outcome.kind === 'temporary') return;

  const fields = FIELDS[input.channel];
  if (!fields) return;

  const delivered = input.outcome.kind === 'delivered';

  await runUnscoped(() =>
    prisma.customer.update({
      where: { id: input.customerId! },
      data: {
        [fields.status]: delivered ? 'OK' : 'UNDELIVERABLE',
        [fields.error]: delivered ? null : input.outcome.kind === 'permanent' ? input.outcome.reason.slice(0, 300) : null,
        [fields.checked]: new Date(),
      },
    }),
  ).catch((err: unknown) => {
    // Never the reason a status update fails. Knowing the message bounced
    // matters more than remembering it for next time.
    logger.warn({ err, customerId: input.customerId, channel: input.channel }, 'could not record reachability');
  });
}

/** The field holding this channel's verdict, for callers building a where clause. */
export function reachField(channel: Channel): string | null {
  return FIELDS[channel]?.status ?? null;
}

/** The columns a suppression decision reads. Any row carrying them will do. */
export interface ReachColumns {
  whatsappStatus?: string | null;
  whatsappLastError?: string | null;
  smsStatus?: string | null;
  smsLastError?: string | null;
  emailStatus?: string | null;
  emailLastError?: string | null;
}

/**
 * Should this send be held back, and what do we tell the salon if so?
 *
 * Pulled out of the dispatcher so it can be tested without a database, and
 * typed rather than indexed by string: the previous version read the column
 * through a cast, which meant renaming a field would have turned suppression
 * off silently and the only symptom would have been a slightly larger bill.
 *
 * Returns null when the send should go ahead — the common case, and the one
 * this errs towards everywhere.
 */
export function suppressionFor(
  row: ReachColumns | null | undefined,
  channel: Channel,
): { reason: string } | null {
  if (!row) return null;

  const status =
    channel === 'EMAIL' ? row.emailStatus : channel === 'SMS' ? row.smsStatus : row.whatsappStatus;
  if (status !== 'UNDELIVERABLE') return null;

  const lastError =
    channel === 'EMAIL' ? row.emailLastError : channel === 'SMS' ? row.smsLastError : row.whatsappLastError;

  // Written for the person reading the message log, so it names the fix
  // rather than the failure — the address is correctable, and correcting it
  // is the only thing that brings the customer back.
  const what = channel === 'EMAIL' ? 'email address' : 'phone number';
  return {
    reason:
      `Not sent: ${channel.toLowerCase()} to this customer was permanently refused` +
      `${lastError ? ` — ${lastError}` : ''}. Correct the ${what} on their profile and sending resumes ` +
      'automatically.',
  };
}
