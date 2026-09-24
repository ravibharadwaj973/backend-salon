import { describe, expect, it } from 'vitest';
import { classify, reachField, suppressionFor } from '../src/messaging/reachability';

/**
 * WHEN A FAILURE IS THE ADDRESS'S FAULT, AND WHEN IT IS OURS.
 *
 * These tests exist because the two mistakes available here are not the same
 * size. Calling a dead address temporary costs one more wasted message, and
 * the next campaign will teach us again. Calling a live address permanent
 * removes a paying customer from every future send, silently, and nobody at
 * the salon will ever be told it happened — they will just stop hearing from
 * someone who used to book every month.
 *
 * So the asymmetry is the specification: everything that is not proof of a
 * bad address stays temporary.
 */

describe('classifying what a provider told us', () => {
  describe('a delivery is proof the address works', () => {
    it.each(['DELIVERED', 'READ', 'CLICKED'] as const)('%s clears the address', (status) => {
      // Not merely "not a failure" — actively good news. Numbers get
      // reconnected and mailboxes get emptied, and this is what lets a
      // customer come back from one bad week.
      expect(classify('WHATSAPP', status)).toEqual({ kind: 'delivered' });
      expect(classify('EMAIL', status)).toEqual({ kind: 'delivered' });
      expect(classify('SMS', status)).toEqual({ kind: 'delivered' });
    });
  });

  describe('a complaint is consent, not deliverability', () => {
    it('never marks the address unusable', () => {
      // Someone pressing "spam" received the message perfectly. They are
      // telling us to stop, which is a consent decision and theirs to make —
      // and it is recorded as one elsewhere. Writing it here as well would
      // conflate "we may not" with "we cannot", and the salon would lose the
      // ability to send them an appointment reminder they still want.
      expect(classify('EMAIL', 'COMPLAINED', { bounceType: 'Permanent' })).toEqual({ kind: 'temporary' });
    });
  });

  describe('email', () => {
    it('trusts Resend when it says the bounce was permanent', () => {
      const out = classify('EMAIL', 'BOUNCED', { bounceType: 'Permanent', errorMessage: 'Mailbox does not exist' });
      expect(out.kind).toBe('permanent');
      expect(out).toMatchObject({ reason: 'Mailbox does not exist' });
    });

    it('reads the bounce type case-insensitively', () => {
      // Resend has sent both "Permanent" and "permanent"; a casing change
      // upstream must not quietly turn suppression off.
      expect(classify('EMAIL', 'BOUNCED', { bounceType: 'permanent' }).kind).toBe('permanent');
      expect(classify('EMAIL', 'BOUNCED', { bounceType: 'PERMANENT' }).kind).toBe('permanent');
    });

    it('leaves a transient bounce alone', () => {
      // A full mailbox or a greylisting server. The address is fine and will
      // be fine next week.
      expect(classify('EMAIL', 'BOUNCED', { bounceType: 'Transient' })).toEqual({ kind: 'temporary' });
    });

    it('treats a bounce of unknown type as temporary', () => {
      // If the webhook shape changes and the type stops arriving, the failure
      // mode must be "send one more email", not "delete the mailing list".
      expect(classify('EMAIL', 'BOUNCED', {})).toEqual({ kind: 'temporary' });
      expect(classify('EMAIL', 'BOUNCED', { bounceType: null })).toEqual({ kind: 'temporary' });
    });

    it('does not suppress on a plain FAILED', () => {
      // FAILED is our side: the API refused it, the key was wrong, the send
      // never left. Nothing was learned about the mailbox.
      expect(classify('EMAIL', 'FAILED', { errorMessage: 'connection reset' })).toEqual({ kind: 'temporary' });
    });
  });

  describe('whatsapp', () => {
    it('suppresses a number WhatsApp says it cannot reach', () => {
      expect(classify('WHATSAPP', 'FAILED', { errorCode: '131026' }).kind).toBe('permanent');
      expect(classify('WHATSAPP', 'FAILED', { errorCode: '1013' }).kind).toBe('permanent');
    });

    it('finds the code in the message when the webhook sends no code field', () => {
      const out = classify('WHATSAPP', 'FAILED', { errorMessage: 'Message undeliverable (#131026)' });
      expect(out.kind).toBe('permanent');
    });

    it('does not suppress on a closed 24-hour window', () => {
      // 131047 is the single most common WhatsApp failure in a salon's book,
      // and it is about the clock, not the number. Suppressing on it would
      // empty the customer list within a couple of campaigns.
      expect(classify('WHATSAPP', 'FAILED', { errorCode: '131047' })).toEqual({ kind: 'temporary' });
    });

    it('does not suppress on an unsupported message type', () => {
      // 131051 is our formatting bug. Marking the customer undeliverable
      // would hide our own bug behind a contact that looks dead.
      expect(classify('WHATSAPP', 'FAILED', { errorCode: '131051' })).toEqual({ kind: 'temporary' });
    });

    it('does not suppress on our own mistakes or Meta’s throttles', () => {
      for (const code of ['131008', '132000', '132012', '130429', '131049', '133010']) {
        expect(classify('WHATSAPP', 'FAILED', { errorCode: code }), code).toEqual({ kind: 'temporary' });
      }
    });

    it('does not suppress when there is no code at all', () => {
      expect(classify('WHATSAPP', 'FAILED', {})).toEqual({ kind: 'temporary' });
      expect(classify('WHATSAPP', 'FAILED', { errorMessage: 'something went wrong' })).toEqual({ kind: 'temporary' });
    });

    it('does not mistake a number inside the message for an error code', () => {
      // The code is read from a parenthesised token, so an amount or a date in
      // the failure text cannot be read as a verdict about the number.
      expect(classify('WHATSAPP', 'FAILED', { errorMessage: 'failed for order 131026' })).toEqual({
        kind: 'temporary',
      });
    });
  });

  describe('sms', () => {
    it('suppresses when the operator names the number as the problem', () => {
      for (const text of ['Invalid Number', 'invalid mobile number', 'Absent Subscriber', 'number does not exist']) {
        expect(classify('SMS', 'FAILED', { errorMessage: text }).kind, text).toBe('permanent');
      }
    });

    it('leaves everything else to the network', () => {
      for (const text of ['operator timeout', 'submitted', 'queued at operator', 'route unavailable']) {
        expect(classify('SMS', 'FAILED', { errorMessage: text }), text).toEqual({ kind: 'temporary' });
      }
    });

    it('does not suppress on an empty report', () => {
      expect(classify('SMS', 'FAILED', {})).toEqual({ kind: 'temporary' });
    });
  });

  describe('a delay is never a verdict', () => {
    it.each(['WHATSAPP', 'SMS', 'EMAIL'] as const)('%s', (channel) => {
      expect(classify(channel, 'DELAYED', { errorCode: '131026', bounceType: 'Permanent' })).toEqual({
        kind: 'temporary',
      });
    });
  });
});

