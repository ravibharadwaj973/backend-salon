import { describe, expect, it } from 'vitest';
import { reachAll, reachOf } from '../src/modules/marketing/reach';
import type { ContactRow } from '../src/modules/marketing/reach';

/**
 * A segment's size and a campaign's size are different numbers, and the gap is
 * where a salon's expectations get broken: "2,400 customers" is 2,400 WhatsApp
 * messages and maybe 900 emails, because a third of an Indian salon's book has
 * no email address at all.
 *
 * These pin the split down. The important property is that the three numbers
 * always account for everybody — a person who disappears from all three is a
 * person the owner was never told about.
 */

const row = (over: Partial<ContactRow> = {}): ContactRow => ({
  phone: '9876543210',
  email: 'someone@example.com',
  whatsappConsent: 'OPTED_IN',
  smsConsent: 'OPTED_IN',
  emailConsent: 'OPTED_IN',
  ...over,
});

const BOOK: ContactRow[] = [
  row(),
  row({ email: null }), // the common case: phone only
  row({ email: '' }), // cleared in an edit rather than never set
  row({ email: '   ' }), // whitespace is not an address
  row({ emailConsent: 'OPTED_OUT' }),
  row({ emailConsent: 'UNKNOWN' }),
  row({ whatsappConsent: 'OPTED_OUT' }),
  row({ phone: '' }), // imported without a number
];

describe('who a segment can reach', () => {
  it('always accounts for everybody, on every channel', () => {
    // If these ever stop summing, somebody is being silently dropped from the
    // numbers shown before a send.
    for (const channel of ['WHATSAPP', 'SMS', 'EMAIL'] as const) {
      const r = reachOf(BOOK, channel, 'MARKETING');
      expect(r.reachable + r.noAddress + r.noConsent).toBe(BOOK.length);
    }
  });

  it('counts a blank, empty or whitespace email as no address, not as opted out', () => {
    // Three different ways an address goes missing, one honest answer: the
    // salon needs to collect an address, not chase a consent.
    const r = reachOf(BOOK, 'EMAIL', 'MARKETING');
    expect(r.noAddress).toBe(3);
  });

  it('requires a positive opt-in for marketing', () => {
    const r = reachOf(BOOK, 'EMAIL', 'MARKETING');
    // OPTED_OUT and UNKNOWN both fail; only OPTED_IN passes.
    expect(r.noConsent).toBe(2);
    expect(r.reachable).toBe(3);
  });

  it('lets a reminder through to anyone who has not said no', () => {
    // A utility message — "your appointment is at 4" — is not marketing, and
    // silence is not a refusal.
    const marketing = reachOf(BOOK, 'EMAIL', 'MARKETING');
    const utility = reachOf(BOOK, 'EMAIL', 'UTILITY');
    expect(utility.reachable).toBe(marketing.reachable + 1); // the UNKNOWN one
    expect(utility.noConsent).toBe(1); // only the explicit OPTED_OUT
  });

  it('reads consent per channel, never one channel’s answer for another', () => {
    // Opting out of WhatsApp is not opting out of email.
    const one = [row({ whatsappConsent: 'OPTED_OUT' })];
    expect(reachOf(one, 'WHATSAPP', 'MARKETING').reachable).toBe(0);
    expect(reachOf(one, 'EMAIL', 'MARKETING').reachable).toBe(1);
    expect(reachOf(one, 'SMS', 'MARKETING').reachable).toBe(1);
  });

  it('treats SMS and WhatsApp as needing a phone, not an email', () => {
    const phoneless = [row({ phone: '' })];
    expect(reachOf(phoneless, 'SMS', 'MARKETING').noAddress).toBe(1);
    expect(reachOf(phoneless, 'WHATSAPP', 'MARKETING').noAddress).toBe(1);
    expect(reachOf(phoneless, 'EMAIL', 'MARKETING').reachable).toBe(1);
  });

  it('gives every channel a figure, so none of the three is guessed at', () => {
    const all = reachAll(BOOK, 'MARKETING');
    expect(Object.keys(all).sort()).toEqual(['EMAIL', 'SMS', 'WHATSAPP']);
    expect(all.EMAIL.reachable).not.toBe(all.WHATSAPP.reachable);
  });

  it('says nobody rather than everybody for an empty segment', () => {
    const empty = reachAll([], 'MARKETING');
    expect(empty.EMAIL).toEqual({ reachable: 0, noAddress: 0, noConsent: 0 });
  });
});
