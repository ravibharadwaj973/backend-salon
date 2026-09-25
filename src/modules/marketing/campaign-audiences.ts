import type { CampaignAudience } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { windowStart } from './attribution';

/**
 * A CAMPAIGN'S RECIPIENTS ARE NOT ONE AUDIENCE. THEY ARE SIX.
 *
 * After a send, "the people I messaged" is the least useful way to think about
 * a thousand customers. Somebody who tapped the button and did not book is
 * interested and hesitating. Somebody the message never reached has a wrong
 * number. Sending both the same "still thinking about it?" annoys the first and
 * wastes a message on the second, and the salon learns nothing from either.
 *
 * ── Live rules, not frozen lists ──────────────────────────────────────────
 *
 * Every group here is computed WHEN IT IS USED, never copied out when it is
 * defined. That single decision is what makes "stop following up once they
 * book" work with no stop-the-follow-up machinery anywhere:
 *
 *   Thursday: schedule a follow-up to "read but has not booked" — 320 people
 *   Friday:   14 of them book
 *   Monday:   the follow-up sends to 306
 *
 * The 14 are not excluded by a rule that remembers to exclude them. They are
 * simply not in the group any more. A copied list would have messaged all 320,
 * including fourteen people who had already done the thing being asked for.
 *
 * ── Computed live, not read from attribution ──────────────────────────────
 *
 * Bookings and visits are also read fresh rather than from the campaign's
 * stored attribution, because attribution only runs once the window CLOSES.
 * A day-3 follow-up on a 21-day campaign would otherwise see zeros for
 * everything and treat every recipient as unconverted — which is exactly
 * backwards, since the people who converted fastest are the ones it would
 * pester first.
 *
 * ── What these states are, and are not ────────────────────────────────────
 *
 * "Read but did not book" is a CRM state, not a finding about anybody's
 * intentions. A blue tick means a device fetched the message; it does not mean
 * a person read it, still less that they read it and decided against coming.
 * The labels below say what was observed and nothing more, because a salon
 * acting on "they saw it and said no" behaves differently — and worse — than
 * one acting on "we have no idea whether this landed".
 */

export interface AudienceInfo {
  audience: CampaignAudience;
  label: string;
  /** What is actually known about these people. */
  meaning: string;
  /** What a salon would sensibly do next. */
  suggestion: string;
  /** False where a follow-up message is the wrong answer. */
  followUpSensible: boolean;
}

export const AUDIENCES: AudienceInfo[] = [
  {
    audience: 'NOT_DELIVERED',
    label: 'Never arrived',
    meaning: 'The message did not reach them at all — usually a wrong number or an address that no longer exists.',
    suggestion: 'Fix the number or address on their profile. Sending the same message again on the same channel will fail the same way.',
    followUpSensible: false,
  },
  {
    audience: 'DELIVERED_NOT_READ',
    label: 'Arrived, no sign of a read',
    meaning:
      'It was delivered and nothing has happened since. On WhatsApp that means no blue ticks, which is weaker evidence than it looks — read receipts can be switched off.',
    suggestion: 'Worth one more attempt, or the same message on a different channel. Do not assume they chose to ignore it.',
    followUpSensible: true,
  },
  {
    audience: 'READ_NOT_ENGAGED',
    label: 'Read it, did nothing',
    meaning: 'It was opened. Nothing was tapped and nothing was booked.',
    suggestion: 'The biggest group and usually the most worthwhile follow-up: they know about the offer and have not acted.',
    followUpSensible: true,
  },
  {
    audience: 'ENGAGED_NOT_BOOKED',
    label: 'Tapped, did not book',
    meaning: 'They clicked a button or a link and stopped short of booking.',
    suggestion: 'The warmest group that has not converted. Something got in the way — a time, a price, a question. A follow-up that offers help beats one that repeats the offer.',
    followUpSensible: true,
  },
  {
    audience: 'BOOKED_NOT_VISITED',
    label: 'Booked, not been in yet',
    meaning: 'They have an appointment from this campaign and have not attended it yet.',
    suggestion: 'Do not sell to these. A reminder close to the appointment is what protects the booking; another offer reads as though you have forgotten they said yes.',
    followUpSensible: false,
  },
  {
    audience: 'VISITED',
    label: 'Came in',
    meaning: 'They visited inside the window and were billed.',
    suggestion: 'The campaign worked on these. They belong in a thank-you or a rebooking campaign, not in this one’s follow-ups.',
    followUpSensible: false,
  },
];

const BY_KEY = new Map(AUDIENCES.map((a) => [a.audience, a]));

export function audienceInfo(audience: CampaignAudience): AudienceInfo | null {
  return BY_KEY.get(audience) ?? null;
}

/** One recipient, reduced to the facts the states are decided by. */
interface Outcome {
  customerId: string;
  delivered: boolean;
  read: boolean;
  engaged: boolean;
  booked: boolean;
  visited: boolean;
}

/**
 * The state a recipient is in — the FURTHEST they got, not every box they tick.
 *
 * Checked from the far end backwards, so each person lands in exactly one
 * group. Somebody who read, clicked, booked and came in is only in "Came in";
 * listing them in four groups would mean a follow-up to "read but did not
 * book" reaching people who are already sitting in the chair.
 */
