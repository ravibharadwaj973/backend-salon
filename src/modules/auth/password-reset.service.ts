import type { PasswordResetRequest, UserRole } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { randomToken, sha256 } from '../../core/ids';
import { logger } from '../../core/logger';
import { env } from '../../config/env';
import { notifyPlatform } from '../../messaging/platform-notify';
import { invalidateIdentity } from '../../middleware/auth';
import { resetIsHandledByPlatform } from '../../core/user-authority';
import { hashPassword } from './auth.service';

/**
 * GETTING BACK IN, WITHOUT LETTING ANYONE ELSE IN.
 *
 * ── What was here before, and why it could not stay ──────────────────────
 *
 * The ordinary flow: type an email, receive a link, set a new password. Three
 * things were wrong with it in this app.
 *
 * It did not work. `requestPasswordReset` wrote a token to the database, logged
 * a line and returned. Nothing sent it. The endpoint answered "a reset link is
 * on its way" to a person who would wait forever, and the token was readable
 * only from the API response, and only outside production. In production it was
 * a dead end that lied.
 *
 * It was the wrong check. Email is the weakest proof of identity available, and
 * this login is a till, a customer book and a payroll screen. The person who
 * wants it back is nearly always standing at the counter next to somebody who
 * can identify them by looking at them — a far stronger check than a mailbox,
 * and one that costs nothing.
 *
 * And it put the decision in the wrong hands. A salon owner asked for staff not
 * to be able to reset themselves at all, which is not caution: a receptionist
 * who can silently issue themselves a new password at 2am is a receptionist
 * whose account can be taken over by anyone with ten minutes at their inbox.
 *
 * ── What happens instead ────────────────────────────────────────────────
 *
 * Asking creates a REQUEST. It issues nothing. A person then resolves it, and
 * which person depends on one thing only — whether anybody inside the salon can
 * already do everything the locked-out user can do:
 *
 *   Staff, managers, admins    a colleague with more reach resets them in the
 *                              app and hands over a temporary password. No
 *                              email, no link, no waiting.
 *
 *   The only owner             nobody inside the salon outranks them, so this
 *                              is the one case that reaches support — and
 *                              support answers it with a link sent to the
 *                              address already on the account, never a password
 *                              read down the phone. We never hold a credential
 *                              for a salon, and this is the design decision that
 *                              keeps that true.
 *
 * ── The enumeration rule ────────────────────────────────────────────────
 *
 * Every answer from the asking endpoint is identical, whether the email is a
 * real login, somebody else's, or nonsense. Anything that varies — wording,
 * status code, how long it takes — turns the form into a way of discovering who
 * works at a salon.
 */

/**
 * HOW LONG A RESET LINK LIVES.
 *
 * Two hours rather than the usual one, because of the path it takes: an owner
 * writes to support, a person reads it, checks who they are and approves, and
 * only then does the mail go out. An hour measured from the approval can easily
 * be spent before the owner next looks at their inbox, and a link that has
 * expired by the time it is read produces a second request and a second wait.
 *
 * It is still short. The link is single-use, it is invalidated by any later one,
 * and using it signs out every session the account had.
 */
const LINK_TTL_MINUTES = 120;

/** The one answer this endpoint gives, to everybody, always. */
export const NEUTRAL_ANSWER =
  'If that account exists, the people who can reset it have been told. For anything urgent, speak to your salon owner or manager.';

export interface HelpRequestMeta {
  ip?: string;
}

/**
 * Somebody says they cannot get in.
 *
 * Resolves the same way whatever it finds. The only observable difference is in
 * the database, and only when the email matches exactly one active login.
 */
