import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { User, UserRole } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../../core/errors';
import { randomToken, sha256 } from '../../core/ids';
import { addDays } from '../../core/dates';
import { invalidateIdentity } from '../../middleware/auth';
import { resolvePermissions } from '../../core/permissions';
import { enabledFeatures, type FeatureKey } from '../../core/features';
import { logger } from '../../core/logger';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  avatarUrl: string | null;
  mustChangePassword: boolean;
  tenant: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    timezone: string;
    status: string;
    plan: { code: string; name: string } | null;
  };
  branches: { id: string; name: string; code: string }[];
  /** null = access to every branch */
  branchIds: string[] | null;
  permissions: string[];
  /** What the salon's plan includes. Separate from permissions on purpose. */
  features: FeatureKey[];
  staffId: string | null;
  /** The salon may read everything and save nothing. */
  readOnly: boolean;
  readOnlyReason: string | null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

function signAccessToken(user: Pick<User, 'id' | 'tenantId' | 'role'>): string {
  return jwt.sign({ sub: user.id, tid: user.tenantId, role: user.role, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as jwt.SignOptions);
}

async function issueRefreshToken(
  userId: string,
  tenantId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<string> {
  const token = randomToken();
  await runUnscoped(() =>
    prisma.refreshToken.create({
      data: {
        tenantId,
        userId,
        tokenHash: sha256(token),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        expiresAt: addDays(new Date(), 30),
      },
    }),
  );
  return token;
}

export async function issueTokens(
  user: Pick<User, 'id' | 'tenantId' | 'role'>,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    Promise.resolve(signAccessToken(user)),
    issueRefreshToken(user.id, user.tenantId, meta),
  ]);
  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_TTL };
}

/**
 * Email is unique per tenant, not globally: the same person can work at two
 * salons. When an email resolves to more than one account we ask for the salon.
 */
export async function login(
  email: string,
  password: string,
  tenantSlug: string | undefined,
  meta: { ip?: string; userAgent?: string },
): Promise<{ tokens: TokenPair; user: SessionUser }> {
  const candidates = await runUnscoped(() =>
    prisma.user.findMany({
      where: { email, isActive: true, ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}) },
      include: { tenant: true },
    }),
  );

  if (candidates.length === 0) throw Unauthorized('Invalid email or password');
  if (candidates.length > 1) {
    throw Conflict('This email is registered with more than one salon. Please include tenantSlug.', {
      tenants: candidates.map((c) => ({ slug: c.tenant.slug, name: c.tenant.name })),
    });
  }

  const user = candidates[0]!;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw Unauthorized('Invalid email or password');

  // A switched-off salon still signs in. It lands in a read-only app: every
  // record readable and exportable, nothing new saveable. Refusing the login
  // would lock a salon out of its own customer book over an unpaid invoice.

  await runUnscoped(() => prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }));
  invalidateIdentity(user.id);

  const tokens = await issueTokens(user, meta);
  const session = await buildSession(user.id);
  return { tokens, user: session };
}

export async function refresh(rawToken: string, meta: { ip?: string; userAgent?: string }): Promise<TokenPair> {
  const record = await runUnscoped(() =>
    prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { user: true } }),
  );

  if (!record || !record.user) throw Unauthorized('Invalid refresh token');
  if (record.revokedAt) throw Unauthorized('Refresh token has been revoked');
  if (record.expiresAt < new Date()) throw Unauthorized('Refresh token expired');
  if (!record.user.isActive) throw Unauthorized('Account is inactive');

  // Rotate: the presented token is retired as the new one is issued.
  await runUnscoped(() =>
    prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } }),
  );

  return issueTokens(record.user, meta);
}

export async function logout(rawToken: string): Promise<void> {
  await runUnscoped(() =>
    prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  );
}

export async function logoutAllSessions(userId: string): Promise<void> {
  await runUnscoped(() =>
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  );
  invalidateIdentity(userId);
}

/**
 * Whether this salon may change anything, and why not. Kept beside the session
 * so the interface can explain the state up front instead of letting someone
 * fill in a form and meet a 403 on save.
 */
export function readOnlyState(status: string): { readOnly: boolean; readOnlyReason: string | null } {
  if (status === 'SUSPENDED') {
    return {
      readOnly: true,
      readOnlyReason:
        'This salon account is switched off, so nothing new can be saved. Your records are all still here to read and export. Contact support to switch it back on.',
    };
  }
  if (status === 'CANCELLED') {
    return {
      readOnly: true,
      readOnlyReason: 'This salon account has been closed. Your records stay available to read and export.',
    };
  }
  return { readOnly: false, readOnlyReason: null };
}

