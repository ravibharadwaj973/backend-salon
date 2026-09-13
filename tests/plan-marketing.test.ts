import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  GROWTH_FEATURES,
  PILOT_FEATURES,
  PRO_FEATURES,
  STARTER_FEATURES,
  featureMap,
  hasFeature,
} from '../src/core/features';
import { DEFAULT_JOURNEYS, DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';

/**
 * Starter runs the salon; it does not market for it. These tests are the rule,
 * written down — a feature quietly added back to the Starter list should fail
 * here rather than surface as a salon sending offers it never paid for.
 */
describe('Starter has no marketing', () => {
  it('does not include the marketing switch', () => {
    expect(STARTER_FEATURES).not.toContain(FEATURES.MARKETING);
    expect(hasFeature(featureMap(STARTER_FEATURES), FEATURES.MARKETING)).toBe(false);
  });

  it('does not include campaigns, segments or the campaign library', () => {
    for (const feature of [
      FEATURES.CAMPAIGNS,
      FEATURES.CUSTOM_CAMPAIGNS,
      FEATURES.PREBUILT_CAMPAIGNS,
      FEATURES.CAMPAIGN_ANALYTICS,
      FEATURES.SEGMENTS,
    ]) {
      expect(STARTER_FEATURES, feature).not.toContain(feature);
    }
  });

  it('keeps automation, because a reminder is not an advert', () => {
    // Appointment confirmations, reminders, the bill and the feedback ask are
    // UTILITY messages the customer asked for by booking. Starter still sends
    // those; that is most of what the plan is for.
    expect(STARTER_FEATURES).toContain(FEATURES.AUTOMATION);
  });
});

describe('the plans above it do include marketing', () => {
  it('Grow and Pro both carry the switch', () => {
    expect(GROWTH_FEATURES).toContain(FEATURES.MARKETING);
    expect(PRO_FEATURES).toContain(FEATURES.MARKETING);
  });

  it('so does the pilot — a trial should show the whole product', () => {
    expect(PILOT_FEATURES).toContain(FEATURES.MARKETING);
  });

  it('every Starter feature survives into Grow', () => {
    for (const feature of STARTER_FEATURES) {
      expect(GROWTH_FEATURES, feature).toContain(feature);
    }
  });
});

describe('what the gate actually catches', () => {
  const categoryOf = new Map(DEFAULT_TEMPLATES.map((t) => [t.name, t.category]));
  const marketing = (name: string) => categoryOf.get(name) === 'MARKETING';

  it('cuts on the line between servicing a booking and advertising', () => {
    // What a customer who just booked or just left is owed, and still gets on
    // Starter — including the whole Feedback & Reviews flow, because "how was
    // it?" is a service message, not an advert.
    for (const name of [
      'appointment_confirmation',
      'appointment_reminder_24h',
      'appointment_reminder_2h',
      'appointment_cancelled',
      'invoice_sent',
      'payment_reminder',
      'thank_you',
      'review_request',
      'google_review_request',
      'feedback_apology',
      'membership_expiring',
      'package_expiring',
    ]) {
      expect(marketing(name), `${name} should be utility`).toBe(false);
    }

    // What the plan does not buy.
    for (const name of ['rebooking_reminder', 'winback_offer', 'birthday_wish', 'lead_welcome']) {
      expect(marketing(name), `${name} should be marketing`).toBe(true);
    }
  });

  it('leaves both kinds of seeded journey, so the gate is neither pointless nor total', () => {
    const sends = (journey: (typeof DEFAULT_JOURNEYS)[number]) =>
      journey.steps.map((step) => ('templateName' in step ? (step.templateName as string) : ''));

    const blocked = DEFAULT_JOURNEYS.filter((journey) => sends(journey).some(marketing));
    const surviving = DEFAULT_JOURNEYS.filter((journey) => !sends(journey).some(marketing));

    expect(blocked.length).toBeGreaterThan(0);
    expect(surviving.length).toBeGreaterThan(0);

    // Named rather than counted: these three are what a Starter salon is
    // paying for, and a change that moves any of them is worth noticing.
    const names = surviving.map((journey) => journey.name);
    expect(names).toContain('Booking confirmation');
    expect(names).toContain('Happy customer to Google');
    expect(names).toContain('Unhappy customer recovery');
  });
});