export async function requestPasswordHelp(
  email: string,
  tenantSlug: string | undefined,
  meta: HelpRequestMeta = {},
): Promise<void> {
  const users = await runUnscoped(() =>
    prisma.user.findMany({
      where: { email, isActive: true, ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}) },
      select: { id: true, tenantId: true, email: true, role: true },
      take: 2,
    }),
  );

  /**
   * Exactly one, or nothing happens. Two means the same person works at two
   * salons and has not said which — raising a request in both would put a name
   * in front of a salon that did not ask about them.
   */
  if (users.length !== 1) return;
  const user = users[0]!;

  /**
   * One open ask per person, which the database also enforces with a partial
   * unique index. Asking again while one is open is not a second request: it is
   * the same person pressing the button again, and the queue should show them
   * once. The timestamp is left alone deliberately — how long they have been
   * waiting is the most useful column in that queue, and refreshing it on every
   * press would hide the oldest problem.
   */
  const existing = await runUnscoped(() =>
    prisma.passwordResetRequest.findFirst({ where: { userId: user.id, status: 'PENDING' } }),
  );
  if (existing) {
    logger.info({ userId: user.id }, 'password help asked for again while one is open');
    return;
  }

  await runUnscoped(() =>
    prisma.passwordResetRequest.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        email: user.email,
        role: user.role,
        requestedIp: meta.ip ?? null,
      },
    }),
  ).catch((err: unknown) => {
    // The unique index can still lose a race with a double-click. Losing it is
    // the correct outcome, and it is not an error worth failing the request for.
    logger.warn({ err, userId: user.id }, 'password help request not recorded');
  });

  logger.info(
    { userId: user.id, role: user.role, viaPlatform: await handledByPlatform(user.tenantId, user.role) },
    'password help requested',
  );
}

/** Whether this person's only way back is through support. */
async function handledByPlatform(tenantId: string, role: UserRole): Promise<boolean> {
  if (role !== 'OWNER') return false;
  const others = await runUnscoped(() =>
    prisma.user.count({ where: { tenantId, role: 'OWNER', isActive: true } }),
  );
  // `others` counts this owner too, hence the subtraction.
  return resetIsHandledByPlatform(role, Math.max(0, others - 1));
}

/**
 * The open asks a salon can deal with itself.
 *
 * A sole owner's request is deliberately still listed. It cannot be resolved
 * from in here, and saying so on screen is far better than leaving somebody to
 * discover it by pressing a button that refuses.
 */
export async function listRequestsForSalon(tenantId: string) {
  const rows = await prisma.passwordResetRequest.findMany({
    where: { tenantId, status: 'PENDING' },
    orderBy: { requestedAt: 'asc' },
    select: {
      id: true,
      userId: true,
      email: true,
      role: true,
      requestedAt: true,
      user: { select: { name: true, isActive: true } },
    },
  });

  const owners = await prisma.user.count({ where: { tenantId, role: 'OWNER', isActive: true } });

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    name: row.user?.name ?? row.email,
    email: row.email,
    role: row.role,
    requestedAt: row.requestedAt,
    /** True when nobody in this salon can resolve it — support has to. */
    needsSupport: resetIsHandledByPlatform(row.role, Math.max(0, owners - 1)),
  }));
}

/**
 * Close whoever's open request, because they have just been given a way in.
 *
 * Called from inside the reset transaction rather than after it. A reset that
 * succeeds while the request stays open leaves a queue item that somebody else
 * will action a second time — issuing a second password and invalidating the one
 * already handed over.
 */
export function closeOpenRequest(
  userId: string,
  by: { userId?: string | null; platformUserId?: string | null; name: string; reason?: string },
) {
  return prisma.passwordResetRequest.updateMany({
    where: { userId, status: 'PENDING' },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedById: by.userId ?? null,
      resolvedByPlatformUserId: by.platformUserId ?? null,
      resolvedByName: by.name,
      reason: by.reason ?? null,
    },
  });
}

// ===========================================================================
// THE SUPPORT PATH — a link to the address already on the account.
// ===========================================================================

/**
 * The open asks only we can answer.
 *
 * Owners, and only where the salon has no second owner to do it themselves. A
 * request that the salon could resolve must not appear here: every time support
 * touches a salon's credentials is a time somebody outside the business could
 * have been the one to get it wrong, and the fewer of those the better.
 */
