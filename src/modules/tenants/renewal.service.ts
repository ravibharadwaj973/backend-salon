import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { dayjs } from '../../core/dates';
import { logger } from '../../core/logger';
import { notifyPlatform } from '../../messaging/platform-notify';

/**
 * RENEWAL REMINDERS
 *
 * A salon should never discover its plan ended by finding the till switched
 * off mid-haircut. So it is told in advance, more than once, in plain language,
 * and the message says what happens if nothing is done — because the useful
 * part of a warning is the consequence, not the date.
 *
 * The schedule: a fortnight out, a week out, three days out, the day before,
 * and on the day it lapses.
 *
 * Deliberately not automatic suspension. Nothing here switches an account off;
 * it flags the ones that have lapsed so a person decides. A salon that has paid
 * by bank transfer and not been reconciled yet should not lose its till to a
 * cron job, and the cost of being wrong in that direction is far higher than
 * the cost of a day's delay.
 */
export const REMINDER_DAYS = [14, 7, 3, 1, 0] as const;

export type ReminderDay = (typeof REMINDER_DAYS)[number];

/** Warm, specific, and honest about what happens next. */
export function renewalMessage(salonName: string, planName: string, daysLeft: number): { subject: string; body: string } {
  if (daysLeft <= 0) {
    return {
      subject: `${salonName}: your ${planName} plan has ended`,
      body:
        `Hi ${salonName},\n\n` +
        `Your ${planName} plan ended today. Nothing has been switched off — you can still ` +
        `take bookings and raise bills as normal while we sort the renewal out.\n\n` +
        `Just reply to this message and we will send the renewal details.`,
    };
  }

  const when = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return {
    subject: `${salonName}: your ${planName} plan renews ${when}`,
    body:
      `Hi ${salonName},\n\n` +
      `A quick heads-up: your ${planName} plan is up for renewal ${when}.\n\n` +
      `Nothing changes today, and nothing stops working on the day — we will always talk to ` +
      `you first. This is just so the date does not take you by surprise in the middle of a ` +
      `busy Saturday.\n\n` +
      `Reply to this message whenever you are ready and we will sort the renewal out.`,
  };
}

interface DueSubscription {
  tenantId: string;
  tenantName: string;
  tenantEmail: string;
  planName: string;
  currentPeriodEnd: Date;
  daysLeft: number;
}

/**
 * Subscriptions whose period ends on one of the reminder days, counted in whole
 * days so a renewal at 23:00 and one at 01:00 are treated the same.
 */
export async function subscriptionsDueForReminder(now = new Date()): Promise<DueSubscription[]> {
  const today = dayjs(now).startOf('day');
  // One query for the whole window rather than five; the day is worked out here.
  const horizon = today.add(Math.max(...REMINDER_DAYS), 'day').endOf('day').toDate();

  const rows = await runUnscoped(() =>
    prisma.tenantSubscription.findMany({
      where: {
        isActive: true,
        currentPeriodEnd: { lte: horizon },
        tenant: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      },
      select: {
        tenantId: true,
        planCode: true,
        currentPeriodEnd: true,
        tenant: { select: { name: true, email: true, plan: { select: { name: true } } } },
      },
    }),
  );

  return rows
    .map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      tenantEmail: row.tenant.email,
      planName: row.tenant.plan?.name ?? row.planCode,
      currentPeriodEnd: row.currentPeriodEnd,
      daysLeft: dayjs(row.currentPeriodEnd).startOf('day').diff(today, 'day'),
    }))
    .filter((row) => (REMINDER_DAYS as readonly number[]).includes(row.daysLeft));
}

/**
 * Send today's reminders. Idempotent per tenant per milestone: the sent marker
 * is written before the send is attempted, so a worker restart mid-sweep does
 * not mail the same salon twice. A missed reminder is a smaller problem than a
 * duplicate one.
 */
export async function sendRenewalReminders(now = new Date()) {
  const due = await subscriptionsDueForReminder(now);
  let sent = 0;
  let skipped = 0;

  for (const row of due) {
    const key = `renewal_reminder:${row.daysLeft}:${dayjs(row.currentPeriodEnd).format('YYYY-MM-DD')}`;

    const already = await runUnscoped(() =>
      prisma.setting.findFirst({ where: { tenantId: row.tenantId, key, branchId: null } }),
    );
    if (already) {
      skipped += 1;
      continue;
    }

    await runUnscoped(() =>
      prisma.setting.create({
        data: { tenantId: row.tenantId, branchId: null, key, value: { sentAt: new Date().toISOString() } },
      }),
    );

    const { subject, body } = renewalMessage(row.tenantName, row.planName, row.daysLeft);
    try {
      await notifyPlatform({ to: row.tenantEmail, subject, body, tenantId: row.tenantId });
      sent += 1;
    } catch (error) {
      logger.error({ err: error, tenantId: row.tenantId }, 'renewal reminder failed to send');
    }
  }

  return { due: due.length, sent, skipped };
}

/**
 * Salons whose plan has run out. Reported, never acted on — switching an
 * account off is a decision a person makes in the console, with the salon's
 * payment history in front of them.
 */
export async function lapsedTenants(now = new Date()) {
  const today = dayjs(now).startOf('day');

  const rows = await runUnscoped(() =>
    prisma.tenantSubscription.findMany({
      where: {
        isActive: true,
        currentPeriodEnd: { lt: today.toDate() },
        tenant: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      },
      select: {
        tenantId: true,
        currentPeriodEnd: true,
        planCode: true,
        tenant: { select: { name: true, status: true } },
      },
      orderBy: { currentPeriodEnd: 'asc' },
    }),
  );

  return rows.map((row) => ({
    tenantId: row.tenantId,
    name: row.tenant.name,
    status: row.tenant.status,
    planCode: row.planCode,
    endedAt: row.currentPeriodEnd,
    daysOverdue: today.diff(dayjs(row.currentPeriodEnd).startOf('day'), 'day'),
  }));
}
