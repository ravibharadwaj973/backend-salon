import { describe, expect, it } from 'vitest';
import {
  ALL_METERS,
  METER_LABELS,
  NEVER_REFUSED,
  meterFor,
  quotaOf,
} from '../src/modules/quotas/quota.service';
import { allowedShape, windowExpiresAt, windowIsOpen } from '../src/messaging/service-window';

/**
 * A REPLY TO A CUSTOMER IS NOT AN APPOINTMENT REMINDER.
 *
 * Free-form replies — the assistant answering a question, a receptionist typing
 * in the inbox — were charged to the WhatsApp utility allowance, the one that
 * pays for confirmations and reminders. Two things followed, and the second is
 * the serious one:
 *
 *   · Meta charged nothing at all for those messages between November 2024 and
 *     1 October 2026, so a paid allowance was spent on free messages;
 *   · when the allowance ran out the WHOLE ACCOUNT was paused, so the assistant
 *     went silent AND the reminders stopped. A customer asking a question got
 *     nothing back because a different kind of message had run out.
 */

describe('what each kind of WhatsApp message is charged to', () => {
  it('charges a reply to its own meter, not to utility', () => {
    expect(meterFor('WHATSAPP', 'SERVICE')).toBe('WA_SERVICE');
    expect(meterFor('WHATSAPP', 'SERVICE')).not.toBe('WA_UTILITY');
  });

  it('still charges templates to their own categories', () => {
    expect(meterFor('WHATSAPP', 'UTILITY')).toBe('WA_UTILITY');
    expect(meterFor('WHATSAPP', 'MARKETING')).toBe('WA_MARKETING');
    expect(meterFor('WHATSAPP', 'AUTHENTICATION')).toBe('WA_AUTHENTICATION');
  });

  it('leaves SMS and email alone whatever the category says', () => {
    // meterFor switches on channel first. A template-less SMS is still SMS —
    // WhatsApp's categories have nothing to do with it.
    for (const category of ['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE'] as const) {
      expect(meterFor('SMS', category)).toBe('SMS');
      expect(meterFor('EMAIL', category)).toBe('EMAIL');
    }
  });

  it('charges nothing for an in-app notice', () => {
    expect(meterFor('IN_APP')).toBeNull();
  });
});

describe('the allowance that must never stop a reply', () => {
  it('is the replies meter, and only that one', () => {
    expect(NEVER_REFUSED).toEqual(['WA_SERVICE']);
  });

  it('never exempts a meter the salon chose to spend', () => {
    /**
     * The exception exists because somebody is waiting, not because sending is
     * free. A marketing blast running out of allowance SHOULD stop — nobody is
     * mid-conversation, and the next message costs real money for a campaign the
     * salon can resume tomorrow.
     */
    for (const meter of ['WA_MARKETING', 'WA_UTILITY', 'WA_AUTHENTICATION', 'SMS', 'EMAIL'] as const) {
      expect(NEVER_REFUSED).not.toContain(meter);
    }
  });

  it('draws its allowance from the plan like every other meter', () => {
    // Counted and shown, so going over is visible and billable — it just does
    // not gate. An allowance of zero would make the usage screen say the salon
    // has no allowance at all, which is a different and wrong statement.
    const plan = {
      waUtilityQuota: 500,
      waMarketingQuota: 200,
      waAuthQuota: 0,
      waServiceQuota: 1000,
      smsQuota: 250,
      emailQuota: 2000,
    };
    expect(quotaOf(plan, 'WA_SERVICE')).toBe(1000);
    expect(quotaOf(null, 'WA_SERVICE')).toBe(0);
  });
});

describe('every meter is complete', () => {
  it('appears in the list the usage screen iterates', () => {
    // A meter missing here is charged but never shown: the salon is billed for
    // something no screen mentions.
    expect(ALL_METERS).toContain('WA_SERVICE');
    expect(new Set(ALL_METERS).size).toBe(ALL_METERS.length);
  });

  it('has a label, and one written for a salon rather than for Meta', () => {
    for (const meter of ALL_METERS) {
      expect(METER_LABELS[meter]).toBeTruthy();
    }
    // "Service messages" is Meta's billing word and means nothing to somebody
    // reading their own usage screen.
    expect(METER_LABELS.WA_SERVICE).toBe('WhatsApp replies');
  });
});

/**
 * THE WINDOW AND THE PRICE ARE TWO DIFFERENT QUESTIONS.
 *
 * The window decides whether a free-form message may be SENT. The category
 * decides what it COSTS. Conflating them is what produced the bug above, so
 * both halves are pinned here together.
 */
describe('the 24-hour window, which is a separate question from the price', () => {
  const at = (iso: string) => new Date(iso);

  it('runs 24 hours from the customer’s last message', () => {
    expect(windowExpiresAt(at('2026-10-01T10:00:00Z')).toISOString()).toBe('2026-10-02T10:00:00.000Z');
  });

  it('moves forward every time the customer writes again', () => {
    // Day 1 10:00, then again at 20:00 — the window runs from the LATEST one,
    // so it closes at 20:00 the next day, not 10:00.
    const first = at('2026-10-01T10:00:00Z');
    const later = at('2026-10-01T20:00:00Z');
    expect(windowExpiresAt(later).getTime()).toBeGreaterThan(windowExpiresAt(first).getTime());

    // Computed from the last inbound rather than stored, so it cannot drift out
    // of step with the message that set it.
    const justInside = at('2026-10-02T19:59:00Z');
    expect(windowIsOpen(first, justInside)).toBe(false);
    expect(windowIsOpen(later, justInside)).toBe(true);
  });

  it('asks for a template once it has closed', () => {
    const last = at('2026-10-01T10:00:00Z');
    expect(allowedShape(last, at('2026-10-01T23:00:00Z'))).toBe('FREE_FORM');
    expect(allowedShape(last, at('2026-10-02T10:00:01Z'))).toBe('TEMPLATE');
  });

  it('treats a customer who has never written as out of window', () => {
    expect(windowIsOpen(null)).toBe(false);
    expect(allowedShape(null)).toBe('TEMPLATE');
  });

  it('does not make an open window mean a free message', () => {
    /**
     * The whole point. Being inside the window says only that a template is not
     * required; from 1 October 2026 Meta charges for the reply just the same,
     * at the utility rate. So a free-form message still meters.
     */
    expect(meterFor('WHATSAPP', 'SERVICE')).not.toBeNull();
  });
});