export async function listRequestsForPlatform() {
  const rows = await runUnscoped(() =>
    prisma.passwordResetRequest.findMany({
      where: { status: 'PENDING', role: 'OWNER' },
      orderBy: { requestedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        tenantId: true,
        userId: true,
        email: true,
        role: true,
        requestedAt: true,
        requestedIp: true,
        user: { select: { name: true, phone: true, lastLoginAt: true } },
        tenant: { select: { name: true, slug: true, email: true, phone: true, status: true } },
      },
    }),
  );

  const ownerCounts = await runUnscoped(() =>
    prisma.user.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: rows.map((r) => r.tenantId) }, role: 'OWNER', isActive: true },
      _count: { _all: true },
    }),
  );
  const ownersByTenant = new Map(ownerCounts.map((row) => [row.tenantId, row._count._all]));

  return rows
    .filter((row) => resetIsHandledByPlatform(row.role, Math.max(0, (ownersByTenant.get(row.tenantId) ?? 1) - 1)))
    .map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      tenantName: row.tenant?.name ?? '—',
      tenantSlug: row.tenant?.slug ?? '',
      tenantStatus: row.tenant?.status ?? '',
      /**
       * The salon's own contact details, shown beside the request on purpose.
       *
       * This is what the person checking has to work with: they ring the number
       * on the account, not a number the requester supplied. An identity check
       * that uses details from the request is not a check.
       */
      salonEmail: row.tenant?.email ?? null,
      salonPhone: row.tenant?.phone ?? null,
      name: row.user?.name ?? row.email,
      email: row.email,
      userPhone: row.user?.phone ?? null,
      lastLoginAt: row.user?.lastLoginAt ?? null,
      requestedAt: row.requestedAt,
      requestedIp: row.requestedIp,
    }));
}

export interface PlatformActor {
  platformUserId: string;
  name: string;
}

/**
 * Support approves: a single-use link goes to the address on the account.
 *
 * Note what this does NOT do. It does not set a password, and it does not show
 * one to the person approving. The credential is chosen by the owner, in their
 * own browser, after proving they can read the mailbox the account was
 * registered with. Support's authority ends at deciding the request is genuine.
 *
 * `reason` is required by the route. It is the only record of the identity check
 * that happened off-screen — a phone call to the number on the account, a
 * conversation with a known contact — and an approval without one is an
 * approval nobody can review later.
 */
export async function approveByPlatform(
  requestId: string,
  actor: PlatformActor,
  reason: string,
): Promise<{ sent: boolean; to: string; tenantId: string; userId: string }> {
  const request = await runUnscoped(() =>
    prisma.passwordResetRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, email: true, name: true, isActive: true, role: true } } },
    }),
  );

  if (!request) throw NotFound('Password reset request');
  if (request.status !== 'PENDING') throw BadRequest('That request has already been dealt with');
  if (!request.user || !request.user.isActive) throw BadRequest('That login is no longer active');

  /**
   * Checked again here, not just when the queue was drawn.
   *
   * A second owner may have been added since — in which case the salon can now
   * help itself and we should not be involved. Trusting the list to still be
   * true is how a stale screen becomes an unnecessary access to somebody's
   * business.
   */
  if (!(await handledByPlatform(request.tenantId, request.user.role))) {
    throw BadRequest(
      'This salon now has another owner who can reset this login from inside the app. Ask them to do it.',
    );
  }

  const token = randomToken(32);

  await runUnscoped(() =>
    prisma.$transaction([
      /**
       * Any earlier link for this person stops working the moment a new one is
       * issued. Two live links mean the older one — likelier to have been seen
       * by somebody it was not meant for — is still a way in.
       */
      prisma.passwordResetToken.updateMany({
        where: { userId: request.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.create({
        data: {
          tenantId: request.tenantId,
          userId: request.userId,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000),
        },
      }),
      prisma.passwordResetRequest.update({
        where: { id: request.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedByPlatformUserId: actor.platformUserId,
          resolvedByName: actor.name,
          reason,
        },
      }),
    ]),
  );

  /**
   * To the address ON THE ACCOUNT, never one supplied with the request.
   *
   * This is the whole identity check the link rests on. Sending to an address
   * the requester typed would mean anybody who knows an owner's name can have a
   * working reset link posted to themselves.
   */
  const to = request.user.email;
  const link = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

  const sent = await notifyPlatform({
    to,
    tenantId: request.tenantId,
    subject: 'Set a new password for your salon account',
    body: resetEmail(request.user.name, link),
  }).catch((err: unknown) => {
    logger.error({ err, userId: request.userId }, 'reset link email failed');
    return false;
  });

  return { sent, to, tenantId: request.tenantId, userId: request.userId };
}

export async function rejectByPlatform(
  requestId: string,
  actor: PlatformActor,
  reason: string,
): Promise<{ tenantId: string; userId: string }> {
  const request = await runUnscoped(() =>
    prisma.passwordResetRequest.findUnique({ where: { id: requestId } }),
  );
  if (!request) throw NotFound('Password reset request');
  if (request.status !== 'PENDING') throw BadRequest('That request has already been dealt with');

  await runUnscoped(() =>
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        resolvedAt: new Date(),
        resolvedByPlatformUserId: actor.platformUserId,
        resolvedByName: actor.name,
        reason,
      },
    }),
  );

  return { tenantId: request.tenantId, userId: request.userId };
}

