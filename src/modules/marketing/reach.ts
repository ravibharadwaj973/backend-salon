import type { Channel, ConsentStatus, Prisma, TemplateCategory } from '@prisma/client';
import { consentAllows } from '../../messaging/dispatcher';

/**
 * WHO A SEGMENT CAN ACTUALLY BE SENT TO, CHANNEL BY CHANNEL.
 *
 * A segment's size is one number, but a campaign's size is three different
 * numbers, and none of them is the one on the segment card. "2,400 customers"
 * sends 2,400 WhatsApp messages, about 900 emails, and however many have a
 * phone number for SMS — because reachability needs two things the segment
 * rules never asked about:
 *
 *   an address on that channel, and consent for that channel.
 *
 * Showing the segment total before a send is how a salon budgets for 2,400
 * messages and sends 900, or promises the owner a reach it cannot deliver.
 *
 * Consent is read the same way the dispatcher reads it at send time, so the
 * number shown before the send is the number that goes out: marketing needs a
 * positive opt-in, anything else needs only the absence of an opt-out.
 */

export const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;

/** One channel's split of a segment, for one template category. */
export interface ChannelReach {
  /** Will be sent. */
  reachable: number;
  /** Has no phone number / email address at all. */
  noAddress: number;
  /** Has an address but consent forbids this category on this channel. */
  noConsent: number;
}

export type Reach = Record<Channel, ChannelReach>;

/** The contact and consent columns reachability needs, and nothing else. */
export interface ContactRow {
  phone: string;
  email: string | null;
  whatsappConsent: ConsentStatus;
  smsConsent: ConsentStatus;
  emailConsent: ConsentStatus;
}

export const CONTACT_SELECT = {
  phone: true,
  email: true,
  whatsappConsent: true,
  smsConsent: true,
  emailConsent: true,
} as const;

/** True when this person has something to be reached at on this channel. */
export function hasAddress(row: ContactRow, channel: Channel): boolean {
  return channel === 'EMAIL' ? Boolean(row.email?.trim()) : Boolean(row.phone?.trim());
}

export function consentOn(row: ContactRow, channel: Channel): ConsentStatus {
  if (channel === 'EMAIL') return row.emailConsent;
  if (channel === 'SMS') return row.smsConsent;
  return row.whatsappConsent;
}

/** Split one channel three ways. The three always sum to the row count. */
export function reachOf(rows: ContactRow[], channel: Channel, category: TemplateCategory): ChannelReach {
  let reachable = 0;
  let noAddress = 0;
  let noConsent = 0;

  for (const row of rows) {
    if (!hasAddress(row, channel)) noAddress += 1;
    else if (!consentAllows(category, consentOn(row, channel))) noConsent += 1;
    else reachable += 1;
  }

  return { reachable, noAddress, noConsent };
}

/** Every channel at once, for a set of rows already in memory. */
export function reachAll(rows: ContactRow[], category: TemplateCategory): Reach {
  return Object.fromEntries(CHANNELS.map((channel) => [channel, reachOf(rows, channel, category)])) as Reach;
}

/**
 * The same three numbers, counted in the database.
 *
 * Used when the segment has no in-memory rule and could be any size — nine
 * counts against an indexed table beat pulling a hundred thousand rows over
 * to count them here.
 */
export async function reachAllInDb(
  client: { customer: { count: (args: { where: Prisma.CustomerWhereInput }) => Promise<number> } },
  where: Prisma.CustomerWhereInput,
  category: TemplateCategory,
): Promise<Reach> {
  const addressed = (channel: Channel): Prisma.CustomerWhereInput =>
    channel === 'EMAIL'
      ? { email: { not: null }, NOT: { email: '' } }
      : { NOT: { phone: '' } };

  const consentField = (channel: Channel) =>
    channel === 'EMAIL' ? 'emailConsent' : channel === 'SMS' ? 'smsConsent' : 'whatsappConsent';

  // Marketing needs OPTED_IN; everything else needs only "not OPTED_OUT".
  const consentOk = (channel: Channel): Prisma.CustomerWhereInput =>
    category === 'MARKETING'
      ? { [consentField(channel)]: 'OPTED_IN' }
      : { [consentField(channel)]: { not: 'OPTED_OUT' } };

  const entries = await Promise.all(
    CHANNELS.map(async (channel) => {
      const [total, withAddress, reachable] = await Promise.all([
        client.customer.count({ where }),
        client.customer.count({ where: { AND: [where, addressed(channel)] } }),
        client.customer.count({ where: { AND: [where, addressed(channel), consentOk(channel)] } }),
      ]);
      return [
        channel,
        { reachable, noAddress: total - withAddress, noConsent: withAddress - reachable },
      ] as const;
    }),
  );

  return Object.fromEntries(entries) as Reach;
}
