import type { JourneyTrigger, MessagePurpose } from '@prisma/client';

/**
 * WHAT A JOURNEY'S MESSAGES ARE FOR.
 *
 * A journey the salon built themselves has no notification-catalogue entry to
 * declare a purpose, but it does have a trigger, and the trigger is the honest
 * answer: a run started by REVIEW_REQUEST is sending review requests whatever
 * the step's template happens to be called.
 *
 * Exhaustive by type rather than by default — a new trigger added to the enum
 * is a compile error here, which is the point. A default arm would file every
 * future journey under "Other" and nobody would notice until a report looked
 * wrong months later.
 */
const BY_TRIGGER: Record<JourneyTrigger, MessagePurpose> = {
  APPOINTMENT_BOOKED: 'REMINDER',
  APPOINTMENT_REMINDER: 'REMINDER',
  APPOINTMENT_COMPLETED: 'FEEDBACK',
  APPOINTMENT_CANCELLED: 'REMINDER',
  FIRST_VISIT: 'FOLLOW_UP',
  INVOICE_PAID: 'BILLING',
  NO_VISIT_DAYS: 'FOLLOW_UP',
  MEMBERSHIP_EXPIRING: 'FOLLOW_UP',
  PACKAGE_EXPIRING: 'FOLLOW_UP',
  BIRTHDAY: 'FOLLOW_UP',
  ANNIVERSARY: 'FOLLOW_UP',
  LEAD_CREATED: 'FOLLOW_UP',
  REVIEW_REQUEST: 'REVIEW',
  FEEDBACK_POSITIVE: 'FEEDBACK',
  FEEDBACK_NEGATIVE: 'FEEDBACK',
  /**
   * A journey somebody starts by hand can be about anything, so this is the
   * one case where "Other" is the truthful answer rather than a gap.
   */
  MANUAL: 'OTHER',
};

export function purposeOfTrigger(trigger: JourneyTrigger): MessagePurpose {
  return BY_TRIGGER[trigger];
}

/** How each purpose is written on screen. */
export const PURPOSE_LABELS: Record<MessagePurpose, string> = {
  CAMPAIGN: 'Campaigns',
  REMINDER: 'Appointment reminders',
  BILLING: 'Invoices & payment',
  FEEDBACK: 'Feedback requests',
  REVIEW: 'Review requests',
  FOLLOW_UP: 'Follow-ups & win-backs',
  LOYALTY: 'Loyalty',
  OTHER: 'Other',
};

/** The order they read in — what the salon chose to send, then what the app sends for them. */
export const PURPOSE_ORDER: MessagePurpose[] = [
  'CAMPAIGN',
  'FOLLOW_UP',
  'REVIEW',
  'FEEDBACK',
  'REMINDER',
  'BILLING',
  'LOYALTY',
  'OTHER',
];