/**
 * The email itself.
 *
 * Deliberately plain and short. A password email that looks like marketing — a
 * banner, three paragraphs of reassurance, a footer of links — is the exact
 * shape people are taught to distrust, and it is also the shape a phishing copy
 * takes. What matters is one sentence of context, one link, and how long it
 * lasts. The address is not personalised beyond a first name because anything
 * more would be confirming account details to whoever opens the mailbox.
 */
function resetEmail(name: string, link: string): string {
  const first = name.split(' ')[0] ?? 'there';
  return [
    `<p>Hi ${escapeHtml(first)},</p>`,
    '<p>Support has approved a password reset for your salon account. Use the link below to set a new one.</p>',
    `<p><a href="${link}">Set a new password</a></p>`,
    `<p>The link works once and expires in ${LINK_TTL_MINUTES / 60} hours. Signing in with a new password will end every session your account currently has, on every device.</p>`,
    '<p>If you did not ask for this, reply to this email — do not use the link.</p>',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * Redeeming a link.
 *
 * Unauthenticated by necessity — the whole point is that the person cannot sign
 * in — so every check that matters happens here, and each one is worth naming:
 *
 *   · the token is looked up by SHA-256 of what was presented, so the database
 *     never holds anything that could be used as a link;
 *   · used once, ever, and marked used inside the same transaction that changes
 *     the password, so two simultaneous redemptions cannot both succeed;
 *   · expired links are refused with the same message as invalid ones, because
 *     "that link has expired" tells somebody holding a stolen token that it was
 *     real;
 *   · every existing session is revoked. Somebody resetting a password may well
 *     be doing it because another person is signed in as them, and leaving those
 *     sessions alive would make the reset pointless.
 */
export async function redeemResetLink(token: string, newPassword: string): Promise<void> {
  const record = await runUnscoped(() =>
    prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } }),
  );

  if (!record || record.usedAt || record.expiresAt < new Date() || !record.userId) {
    throw BadRequest('This reset link is invalid or has expired. Ask for a new one.');
  }

  const userId = record.userId;
  const passwordHash = await hashPassword(newPassword);

  await runUnscoped(() =>
    prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        // False, not true: they have just chosen this password themselves, so
        // asking them to change it again on the next screen is nonsense.
        data: { passwordHash, mustChangePassword: false },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.passwordResetRequest.updateMany({
        where: { userId, status: 'PENDING' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByName: 'Reset link used' },
      }),
    ]),
  );

  invalidateIdentity(userId);
  logger.info({ userId }, 'password set from a reset link');
}

export type { PasswordResetRequest };
