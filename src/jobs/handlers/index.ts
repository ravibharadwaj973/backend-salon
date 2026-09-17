import type { Job, JourneyTrigger } from '@prisma/client';
import * as notifications from '../../messaging/notifications';
import { prisma } from '../../core/prisma';
import { runAsTenant, runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { addDays, dayjs, startOfDay, endOfDay } from '../../core/dates';
import { enqueue, type JobType } from '../queue';
import { deliver, queueMessage } from '../../messaging/dispatcher';
import * as journeys from '../../modules/marketing/journey.service';
import * as campaigns from '../../modules/marketing/campaign.service';
import * as appointments from '../../modules/appointments/appointment.service';
import * as customers from '../../modules/customers/customer.service';
import * as memberships from '../../modules/memberships/membership.service';
import * as packages from '../../modules/packages/package.service';
import * as loyalty from '../../modules/loyalty/loyalty.service';
import * as gamification from '../../modules/gamification/gamification.service';
import * as alerts from '../../modules/analytics/alerts.service';
import { pruneAudit } from '../../modules/audit/audit.service';
import * as renewals from '../../modules/tenants/renewal.service';

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<unknown>;

/** Every active tenant, for the nightly sweeps. */
async function activeTenantIds(): Promise<string[]> {
  const tenants = await runUnscoped(() =>
    prisma.tenant.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } }, select: { id: true } }),
  );
  return tenants.map((t) => t.id);
}

