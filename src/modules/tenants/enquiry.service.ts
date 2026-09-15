import type { EnquiryStatus, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { dayjs } from '../../core/dates';
import { logger } from '../../core/logger';
import { notifyPlatform } from '../../messaging/platform-notify';

/**
 * ENQUIRIES — salons that asked to hear from you.
 *
 * The marketing site collects a name and a number, and stops. No password, no
 * account, nothing provisioned. That is the point: a salon owner deciding
 * whether to change the software their business runs on wants a conversation,
 * not a sign-up form — and you want to have spoken to them before they are a
 * tenant in your database.
 *
 * Nothing here creates a salon. Converting an enquiry is a separate, deliberate
 * act in the console.
 */

export interface EnquiryInput {
  salonName: string;
  contactName: string;
  email: string;
  phone: string;
  city?: string;
  size?: string;
  message?: string;
  source?: string;
}

export async function createEnquiry(input: EnquiryInput) {
  const enquiry = await runUnscoped(() =>
    prisma.enquiry.create({
      data: {
        salonName: input.salonName,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        city: input.city ?? null,
        size: input.size ?? null,
        message: input.message ?? null,
        source: input.source ?? null,
      },
    }),
  );

  // Tell the operator straight away. An enquiry that sits unread for a day is
  // a salon that has already rung somebody else.
  void alertOperator(enquiry).catch((error) =>
    logger.error({ err: error, enquiryId: enquiry.id }, 'enquiry alert failed'),
  );

  return enquiry;
}

async function alertOperator(enquiry: { id: string; salonName: string; contactName: string; phone: string; email: string; city: string | null; size: string | null; message: string | null }) {
  const to = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@parlon.in';
  await notifyPlatform({
    to,
    subject: `New enquiry: ${enquiry.salonName}`,
    body:
      `${enquiry.contactName} from ${enquiry.salonName} would like to hear from you.\n\n` +
      `Phone:  ${enquiry.phone}\n` +
      `Email:  ${enquiry.email}\n` +
      (enquiry.city ? `City:   ${enquiry.city}\n` : '') +
      (enquiry.size ? `Size:   ${enquiry.size}\n` : '') +
      (enquiry.message ? `\nThey said:\n${enquiry.message}\n` : '') +
      `\nOpen it in the console to mark it contacted.`,
  });
}

export interface ListEnquiriesInput {
  page?: number;
  pageSize?: number;
  status?: EnquiryStatus;
  q?: string;
}

export async function listEnquiries(input: ListEnquiriesInput) {
  const { skip, take, page, pageSize } = pageParams(input);
  const q = input.q?.trim();

  const where: Prisma.EnquiryWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(q
      ? {
          OR: [
            { salonName: { contains: q, mode: 'insensitive' as const } },
            { contactName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { phone: { contains: q } },
            { city: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [items, total, counts] = await runUnscoped(() =>
    Promise.all([
      // Newest first: the one that came in this morning is the one to ring.
      prisma.enquiry.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      prisma.enquiry.count({ where }),
      prisma.enquiry.groupBy({ by: ['status'], _count: { _all: true } }),
    ]),
  );

  return {
    items,
    total,
    page,
    pageSize,
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
  };
}

export async function getEnquiry(id: string) {
  const enquiry = await runUnscoped(() => prisma.enquiry.findUnique({ where: { id } }));
  if (!enquiry) throw NotFound('Enquiry');
  return enquiry;
}

export interface UpdateEnquiryInput {
  status?: EnquiryStatus;
  notes?: string;
}

export async function updateEnquiry(id: string, input: UpdateEnquiryInput) {
  await getEnquiry(id);

  return runUnscoped(() =>
    prisma.enquiry.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
        // Stamped the first time it leaves NEW, so "how fast do we reply?" is
        // answerable without a separate audit trail.
        ...(input.status && input.status !== 'NEW' ? { contactedAt: new Date() } : {}),
      },
    }),
  );
}

/** Link an enquiry to the salon it became. Called after provisioning. */
export async function markConverted(id: string, tenantId: string) {
  return runUnscoped(() =>
    prisma.enquiry.update({
      where: { id },
      data: { status: 'WON', convertedTenantId: tenantId, convertedAt: new Date() },
    }),
  );
}

/** The numbers on the console's front page. */
export async function enquiryStats() {
  const weekAgo = dayjs().subtract(7, 'day').toDate();

  const [open, newThisWeek, wonThisMonth] = await runUnscoped(() =>
    Promise.all([
      prisma.enquiry.count({ where: { status: { in: ['NEW', 'CONTACTED', 'DEMO_BOOKED'] } } }),
      prisma.enquiry.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.enquiry.count({
        where: { status: 'WON', convertedAt: { gte: dayjs().startOf('month').toDate() } },
      }),
    ]),
  );

  return { open, newThisWeek, wonThisMonth };
}
