import type { CampaignObjective, ConversionEvent } from '@prisma/client';

/**
 * HOW LONG A CAMPAIGN SHOULD BE GIVEN CREDIT FOR.
 *
 * The window is the whole argument. Too short and a campaign that worked looks
 * like it failed; too long and every visit a customer was going to make anyway
 * gets credited to whatever message happened to land first.
 *
 * And the right length is a property of the OBJECTIVE, not of the salon or the
 * channel. Somebody nudged about tomorrow's appointment either comes tomorrow
 * or does not; somebody being won back after eight months may take a month to
 * act on it. One fixed fortnight for both flatters the reminder and writes off
 * the win-back — which is exactly the conclusion an owner would then act on.
 *
 * These are STARTING points offered in the form, not rules. The owner can set
 * anything; the preset only fills the box, and the reason is shown next to it
 * so the number is a judgement rather than a default nobody questioned.
 */

export interface ObjectiveInfo {
  objective: CampaignObjective;
  label: string;
  /** What this kind of campaign is for, in the owner's terms. */
  description: string;
  /** Days, pre-filled when the objective is chosen. */
  suggestedWindowDays: number;
  /** Why that many days — shown beside the field. */
  rationale: string;
  /** What this kind of campaign is usually judged on. */
  suggestedEvents: ConversionEvent[];
}

export const OBJECTIVES: ObjectiveInfo[] = [
  {
    objective: 'REMINDER',
    label: 'Appointment reminder',
    description: 'Nudging someone about a booking they already have.',
    suggestedWindowDays: 2,
    rationale: 'They either come to the appointment or they do not. A visit three weeks later is a different visit.',
    suggestedEvents: ['VISIT'],
  },
  {
    objective: 'REBOOKING',
    label: 'Rebooking',
    description: 'Time for their next cut, colour or touch-up.',
    suggestedWindowDays: 14,
    rationale: 'Long enough to cover a fortnight of weekends, short enough that a routine monthly visit is not swept in.',
    suggestedEvents: ['BOOKING', 'VISIT', 'REVENUE'],
  },
  {
    objective: 'AWARENESS',
    label: 'New service or makeover',
    description: 'Telling customers about something they have not had before.',
    suggestedWindowDays: 21,
    rationale: 'Trying something new is a decision people sit on. Three weeks catches the second thought.',
    suggestedEvents: ['BOOKING', 'VISIT', 'REVENUE'],
  },
  {
    objective: 'WINBACK',
    label: 'Win-back',
    description: 'Customers who have stopped coming.',
    suggestedWindowDays: 30,
    rationale: 'Somebody who has been away for months does not return the same week. A month is the honest wait.',
    suggestedEvents: ['VISIT', 'REVENUE'],
  },
  {
    objective: 'REACTIVATION',
    label: 'Long-term reactivation',
    description: 'Customers who have been gone a year or more.',
    suggestedWindowDays: 60,
    rationale: 'The longest window here, and the one most at risk of crediting visits that were going to happen anyway — read the engagement comparison before believing the total.',
    suggestedEvents: ['VISIT', 'REVENUE'],
  },
  {
    objective: 'BIRTHDAY',
    label: 'Birthday offer',
    description: 'A greeting, usually with something attached.',
    suggestedWindowDays: 14,
    rationale: 'People redeem a birthday offer around the date rather than on it.',
    suggestedEvents: ['BOOKING', 'VISIT', 'REVENUE'],
  },
  {
    objective: 'RENEWAL',
    label: 'Membership or package renewal',
    description: 'Something they hold is about to run out.',
    suggestedWindowDays: 30,
    rationale: 'Most renewals happen close to expiry, and some just after it. Set this to the days left plus a short grace period.',
    suggestedEvents: ['BOOKING', 'REVENUE'],
  },
  {
    objective: 'FESTIVAL',
    label: 'Festival or seasonal offer',
    description: 'Diwali, wedding season, a sale.',
    suggestedWindowDays: 14,
    rationale: 'Tied to the occasion: set it to run out when the offer does, not a day later.',
    suggestedEvents: ['BOOKING', 'VISIT', 'REVENUE'],
  },
  {
    objective: 'OTHER',
    label: 'Something else',
    description: 'Anything that does not fit the list.',
    suggestedWindowDays: 14,
    rationale: 'A middling default. If you know what this campaign is for, one of the others will measure it better.',
    suggestedEvents: ['BOOKING', 'VISIT', 'REVENUE'],
  },
];

const BY_KEY = new Map(OBJECTIVES.map((o) => [o.objective, o]));

export function objectiveInfo(objective: CampaignObjective): ObjectiveInfo {
  // OTHER is the fallback rather than a throw: an objective added to the enum
  // and not yet described here should still let a campaign be sent.
  return BY_KEY.get(objective) ?? BY_KEY.get('OTHER')!;
}

/** The window choices offered, plus whatever the campaign already has. */
export const WINDOW_CHOICES = [1, 2, 3, 7, 14, 21, 30, 45, 60, 90];