export function stateOf(outcome: Outcome): CampaignAudience {
  if (outcome.visited) return 'VISITED';
  if (outcome.booked) return 'BOOKED_NOT_VISITED';
  if (outcome.engaged) return 'ENGAGED_NOT_BOOKED';
  if (outcome.read) return 'READ_NOT_ENGAGED';
  if (outcome.delivered) return 'DELIVERED_NOT_READ';
  return 'NOT_DELIVERED';
}

/**
 * Every recipient of a campaign, sorted into their current state.
 *
 * Three queries regardless of how many were messaged: the recipients, then
 * their appointments, then their invoices. Doing it per recipient would be a
 * thousand round trips on a thousand-person campaign, on a screen somebody
 * opens to decide what to do next.
 */
export async function campaignOutcomes(campaignId: string): Promise<Map<CampaignAudience, string[]>> {
  const campaign = await runUnscoped(() => prisma.campaign.findUnique({ where: { id: campaignId } }));
  const grouped = new Map<CampaignAudience, string[]>();
  for (const info of AUDIENCES) grouped.set(info.audience, []);
  if (!campaign) return grouped;

  const messages = await runUnscoped(() =>
    prisma.messageLog.findMany({
      where: { campaignId, customerId: { not: null } },
      select: {
        customerId: true,
        status: true,
        queuedAt: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        clickedAt: true,
        repliedAt: true,
      },
    }),
  );
  if (!messages.length) return grouped;

  /**
   * Each recipient's own window, and the earliest of them so one query can
   * cover everybody. A campaign sent over five days has five different
   * windows, and using the campaign's own start for all of them would credit
   * the last recipients with things that happened before they were messaged.
   */
  const windows = new Map<string, { from: Date; to: Date }>();
  let earliest: Date | null = null;

  for (const message of messages) {
    if (!message.customerId) continue;
    const from = windowStart(message);
    if (!from) continue;
    const to = new Date(from.getTime() + campaign.attributionWindowDays * 24 * 60 * 60 * 1000);
    // A customer messaged twice by one campaign keeps their earliest window.
    const existing = windows.get(message.customerId);
    if (!existing || from < existing.from) windows.set(message.customerId, { from, to });
    if (!earliest || from < earliest) earliest = from;
  }

  const customerIds = [...windows.keys()];
  if (!customerIds.length || !earliest) return grouped;

  const [appointments, invoices] = await Promise.all([
    runUnscoped(() =>
      prisma.appointment.findMany({
        where: { customerId: { in: customerIds }, createdAt: { gte: earliest! }, status: { not: 'CANCELLED' } },
        select: { customerId: true, createdAt: true },
      }),
    ),
    runUnscoped(() =>
      prisma.invoice.findMany({
        where: { customerId: { in: customerIds }, invoiceDate: { gte: earliest! }, status: { not: 'VOID' } },
        select: { customerId: true, invoiceDate: true },
      }),
    ),
  ]);

  // Only events inside that person's OWN window count, which is why the broad
  // query above is narrowed here rather than in SQL.
  const booked = new Set<string>();
  for (const appointment of appointments) {
    const w = appointment.customerId ? windows.get(appointment.customerId) : null;
    if (w && appointment.createdAt >= w.from && appointment.createdAt <= w.to) booked.add(appointment.customerId!);
  }

  const visited = new Set<string>();
  for (const invoice of invoices) {
    const w = invoice.customerId ? windows.get(invoice.customerId) : null;
    if (w && invoice.invoiceDate >= w.from && invoice.invoiceDate <= w.to) visited.add(invoice.customerId!);
  }

  const seen = new Set<string>();
  for (const message of messages) {
    const customerId = message.customerId;
    if (!customerId || seen.has(customerId)) continue;
    seen.add(customerId);

    const state = stateOf({
      customerId,
      // SKIPPED and FAILED never arrived, whatever else the row says.
      delivered:
        message.status !== 'SKIPPED' &&
        message.status !== 'FAILED' &&
        message.status !== 'BOUNCED' &&
        Boolean(message.deliveredAt ?? message.readAt ?? message.clickedAt),
      read: Boolean(message.readAt ?? message.clickedAt ?? message.repliedAt),
      engaged: Boolean(message.clickedAt ?? message.repliedAt),
      booked: booked.has(customerId),
      visited: visited.has(customerId),
    });

    grouped.get(state)!.push(customerId);
  }

  return grouped;
}

/** The counts a campaign page shows, in the order the funnel runs. */
export async function campaignAudienceCounts(campaignId: string) {
  const grouped = await campaignOutcomes(campaignId);
  return AUDIENCES.map((info) => ({
    ...info,
    count: grouped.get(info.audience)?.length ?? 0,
  }));
}

/** Who a follow-up would go to, resolved now. */
export async function resolveFollowUpMembers(
  sourceCampaignId: string,
  audience: CampaignAudience,
): Promise<string[]> {
  const grouped = await campaignOutcomes(sourceCampaignId);
  return grouped.get(audience) ?? [];
}