export async function buildSession(userId: string): Promise<SessionUser> {
  const user = await runUnscoped(() =>
    prisma.user.findUnique({
      where: { id: userId },
      include: {
        tenant: { include: { plan: { select: { code: true, name: true, features: true } } } },
        overrides: true,
        staffProfile: { select: { id: true } },
        branches: { include: { branch: { select: { id: true, name: true, code: true, isActive: true } } } },
      },
    }),
  );
  if (!user) throw NotFound('User');

  const assigned = user.branches.map((b) => b.branch).filter((b) => b.isActive);
  const seesAll = user.role === 'OWNER' || user.role === 'ADMIN' || assigned.length === 0;

  const branches = seesAll
    ? await prisma.branch.findMany({
        where: { tenantId: user.tenantId, isActive: true },
        select: { id: true, name: true, code: true },
        orderBy: { name: 'asc' },
      })
    : assigned.map((b) => ({ id: b.id, name: b.name, code: b.code }));

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    avatarUrl: user.avatarUrl,
    mustChangePassword: user.mustChangePassword,
    tenant: {
      id: user.tenant.id,
      name: user.tenant.name,
      slug: user.tenant.slug,
      currency: user.tenant.currency,
      timezone: user.tenant.timezone,
      status: user.tenant.status,
      plan: user.tenant.plan ? { code: user.tenant.plan.code, name: user.tenant.plan.name } : null,
    },
    branches,
    branchIds: seesAll ? null : assigned.map((b) => b.id),
    permissions: [...resolvePermissions(user.role, user.overrides)],
    // What the salon bought, alongside what this person may do. The interface
    // needs both: a screen is shown when the user has the permission AND the
    // plan includes the feature, and hiding it beats a 402 on the way in.
    features: enabledFeatures(user.tenant.plan?.features),
    staffId: user.staffProfile?.id ?? null,
    ...readOnlyState(user.tenant.status),
  };
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  const user = await runUnscoped(() => prisma.user.findUnique({ where: { id: userId } }));
  if (!user) throw NotFound('User');

  const valid = await bcrypt.compare(current, user.passwordHash);
  if (!valid) throw BadRequest('Current password is incorrect');
  if (current === next) throw BadRequest('New password must be different from the current one');

  const passwordHash = await hashPassword(next);
  await runUnscoped(() =>
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    }),
  );
  await logoutAllSessions(userId);
}

/**
 * Always resolves, whether or not the email exists — otherwise this endpoint
 * becomes an account-enumeration oracle. The reset link is delivered by the
 * messaging worker.
 */
export async function requestPasswordReset(email: string, tenantSlug?: string): Promise<{ token?: string }> {
  const users = await runUnscoped(() =>
    prisma.user.findMany({
      where: { email, isActive: true, ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}) },
      take: 2,
    }),
  );
  if (users.length !== 1) return {};

  const user = users[0]!;
  const token = randomToken(32);
  await runUnscoped(() =>
    prisma.passwordResetToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    }),
  );

  logger.info({ userId: user.id }, 'password reset requested');
  return { token };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await runUnscoped(() =>
    prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } }),
  );
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.userId) {
    throw BadRequest('This reset link is invalid or has expired');
  }

  const passwordHash = await hashPassword(newPassword);
  await runUnscoped(() =>
    prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId! },
        data: { passwordHash, mustChangePassword: false },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({
        where: { userId: record.userId!, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]),
  );
  invalidateIdentity(record.userId);
}

export async function platformLogin(
  email: string,
  password: string,
): Promise<{ accessToken: string; user: { id: string; name: string; email: string } }> {
  const admin = await runUnscoped(() => prisma.platformUser.findUnique({ where: { email } }));
  if (!admin || !admin.isActive) throw Unauthorized('Invalid email or password');

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) throw Unauthorized('Invalid email or password');

  await runUnscoped(() => prisma.platformUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }));

  const accessToken = jwt.sign({ sub: admin.id, typ: 'platform' }, env.JWT_ACCESS_SECRET, {
    expiresIn: '8h',
  } as jwt.SignOptions);

  return { accessToken, user: { id: admin.id, name: admin.name, email: admin.email } };
}