export const MAX_WINDOW_DAYS = 180;

/**
 * Where a recipient's window starts.
 *
 * Delivery, not the campaign's launch and not the queue. A campaign that goes
 * out over five days would otherwise give the person reached on day five a
 * window two-fifths shorter than the first, purely because of sending order —
 * and the ones reached last would look like the ones who did not respond.
 *
 * Falling back to the send time matters for SMS, where no operator confirms
 * delivery and every recipient would otherwise have no window at all.
 */
export function windowStart(message: {
  deliveredAt?: Date | null;
  sentAt?: Date | null;
  queuedAt?: Date | null;
}): Date | null {
  return message.deliveredAt ?? message.sentAt ?? message.queuedAt ?? null;
}

export function windowEnd(start: Date, days: number): Date {
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Did this happen inside the recipient's own window? */
export function inWindow(at: Date, start: Date, end: Date): boolean {
  return at >= start && at <= end;
}

// ------------------------------------------------------------- the funnel ---

export interface CampaignFunnel {
  targeted: number;
  sent: number;
  delivered: number;
  engaged: number;
  booked: number;
  visited: number;
  revenue: number;
  cost: number;
}

/**
 * WHETHER THE CAMPAIGN DID ANYTHING, AS OPPOSED TO HAPPENING BEFOREHAND.
 *
 * This is the number that stops the whole feature being a vanity metric.
 *
 * Attributed is not the same as caused. A customer who comes every month will
 * be credited to whichever campaign last landed in their window, and a salon
 * with a healthy book can send nothing at all and still record hundreds of
 * "attributed" visits. Reported alone, the total says the campaign worked no
 * matter what the campaign was.
 *
 * So the recipients are split by whether they engaged — opened it, clicked it,
 * replied — and the two conversion rates are compared. Recipients who never
 * opened the message are the closest thing to a control group this data can
 * offer: they were chosen the same way, on the same day, by the same rule.
 *
 * If both groups convert at six per cent, the campaign changed nothing and the
 * revenue was arriving anyway. That is worth knowing and nobody would ever
 * discover it from a total.
 */
export interface Lift {
  engagedRecipients: number;
  engagedConverted: number;
  engagedRatePct: number | null;
  quietRecipients: number;
  quietConverted: number;
  quietRatePct: number | null;
  /** engaged ÷ quiet. Above 1 means engagement went with converting. */
  ratio: number | null;
  /** Whether there is enough data to say anything at all. */
  reliable: boolean;
  verdict: string;
}

/**
 * The smallest group either side that makes a ratio worth printing.
 *
 * Below this, one customer moves the rate by tens of percent and the comparison
 * says more about chance than about the campaign. Stated rather than hidden,
 * because a confident-looking "3.2× lift" computed from four people is worse
 * than no number.
 */
export const MIN_GROUP_FOR_LIFT = 30;

export function computeLift(input: {
  engagedRecipients: number;
  engagedConverted: number;
  quietRecipients: number;
  quietConverted: number;
}): Lift {
  const rate = (converted: number, total: number) =>
    total > 0 ? Math.round((converted / total) * 1000) / 10 : null;

  const engagedRatePct = rate(input.engagedConverted, input.engagedRecipients);
  const quietRatePct = rate(input.quietConverted, input.quietRecipients);
  const reliable =
    input.engagedRecipients >= MIN_GROUP_FOR_LIFT && input.quietRecipients >= MIN_GROUP_FOR_LIFT;

  const ratio =
    engagedRatePct !== null && quietRatePct !== null && quietRatePct > 0
      ? Math.round((engagedRatePct / quietRatePct) * 100) / 100
      : null;

  return {
    ...input,
    engagedRatePct,
    quietRatePct,
    ratio,
    reliable,
    verdict: verdictFor({ reliable, ratio, engagedRatePct, quietRatePct }),
  };
}

function verdictFor(input: {
  reliable: boolean;
  ratio: number | null;
  engagedRatePct: number | null;
  quietRatePct: number | null;
}): string {
  if (!input.reliable) {
    return `Too few people either side to compare — at least ${MIN_GROUP_FOR_LIFT} who opened it and ${MIN_GROUP_FOR_LIFT} who did not. The totals are still real; whether the campaign caused them is not answerable from this send.`;
  }
  if (input.ratio === null) {
    return 'Nobody who ignored the message came in, so there is nothing to compare against — which on its own is a good sign.';
  }
  if (input.ratio >= 1.5) {
    return `People who opened this came in ${input.ratio}× as often as people who did not. That is the campaign doing something.`;
  }
  if (input.ratio >= 1.15) {
    return `People who opened this came in ${input.ratio}× as often as people who did not — a real but modest difference.`;
  }
  if (input.ratio >= 0.85) {
    return 'People who opened this came in at about the same rate as people who ignored it. The visits below were most likely happening anyway.';
  }
  return 'People who ignored this came in MORE often than those who opened it, so the attributed figures below are not evidence the campaign worked.';
}
