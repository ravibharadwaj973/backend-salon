import { describe, expect, it } from 'vitest';
import { CAPABILITIES, SENDING_CHANNELS } from '../src/modules/analytics/messaging-analytics.service';
import { PURPOSE_LABELS, PURPOSE_ORDER, purposeOfTrigger } from '../src/messaging/purpose';
import { NOTIFICATIONS } from '../src/messaging/notifications';

/**
 * The failure this whole report is built to avoid is a number that is not a
 * measurement: "SMS read rate 0%" sits next to WhatsApp's 71% and reads as a
 * disaster, when in fact no SMS operator on earth reports whether a message
 * was read. A salon acting on that would move spend away from the channel
 * that works.
 */
describe('what each channel can actually measure', () => {
  it('does not claim SMS can report opens or clicks', () => {
    expect(CAPABILITIES.SMS.read).toBe(false);
    expect(CAPABILITIES.SMS.click).toBe(false);
  });

  it('gives every channel a note explaining what its numbers mean', () => {
    // A blank cell with no explanation is read as a zero. Each channel has to
    // be able to say why a figure is missing or soft.
    for (const channel of ['WHATSAPP', 'EMAIL', 'SMS'] as const) {
      expect(CAPABILITIES[channel].note, channel).toBeTruthy();
    }
  });

  it('warns that email opens are inflated rather than silently correcting them', () => {
    // Apple Mail fetches the pixel whether or not a human looked. Any
    // "correction" would be a guess presented as a fact.
    expect(CAPABILITIES.EMAIL.note?.toLowerCase()).toContain('apple');
    expect(CAPABILITIES.EMAIL.read).toBe(true);
  });

  it('only claims bounces and complaints for email', () => {
    // WhatsApp and SMS have no equivalent; showing a 0% bounce rate for them
    // would imply a clean list rather than an unmeasured one.
    expect(CAPABILITIES.EMAIL.bounce).toBe(true);
    expect(CAPABILITIES.WHATSAPP.bounce).toBe(false);
    expect(CAPABILITIES.SMS.bounce).toBe(false);
  });

  it('agrees that every channel that leaves the building reports delivery', () => {
    for (const channel of ['WHATSAPP', 'EMAIL', 'SMS'] as const) {
      expect(CAPABILITIES[channel].delivery, channel).toBe(true);
    }
  });

  it('does not treat in-app notices as a badly performing channel', () => {
    // Nothing is sent, so nothing can be delivered. Reported as unmeasurable
    // rather than as 0% delivered, and left out of the channel breakdown.
    expect(CAPABILITIES.IN_APP.delivery).toBe(false);
    expect(SENDING_CHANNELS).not.toContain('IN_APP');
  });
});

describe('what a message was for', () => {
  it('declares a purpose for every message the app sends by itself', () => {
    // A missing one would file real traffic under "Other", and "Other" is
    // where a report goes to stop being useful.
    for (const [key, def] of Object.entries(NOTIFICATIONS)) {
      expect(def.purpose, key).toBeTruthy();
      expect(PURPOSE_ORDER, key).toContain(def.purpose);
    }
  });

  it('files nothing the app sends automatically as Other', () => {
    const other = Object.entries(NOTIFICATIONS).filter(([, d]) => d.purpose === 'OTHER');
    expect(other.map(([k]) => k)).toEqual([]);
  });

  it('separates the private feedback ask from the public review ask', () => {
    // These share a template and must not share a bucket: one is "tell us",
    // the other is "tell Google", and conflating them hides whether the
    // filter between them is working.
    expect(NOTIFICATIONS.feedbackRequest.purpose).toBe('FEEDBACK');
    expect(NOTIFICATIONS.googleReviewRequest.purpose).toBe('REVIEW');
    expect(NOTIFICATIONS.feedbackRequest.template).toBe(NOTIFICATIONS.feedbackRequest.template);
  });

  it('puts every win-back and expiry nudge in the same bucket', () => {
    // The owner thinks of these as one activity — "getting people back in" —
    // so splitting them across four labels answers a question nobody asked.
    for (const key of ['rebookingReminder', 'winBack', 'birthday', 'membershipExpiring', 'packageExpiring'] as const) {
      expect(NOTIFICATIONS[key].purpose, key).toBe('FOLLOW_UP');
    }
  });

  it('gives every journey trigger a purpose', () => {
    const triggers = [
      'APPOINTMENT_BOOKED', 'APPOINTMENT_REMINDER', 'APPOINTMENT_COMPLETED', 'APPOINTMENT_CANCELLED',
      'FIRST_VISIT', 'INVOICE_PAID', 'NO_VISIT_DAYS', 'MEMBERSHIP_EXPIRING', 'PACKAGE_EXPIRING',
      'BIRTHDAY', 'ANNIVERSARY', 'LEAD_CREATED', 'REVIEW_REQUEST', 'FEEDBACK_POSITIVE',
      'FEEDBACK_NEGATIVE', 'MANUAL',
    ] as const;
    for (const trigger of triggers) {
      expect(purposeOfTrigger(trigger), trigger).toBeTruthy();
    }
  });

  it('labels every purpose in words a salon owner would use', () => {
    for (const purpose of PURPOSE_ORDER) {
      const label = PURPOSE_LABELS[purpose];
      expect(label, purpose).toBeTruthy();
      // Not the enum name shouted back at them.
      expect(label, purpose).not.toBe(purpose);
    }
  });

  it('lists every purpose exactly once, so nothing is dropped from the report', () => {
    expect(new Set(PURPOSE_ORDER).size).toBe(PURPOSE_ORDER.length);
    expect(PURPOSE_ORDER.length).toBe(Object.keys(PURPOSE_LABELS).length);
  });

  it('leads with what the salon chose to send', () => {
    // Campaigns are the spend being questioned; automations are the
    // background. The order is the answer to "what am I looking at first?"
    expect(PURPOSE_ORDER[0]).toBe('CAMPAIGN');
    expect(PURPOSE_ORDER.at(-1)).toBe('OTHER');
  });
});