const handlers: Record<JobType, JobHandler> = {
  // -------------------------------------------------------------- journeys --
  'journey.trigger': async (payload) => {
    const tenantId = (payload.tenantId as string | undefined) ?? null;
    const customerId = (payload.customerId as string | undefined) ?? null;
    const leadId = (payload.leadId as string | undefined) ?? null;

    let resolvedTenantId: string | null = tenantId;
    if (!resolvedTenantId && customerId) {
      const customer = await runUnscoped(() =>
        prisma.customer.findUnique({ where: { id: customerId }, select: { tenantId: true } }),
      );
      resolvedTenantId = customer?.tenantId ?? null;
    }
    if (!resolvedTenantId && leadId) {
      const lead = await runUnscoped(() => prisma.lead.findUnique({ where: { id: leadId }, select: { tenantId: true } }));
      resolvedTenantId = lead?.tenantId ?? null;
    }
    if (!resolvedTenantId) return { skipped: 'no tenant' };

    return journeys.triggerJourney({
      tenantId: resolvedTenantId,
      trigger: payload.trigger as JourneyTrigger,
      customerId,
      leadId,
      appointmentId: (payload.appointmentId as string) ?? null,
      invoiceId: (payload.invoiceId as string) ?? null,
      membershipId: (payload.membershipId as string) ?? null,
      packagePurchaseId: (payload.packagePurchaseId as string) ?? null,
      extra: (payload.extra as Record<string, string>) ?? undefined,
    });
  },

  'journey.advance': async (payload) => journeys.advanceRun(payload.runId as string),

  // -------------------------------------------------------------- messages --
  'message.send': async (payload) => deliver(payload.messageLogId as string),

  'campaign.dispatch': async (payload) => campaigns.dispatchCampaign(payload.campaignId as string),

  'campaign.attribute': async (payload) => campaigns.attributeCampaign(payload.campaignId as string),

  // ---------------------------------------------------------- appointments --
  'appointment.reminder': async (payload) => {
    const appointmentId = payload.appointmentId as string;
    const kind = (payload.kind as string) ?? '24h';

    const appointment = await runUnscoped(() =>
      prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: { customer: { select: { id: true } } },
      }),
    );
    if (!appointment) return { skipped: 'appointment not found' };
    if (!['BOOKED', 'CONFIRMED'].includes(appointment.status)) return { skipped: `status ${appointment.status}` };
    if (!appointment.customerId) return { skipped: 'walk-in without customer record' };

    // The notifications layer picks the template and the channel; this handler
    // only knows that a reminder is due.
    const log = await runAsTenant(appointment.tenantId, () =>
      notifications.sendAppointmentReminder(appointmentId, kind === '2h' ? '2h' : '24h'),
    );

    await runUnscoped(() =>
      prisma.appointment.update({
        where: { id: appointmentId },
        data: kind === '2h' ? { reminder2SentAt: new Date() } : { reminder24SentAt: new Date() },
      }),
    );

    return { messageId: log?.id ?? null };
  },

  'appointment.no_show_sweep': async () => runUnscoped(() => appointments.sweepNoShows(30)),

  // -------------------------------------------------------------- billing ---
  'invoice.post_process': async (payload) => {
    const invoiceId = payload.invoiceId as string;
    const invoice = await runUnscoped(() =>
      prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, tenantId: true, branchId: true, customerId: true } }),
    );
    if (!invoice?.customerId) return { skipped: 'no customer' };

    const log = await runAsTenant(invoice.tenantId, () => notifications.sendInvoice(invoice.id));

    if (invoice.customerId) {
      await runAsTenant(invoice.tenantId, () => gamification.updateStreak(invoice.customerId!));
    }

    return { messageId: log?.id ?? null };
  },

  'customer.rollup': async (payload) => {
    const customerId = payload.customerId as string;
    const customer = await runUnscoped(() =>
      prisma.customer.findUnique({ where: { id: customerId }, select: { tenantId: true } }),
    );
    if (!customer) return { skipped: 'not found' };

    return runAsTenant(customer.tenantId, async () => {
      await customers.recalculateCustomerRollups(customerId);
      await customers.refreshCustomerTier(customerId);
      return { ok: true };
    });
  },

  'inventory.consume': async () => ({ skipped: 'handled inline by billing' }),

  // --------------------------------------------------------------- sweeps ---
  'alerts.generate': async () => alerts.generateAlertsForAllTenants(),

  'membership.expiry_sweep': async () => {
    const expired = await runUnscoped(() => memberships.expireMemberships());
    const tenantIds = await activeTenantIds();
    let notified = 0;

    for (const tenantId of tenantIds) {
      // 30 days out is the entry point; the journey handles 7 and 1 day.
      const upcoming = await runUnscoped(() =>
        prisma.membershipSubscription.findMany({
          where: {
            tenantId,
            status: 'ACTIVE',
            expiry30NotifiedAt: null,
            endAt: { gte: new Date(), lte: addDays(new Date(), 30) },
          },
          select: { id: true, customerId: true },
          take: 500,
        }),
      );

      for (const membership of upcoming) {
        await enqueue('journey.trigger', {
          tenantId,
          trigger: 'MEMBERSHIP_EXPIRING',
          customerId: membership.customerId,
          membershipId: membership.id,
        });
        await runUnscoped(() =>
          prisma.membershipSubscription.update({
            where: { id: membership.id },
            data: { expiry30NotifiedAt: new Date() },
          }),
        );
        notified += 1;
      }
    }

    return { ...expired, notified };
  },

  'package.expiry_sweep': async () => {
    const expired = await runUnscoped(() => packages.expirePackages());
    const tenantIds = await activeTenantIds();
    let notified = 0;

    for (const tenantId of tenantIds) {
      const expiring = await runUnscoped(() =>
        prisma.packagePurchase.findMany({
          where: {
            tenantId,
            status: 'ACTIVE',
            expiryNotifiedAt: null,
            expiresAt: { gte: new Date(), lte: addDays(new Date(), 15) },
          },
          select: { id: true, customerId: true },
          take: 500,
        }),
      );

      for (const purchase of expiring) {
        await enqueue('journey.trigger', {
          tenantId,
          trigger: 'PACKAGE_EXPIRING',
          customerId: purchase.customerId,
          packagePurchaseId: purchase.id,
        });
        await runUnscoped(() =>
          prisma.packagePurchase.update({ where: { id: purchase.id }, data: { expiryNotifiedAt: new Date() } }),
        );
        notified += 1;
      }
    }

    return { ...expired, notified };
  },

  'loyalty.expiry_sweep': async () => {
    const tenantIds = await activeTenantIds();
    let expired = 0;
    for (const tenantId of tenantIds) {
      const result = await runAsTenant(tenantId, () => loyalty.expireStalePoints(tenantId));
      expired += result.expired;
    }
    return { expired };
  },

  /**
   * Stages move with the calendar, so they are re-derived nightly. Runs before
   * segment.recompute, because every lifecycle segment reads what this writes.
   */
  'lifecycle.sweep': async () => {
    const { sweepLifecycleStages } = await import('../../modules/customers/lifecycle-sweep');
    return sweepLifecycleStages();
  },

  'segment.recompute': async () => {
    const segments = await runUnscoped(() => prisma.segment.findMany({ where: { isDynamic: true }, select: { id: true, tenantId: true } }));
    let updated = 0;

    for (const segment of segments) {
      await runAsTenant(segment.tenantId, async () => {
        const { resolveMembers } = await import('../../modules/marketing/segment.service');
        await resolveMembers(segment.id);
      }).catch((err: unknown) => logger.warn({ err, segmentId: segment.id }, 'segment recompute failed'));
      updated += 1;
    }

    return { segments: updated };
  },

  /** Customers who have gone quiet enter the win-back journeys. */
  'winback.sweep': async () => {
    const tenantIds = await activeTenantIds();
    let triggered = 0;

    for (const tenantId of tenantIds) {
      const journeyList = await runUnscoped(() =>
        prisma.journey.findMany({ where: { tenantId, trigger: 'NO_VISIT_DAYS', isActive: true } }),
      );

      for (const journey of journeyList) {
        const config = (journey.triggerConfig as { days?: number; minVisits?: number }) ?? {};
        const days = config.days ?? 60;
        const minVisits = config.minVisits ?? 1;

        // Customers whose gap crossed the threshold in the last day, so each
        // customer enters the journey once.
        const candidates = await runUnscoped(() =>
          prisma.customer.findMany({
            where: {
              tenantId,
              isActive: true,
              isBlacklisted: false,
              totalVisits: { gte: minVisits },
              lastVisitAt: {
                lte: addDays(new Date(), -days),
                gte: addDays(new Date(), -days - 1),
              },
            },
            select: { id: true },
            take: 500,
          }),
        );

        for (const customer of candidates) {
          await enqueue('journey.trigger', { tenantId, trigger: 'NO_VISIT_DAYS', customerId: customer.id });
          triggered += 1;
        }
      }
    }

    return { triggered };
  },

  'birthday.sweep': async () => {
    const tenantIds = await activeTenantIds();
    const today = dayjs();
    let triggered = 0;

    for (const tenantId of tenantIds) {
      const withDob = await runUnscoped(() =>
        prisma.customer.findMany({
          where: { tenantId, isActive: true, dob: { not: null } },
          select: { id: true, dob: true },
        }),
      );

      const birthdayToday = withDob.filter(
        (c) => c.dob && c.dob.getUTCMonth() === today.month() && c.dob.getUTCDate() === today.date(),
      );

      for (const customer of birthdayToday) {
        await enqueue('journey.trigger', { tenantId, trigger: 'BIRTHDAY', customerId: customer.id });
        triggered += 1;
      }
    }

    return { triggered };
  },

  'challenge.progress': async (payload) => {
    const customerId = payload.customerId as string | undefined;

    if (customerId) {
      const customer = await runUnscoped(() =>
        prisma.customer.findUnique({ where: { id: customerId }, select: { tenantId: true } }),
      );
      if (!customer) return { skipped: 'not found' };
      return runAsTenant(customer.tenantId, async () => {
        await gamification.updateStreak(customerId);
        return gamification.updateProgress(customerId, customer.tenantId);
      });
    }

    const tenantIds = await activeTenantIds();
    let enrolled = 0;
    for (const tenantId of tenantIds) {
      const result = await runAsTenant(tenantId, () => gamification.autoEnrollActiveChallenges(tenantId));
      enrolled += result.enrolled;
    }
    return { enrolled };
  },

  /**
   * An audit table grows forever and nobody notices until a backup takes an
   * hour. A year is long past any dispute a salon will still be having.
   */
  /**
   * "Your plan renews in 3 days." Sent on a schedule, never acted on: this job
   * warns, and a person decides whether anything gets switched off.
   */
  'subscription.renewal_reminders': async () => renewals.sendRenewalReminders(),

  'audit.prune': async (payload: Record<string, unknown>) => {
    const retentionDays = (payload.retentionDays as number | undefined) ?? 365;
    const deleted = await pruneAudit(retentionDays);
    return { deleted, retentionDays };
  },
};

export function getHandler(type: string): JobHandler | null {
  return handlers[type as JobType] ?? null;
}

export const JOB_TYPES = Object.keys(handlers) as JobType[];

/** Convenience for the daily digest job used in tests and manual runs. */
export async function todaysAppointmentsNeedingConfirmation(tenantId: string) {
  return runUnscoped(() =>
    prisma.appointment.count({
      where: {
        tenantId,
        status: 'BOOKED',
        startAt: { gte: startOfDay(addDays(new Date(), 1)), lte: endOfDay(addDays(new Date(), 1)) },
      },
    }),
  );
}
