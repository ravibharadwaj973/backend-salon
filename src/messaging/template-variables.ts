/**
 * The one definition of what a placeholder looks like.
 *
 * It lives here rather than in the dispatcher so that this module stays pure —
 * importing the dispatcher would drag in Prisma, the job queue and three
 * providers, and the only thing needed from it was a regex. The dependency runs
 * the other way now.
 */
export const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * WHICH OF A TEMPLATE'S BLANKS CAN BE FILLED, AND BY WHOM.
 *
 * This exists because of a campaign called "test-utilty" that reported success,
 * charged nothing, and sent nothing. Every message was skipped with the same
 * reason:
 *
 *   appointment_date had no value, so the customer would have read a blank
 *
 * The template was `appointment_cancelled`. It needs an appointment. A campaign
 * has a segment, and a segment is a list of people — there is no appointment
 * anywhere in it, and there never could be. So the send was doomed before it
 * started, and nothing said so until it was over.
 *
 * A template's blanks fall into three kinds, and the difference is not cosmetic:
 *
 *   AUTOMATIC   filled per customer from what a campaign already knows — their
 *               name, the salon's name, their points balance. Nobody types
 *               these; each recipient gets their own.
 *
 *   FILL IN     the app cannot know them, but the sender can: an offer, a date
 *               the salon is closed, a discount code. One value typed once,
 *               the same for everyone in the send. This is the kind the app had
 *               no way to accept, which is why the campaign failed.
 *
 *   BLOCKED     addresses one specific record — an invoice link, a feedback
 *               link, a bill number. These must NEVER be typed for a whole
 *               campaign, and the reason is not tidiness: one typed
 *               {{invoice_link}} sent to four hundred people gives four hundred
 *               strangers the same customer's bill. That is a data leak, so it
 *               is refused rather than warned about.
 */

/**
 * Filled from the tenant and the customer, which is all a campaign has.
 *
 * Kept as an explicit list rather than derived from buildVariables, because the
 * two answer different questions: buildVariables says what CAN be resolved
 * given a full context, and this says what a CAMPAIGN can resolve. Deriving one
 * from the other is how invoice_number ends up looking automatic.
 */
export const AUTOMATIC_IN_CAMPAIGN = new Set([
  'salon_name',
  'salon_phone',
  'booking_link',
  'customer_name',
  'customer_full_name',
  'points_balance',
  'total_visits',
  'last_visit_date',
  'days_since_visit',
]);

/**
 * Variables that point at one record and must not be shared across a send.
 *
 * Every one of these either identifies a document or unlocks a page. A single
 * value standing in for all recipients is a customer's bill, or their feedback
 * form, handed to everybody else on the list.
 */
export const PER_RECORD = new Set([
  'invoice_link',
  'invoice_token',
  'invoice_number',
  'feedback_link',
  'google_review_link',
]);

export type VariableKind = 'AUTOMATIC' | 'FILL_IN' | 'BLOCKED';

export interface VariableInfo {
  name: string;
  kind: VariableKind;
  /** What the sender is being asked for, in their words. */
  label: string;
  /** Why it is blocked, when it is. */
  reason?: string;
  /** Something plausible, so an empty box is not the only guidance. */
  example?: string;
}

/** Human wording for the variables this app knows about. */
const LABELS: Record<string, { label: string; example?: string }> = {
  appointment_date: { label: 'Appointment date', example: '12 Oct 2026' },
  appointment_time: { label: 'Appointment time', example: '4:30 PM' },
  appointment_day: { label: 'Day of the week', example: 'Saturday' },
  services: { label: 'Services', example: 'Haircut, Head massage' },
  staff_name: { label: 'Stylist', example: 'Priya' },
  branch_name: { label: 'Branch', example: 'Connaught Place' },
  branch_address: { label: 'Branch address', example: '12 Janpath, New Delhi' },
  amount: { label: 'Amount', example: '₹1,200' },
  due_amount: { label: 'Amount due', example: '₹400' },
  expiry_date: { label: 'Expiry date', example: '31 Oct 2026' },
  days_left: { label: 'Days left', example: '7' },
  plan_name: { label: 'Membership plan', example: 'Gold' },
  package_name: { label: 'Package', example: 'Bridal package' },
  sessions_left: { label: 'Sessions left', example: '3' },
  last_service: { label: 'Last service', example: 'Haircut' },
  offer: { label: 'Offer', example: '20% off all colour services' },
  discount: { label: 'Discount', example: '20%' },
  valid_till: { label: 'Valid until', example: '31 Oct 2026' },
  code: { label: 'Coupon code', example: 'DIWALI20' },
};

/** "appointment_date" -> "Appointment date", for anything not in the table. */
function humanise(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every variable a template body (and heading, and buttons) refers to. */
export function variablesIn(...parts: (string | null | undefined)[]): string[] {
  const found: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(VARIABLE_PATTERN)) found.push(match[1]!);
  }
  return [...new Set(found)];
}

/**
 * Sort a template's variables into the three kinds, for a campaign send.
 *
 * Order within the result is the order they appear in the template, so the form
 * the sender fills in reads in the same order as the message they are sending.
 */
export function classifyForCampaign(...parts: (string | null | undefined)[]): VariableInfo[] {
  return variablesIn(...parts).map((name) => {
    const meta = LABELS[name];
    const label = meta?.label ?? humanise(name);

    if (AUTOMATIC_IN_CAMPAIGN.has(name)) {
      return { name, kind: 'AUTOMATIC', label };
    }
    if (PER_RECORD.has(name)) {
      return {
        name,
        kind: 'BLOCKED',
        label,
        reason:
          `${label} belongs to one customer's own record. A campaign would have to send every recipient the same one, ` +
          'which means giving one customer’s details to everybody on the list. Use this template from an automation instead, ' +
          'where each message is built for the person receiving it.',
      };
    }
    return { name, kind: 'FILL_IN', label, example: meta?.example };
  });
}

export interface CampaignReadiness {
  ok: boolean;
  automatic: VariableInfo[];
  fillIn: VariableInfo[];
  blocked: VariableInfo[];
  /** Fill-in variables with no value supplied yet. */
  missing: VariableInfo[];
}

/**
 * Can this template be sent as a campaign, with these values?
 *
 * Answered before the send rather than during it. The old behaviour was to
 * discover it four hundred times, once per skipped message, after the owner had
 * been told the campaign was away.
 */
export function campaignReadiness(
  parts: (string | null | undefined)[],
  values: Record<string, string> = {},
): CampaignReadiness {
  const all = classifyForCampaign(...parts);
  const fillIn = all.filter((v) => v.kind === 'FILL_IN');
  const blocked = all.filter((v) => v.kind === 'BLOCKED');
  // Blank and whitespace both count as missing: a space would satisfy a
  // truthiness check and still print as a hole in the message.
  const missing = fillIn.filter((v) => !(values[v.name] ?? '').trim());

  return {
    ok: blocked.length === 0 && missing.length === 0,
    automatic: all.filter((v) => v.kind === 'AUTOMATIC'),
    fillIn,
    blocked,
    missing,
  };
}

/** One sentence saying what is wrong, for an error the sender will actually read. */
export function readinessProblem(readiness: CampaignReadiness): string | null {
  if (readiness.blocked.length) {
    return readiness.blocked[0]!.reason!;
  }
  if (readiness.missing.length) {
    const names = readiness.missing.map((v) => v.label);
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    return (
      `This template needs ${list} filled in before it can be sent. ` +
      'Without it every recipient would read a blank where the value should be, so nothing would go out.'
    );
  }
  return null;
}
