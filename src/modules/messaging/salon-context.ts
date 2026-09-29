import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';

/**
 * EVERYTHING THE ASSISTANT IS ALLOWED TO KNOW.
 *
 * A model asked "how much is a hair spa?" will answer. If nobody told it the
 * price it will invent one, confidently, in the salon's voice, to a customer
 * who will turn up expecting to pay it. That is the whole risk of this
 * feature, and the mitigation is not a cleverer prompt — it is making sure
 * every fact the assistant could need is in front of it, and instructing it
 * to refuse rather than guess when something is not.
 *
 * So this is deliberately generous about facts and strict about scope: the
 * real menu with real prices, the real opening hours, the real address and
 * phone, the real website. Nothing derived, nothing summarised into
 * approximations, nothing about other salons.
 *
 * Capped at what fits in a prompt without crowding out the conversation. A
 * salon with 300 services gets its 60 bookable ones; the assistant is told the
 * list is partial so it offers to check rather than claiming a service does
 * not exist.
 */

const MAX_SERVICES = 60;

export interface SalonContext {
  salonName: string;
  branchName: string;
  address: string;
  phone: string;
  websiteUrl: string | null;
  bookingUrl: string | null;
  openingHours: { day: string; hours: string }[];
  services: { name: string; price: string; minutes: number }[];
  /** True when the list was cut — the assistant must not treat it as complete. */
  servicesTruncated: boolean;
  currency: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function salonContext(
  tenantId: string,
  branchId: string | null,
): Promise<SalonContext | null> {
  const [tenant, branch] = await runUnscoped(() =>
    Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          slug: true,
          phone: true,
          websiteUrl: true,
          currency: true,
          addressLine: true,
          city: true,
        },
      }),
      branchId
        ? prisma.branch.findUnique({
            where: { id: branchId },
            select: { name: true, phone: true, addressLine: true, city: true, openingHours: true },
          })
        : prisma.branch.findFirst({
            where: { tenantId, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { name: true, phone: true, addressLine: true, city: true, openingHours: true },
          }),
    ]),
  );

  if (!tenant) return null;

  const services = await runUnscoped(() =>
    prisma.service.findMany({
      // onlineBookable is the salon's own answer to "may a customer see this
      // without us in the room" — the same judgement the booking page trusts.
      where: { tenantId, isActive: true, onlineBookable: true },
      select: { name: true, price: true, durationMin: true },
      orderBy: { name: 'asc' },
      take: MAX_SERVICES + 1,
    }),
  );

  const truncated = services.length > MAX_SERVICES;

  return {
    salonName: tenant.name,
    branchName: branch?.name ?? tenant.name,
    address: [branch?.addressLine ?? tenant.addressLine, branch?.city ?? tenant.city]
      .filter(Boolean)
      .join(', '),
    phone: branch?.phone ?? tenant.phone ?? '',
    websiteUrl: tenant.websiteUrl ?? null,
    bookingUrl: tenant.websiteUrl ? `${tenant.websiteUrl.replace(/\/$/, '')}/book` : null,
    openingHours: readHours(branch?.openingHours),
    services: services.slice(0, MAX_SERVICES).map((service) => ({
      name: service.name,
      price: `${tenant.currency === 'INR' ? '₹' : ''}${Math.round(Number(service.price))}`,
      minutes: service.durationMin,
    })),
    servicesTruncated: truncated,
    currency: tenant.currency,
  };
}

/**
 * Opening hours as a person would say them.
 *
 * Stored as `{ "1": [{ open, close }], … }` keyed 0=Sunday. A closed day is an
 * empty list, and it must be SAID rather than omitted — "we are closed
 * Mondays" is one of the two or three things customers most often message to
 * ask, and a day silently missing from a list answers nothing.
 */
function readHours(raw: unknown): { day: string; hours: string }[] {
  if (!raw || typeof raw !== 'object') return [];
  const source = raw as Record<string, { open?: string; close?: string }[] | undefined>;

  return DAY_NAMES.map((day, index) => {
    const windows = source[String(index)] ?? [];
    const hours = windows
      .filter((w) => w.open && w.close)
      .map((w) => `${w.open}–${w.close}`)
      .join(', ');
    return { day, hours: hours || 'Closed' };
  });
}
