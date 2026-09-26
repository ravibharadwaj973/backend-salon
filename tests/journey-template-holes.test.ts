import { describe, expect, it } from 'vitest';
import type { JourneyTrigger } from '@prisma/client';
import { DEFAULT_JOURNEYS, DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';
import { variablesIn } from '../src/messaging/template-variables';

/**
 * EVERY AUTOMATION, CHECKED AGAINST WHAT ITS TRIGGER ACTUALLY CARRIES.
 *
 * The win-back automation shipped switched on, ran nightly, raised its run
 * count, and sent nothing. Its template said "since your last {{last_service}}"
 * and last_service was only ever filled from an APPOINTMENT — which a win-back
 * has none of, because it is sent precisely BECAUSE there has not been one. So
 * every message hit the missing-variable gate and was logged SKIPPED, and the
 * salon had a retention engine that reported itself healthy while reaching
 * nobody for months.
 *
 * Nothing threw. Nothing was red. The only visible symptom was customers not
 * coming back, which every salon has anyway.
 *
 * So this test pairs each default journey step with the context its trigger
 * really carries, and fails if the template asks for anything that context
 * cannot produce. It is a spec of what each trigger brings with it as much as
 * it is a test.
 */

const TENANT = ['salon_name', 'salon_phone', 'booking_link'];

/** Resolvable for anyone on the customer table who has been billed. */
const CUSTOMER = [
  'customer_name',
  'customer_full_name',
  'points_balance',
  'total_visits',
  'last_visit_date',
  'days_since_visit',
  'last_service',
];

const LEAD = ['lead_name'];

const APPOINTMENT = [
  'appointment_date',
  'appointment_time',
  'appointment_day',
  'services',
  'staff_name',
  'branch_name',
  'branch_address',
  'feedback_link',
  'google_review_link',
];

const INVOICE = ['invoice_number', 'amount', 'due_amount', 'invoice_link', 'invoice_token', 'services', 'last_service'];

/**
 * Links that name a specific visit.
 *
 * buildVariables recovers the visit from the invoice, or failing that from the
 * customer's most recent completed appointment, so a trigger that follows a
 * real visit can use these even without an appointment id in hand.
 *
 * WITH ONE HONEST CAVEAT, which belongs here rather than in a comment nobody
 * reads: feedback is keyed to an APPOINTMENT. A salon that bills walk-ins
 * straight through the counter and never opens the appointment book has no
 * appointment to key to, and these messages will still be skipped for those
 * customers. That is a real gap, and the fix is to key feedback to the
 * invoice — not to pretend here that it is covered.
 */
const LAST_VISIT_LINKS = ['feedback_link', 'google_review_link'];
const MEMBERSHIP = ['plan_name', 'expiry_date', 'days_left'];
const PACKAGE = ['package_name', 'expiry_date', 'sessions_left'];

/**
 * What each trigger hands to buildVariables, taken from the call sites that
 * enqueue it. This is the table that was never written down, which is how the
 * mismatch survived.
 */
const CONTEXT: Record<JourneyTrigger, string[]> = {
  APPOINTMENT_BOOKED: [...TENANT, ...CUSTOMER, ...APPOINTMENT],
  APPOINTMENT_REMINDER: [...TENANT, ...CUSTOMER, ...APPOINTMENT],
  APPOINTMENT_COMPLETED: [...TENANT, ...CUSTOMER, ...APPOINTMENT],
  APPOINTMENT_CANCELLED: [...TENANT, ...CUSTOMER, ...APPOINTMENT],
  // Billing enqueues these with the invoice and no appointment.
  FIRST_VISIT: [...TENANT, ...CUSTOMER, ...INVOICE, ...LAST_VISIT_LINKS],
  INVOICE_PAID: [...TENANT, ...CUSTOMER, ...INVOICE, ...LAST_VISIT_LINKS],
  // The sweeps carry a customer id and nothing else. This is the row the
  // win-back template was quietly failing against.
  NO_VISIT_DAYS: [...TENANT, ...CUSTOMER],
  VISIT_DUE: [...TENANT, ...CUSTOMER],
  BIRTHDAY: [...TENANT, ...CUSTOMER],
  ANNIVERSARY: [...TENANT, ...CUSTOMER],
  REVIEW_REQUEST: [...TENANT, ...CUSTOMER, ...LAST_VISIT_LINKS],
  FEEDBACK_POSITIVE: [...TENANT, ...CUSTOMER, ...LAST_VISIT_LINKS],
  FEEDBACK_NEGATIVE: [...TENANT, ...CUSTOMER, ...LAST_VISIT_LINKS],
  MANUAL: [...TENANT, ...CUSTOMER],
  MEMBERSHIP_EXPIRING: [...TENANT, ...CUSTOMER, ...MEMBERSHIP],
  PACKAGE_EXPIRING: [...TENANT, ...CUSTOMER, ...PACKAGE],
  LEAD_CREATED: [...TENANT, ...LEAD],
};

describe('no default automation can send a message with a hole in it', () => {
  for (const journey of DEFAULT_JOURNEYS) {
    const config = journey.triggerConfig as { minBasis?: number };

    for (const [index, step] of journey.steps.entries()) {
      if (!step.templateName || !step.channel) continue;

      const template = DEFAULT_TEMPLATES.find(
        (t) => t.name === step.templateName && t.channel === step.channel,
      );

      it(`${journey.name} · step ${index + 1} · ${step.templateName} (${step.channel})`, () => {
        // A step pointing at a template that does not exist for its channel
        // resolves to nothing and sends nothing, just as quietly.
        expect(template, `no ${step.channel} template named ${step.templateName}`).toBeDefined();

        const available = new Set([
          ...CONTEXT[journey.trigger],
          // Whatever the step itself supplies, plus the expiry derived
          // alongside an offer.
          ...Object.keys(step.config ?? {}),
          ...(step.config?.offer || step.config?.offer_text ? ['offer_expiry'] : []),
          /**
           * The customer's own cycle is only resolvable once it is earned from
           * three intervals. A journey may use it ONLY if its trigger config
           * refuses everybody below that — which is why minBasis exists.
           */
          ...((config.minBasis ?? 0) >= 3 ? ['usual_gap', 'usual_gap_days'] : []),
        ]);

        const asked = variablesIn(template!.bodyText, template!.headerText, template!.footerText);
        const holes = asked.filter((name) => !available.has(name));

        expect(holes, `${holes.join(', ')} cannot be resolved by a ${journey.trigger} journey`).toEqual([]);
      });
    }
  }
});
