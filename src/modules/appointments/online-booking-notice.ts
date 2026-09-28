import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { notifyPlatform } from '../../messaging/platform-notify';
import { dayjs, startOfDay } from '../../core/dates';

/**
 * TELLING THE SALON SOMEBODY JUST BOOKED.
 *
 * A booking taken at the counter is witnessed: somebody wrote it down. A
 * booking taken by the website at nine at night is witnessed by nobody. It
 * lands in the diary and sits there, and the first anyone knows of it is when
 * a customer walks in — or does not, because nobody confirmed it.
 *
 * That silence is the single worst thing about online booking for a salon. It
 * is also why owners stop trusting it and go back to the phone.
 *
 * ── Why this goes out on the platform's own email ─────────────────────────
 *
 * Because it is a notice to the SALON, not a message from the salon to a
 * customer. That distinction is already drawn in platform-notify.ts and it
 * carries two properties this needs:
 *
 *   - It is not metered. A salon should never spend the message allowance it
 *     pays for on being told about its own bookings.
 *   - It is not consent-gated. An owner who opted out of product emails is
 *     still owed the one saying a customer is coming on Thursday.
 */

export async function noticeOnlineBooking(appointmentId: string): Promise<void> {
  const appointment = await runUnscoped(() =>
    prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        tenant: { select: { name: true, email: true } },
        branch: { select: { id: true, name: true, email: true, timezone: true } },
        customer: { select: { firstName: true, lastName: true, phone: true } },
        services: { include: { service: { select: { name: true } } } },
      },
    }),
  );

  if (!appointment) return;

  const tz = appointment.branch.timezone;
  const when = dayjs(appointment.startAt).tz(tz);
  const customer = [appointment.customer?.firstName, appointment.customer?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const services = appointment.services.map((row) => row.service.name).join(', ');

  /**
   * The branch's own address first.
   *
   * A two-branch salon has two managers, and the one who needs to know about a
   * Gomti Nagar booking is the one who works there. Falls back to the salon's
   * address, which is always set.
   */
  const to = appointment.branch.email?.trim() || appointment.tenant.email;

  await notifyPlatform({
    tenantId: appointment.tenantId,
    to,
    subject: `New online booking — ${when.format('ddd D MMM, h:mm A')}`,
    /**
     * Everything needed to act, in the subject and the first two lines.
     *
     * An owner reads this on a phone, between customers. If they have to open
     * the app to find out who it is and when, most will not, and the email has
     * achieved nothing except a notification badge.
     */
    body: [
      `${customer || 'A customer'} booked online.`,
      '',
      `When:     ${when.format('dddd D MMMM, h:mm A')}`,
      `Services: ${services || '—'}`,
      `Phone:    ${appointment.customer?.phone ?? '—'}`,
      `Branch:   ${appointment.branch.name}`,
      '',
      'It is already in your diary. Nothing to do unless you want to move it.',
    ].join('\n'),
  });

  await recordAlert(appointment.tenantId, appointment.branch.id, tz);
}

/**
 * THE SAME NEWS, ON THE SCREEN THEY ARE ALREADY LOOKING AT.
 *
 * BusinessAlert holds one row per type per day — @@unique(tenantId, branchId,
 * type, forDate) — so this cannot be a row per booking, and should not be: an
 * owner who takes nine online bookings on a Saturday does not want nine
 * identical cards to dismiss one at a time.
 *
 * So it counts instead, and the count is read from the appointments rather
 * than incremented on the row. Incrementing would drift the moment two
 * bookings landed together or one was cancelled; counting cannot, and it makes
 * a re-run of this function harmless.
 */
async function recordAlert(tenantId: string, branchId: string, tz: string): Promise<void> {
  const since = startOfDay(new Date(), tz);
  const forDate = new Date(dayjs(since).tz(tz).format('YYYY-MM-DD'));

  const count = await runUnscoped(() =>
    prisma.appointment.count({
      where: { tenantId, branchId, source: 'ONLINE', createdAt: { gte: since } },
    }),
  );

  if (count === 0) return;

  const title = count === 1 ? 'A new online booking' : `${count} online bookings today`;
  const body =
    count === 1
      ? 'Somebody booked through your website. It is in the diary already.'
      : `${count} people booked through your website today. They are all in the diary.`;

  await runUnscoped(() =>
    prisma.businessAlert.upsert({
      where: { tenantId_branchId_type_forDate: { tenantId, branchId, type: 'ONLINE_BOOKINGS', forDate } },
      create: {
        tenantId,
        branchId,
        type: 'ONLINE_BOOKINGS',
        title,
        body,
        severity: 'INFO',
        actionUrl: '/calendar',
        forDate,
      },
      /**
       * isRead is deliberately NOT reset when the count goes up.
       *
       * An owner who has read today's card and seen the diary does not need it
       * to reappear unread for every booking after it — that is how a useful
       * alert becomes one people dismiss without reading. The email is the
       * per-booking nudge; this is the running total.
       */
      update: { title, body },
    }),
  );

  logger.info({ tenantId, branchId, count }, 'online booking alert recorded');
}