describe('the column each channel writes to', () => {
  it('keeps the three channels apart', () => {
    // One shared column would mean a bounced email silenced the customer's
    // phone as well.
    expect(reachField('WHATSAPP')).toBe('whatsappStatus');
    expect(reachField('SMS')).toBe('smsStatus');
    expect(reachField('EMAIL')).toBe('emailStatus');
    expect(new Set(['WHATSAPP', 'SMS', 'EMAIL'].map((c) => reachField(c as never))).size).toBe(3);
  });
});

/**
 * The gate itself: the reason any of this was built. Every send this holds
 * back is money the salon keeps, and every send it wrongly holds back is a
 * customer who quietly stops hearing from them — so the default answer, on
 * anything less than a recorded permanent refusal, is "send it".
 */
describe('holding back a send', () => {
  const row = (over: Record<string, string | null> = {}) => ({
    whatsappStatus: 'UNKNOWN',
    smsStatus: 'UNKNOWN',
    emailStatus: 'UNKNOWN',
    ...over,
  });

  it('holds back a channel the provider permanently refused', () => {
    expect(suppressionFor(row({ emailStatus: 'UNDELIVERABLE' }), 'EMAIL')).not.toBeNull();
  });

  it('holds back only that channel', () => {
    // The whole point of three columns. A bounced email must not cost the
    // salon the ability to send an appointment reminder by SMS.
    const r = row({ emailStatus: 'UNDELIVERABLE' });
    expect(suppressionFor(r, 'EMAIL')).not.toBeNull();
    expect(suppressionFor(r, 'SMS')).toBeNull();
    expect(suppressionFor(r, 'WHATSAPP')).toBeNull();
  });

  it('lets an OK or never-tried address through', () => {
    for (const status of ['OK', 'UNKNOWN']) {
      expect(suppressionFor(row({ emailStatus: status }), 'EMAIL'), status).toBeNull();
    }
  });

  it('lets a send through when there is no customer at all', () => {
    // A lead, or a one-off to a typed-in number. Nothing is known about it,
    // and nothing known is not a refusal.
    expect(suppressionFor(null, 'EMAIL')).toBeNull();
    expect(suppressionFor(undefined, 'WHATSAPP')).toBeNull();
  });

  it('lets a send through when the columns are missing entirely', () => {
    // An older row, or a query that selected fewer fields. The failure mode
    // has to be "send it anyway", never "silently stop messaging everybody".
    expect(suppressionFor({}, 'EMAIL')).toBeNull();
  });

  it('tells the salon what to do, not just what happened', () => {
    // This string is what somebody reads in the message log when they ask why
    // a customer stopped getting messages. If it does not name the fix, the
    // customer stays lost.
    const out = suppressionFor(row({ whatsappStatus: 'UNDELIVERABLE' }), 'WHATSAPP');
    expect(out?.reason).toContain('phone number');
    expect(out?.reason).toContain('resumes automatically');
  });

  it('names the email field for email and the phone field for the rest', () => {
    expect(suppressionFor(row({ emailStatus: 'UNDELIVERABLE' }), 'EMAIL')?.reason).toContain('email address');
    expect(suppressionFor(row({ smsStatus: 'UNDELIVERABLE' }), 'SMS')?.reason).toContain('phone number');
  });

  it('passes the provider’s own wording through when there is one', () => {
    const out = suppressionFor(
      row({ emailStatus: 'UNDELIVERABLE', emailLastError: 'Mailbox does not exist' }),
      'EMAIL',
    );
    expect(out?.reason).toContain('Mailbox does not exist');
  });

  it('reads cleanly when the provider gave no reason', () => {
    // No dangling dash where the provider's wording would have gone.
    const out = suppressionFor(row({ emailStatus: 'UNDELIVERABLE', emailLastError: null }), 'EMAIL');
    expect(out?.reason).not.toContain('—');
  });
});
