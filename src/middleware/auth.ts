import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../core/prisma';
import { runUnscoped } from '../core/context';
import { Forbidden, Unauthorized } from '../core/errors';
import { ALL_BRANCH_ROLES, resolvePermissions } from '../core/permissions';
import type { AuthPayload } from '../types/express';

export interface AccessTokenClaims {
  sub: string;
  tid: string;
  role: string;
  typ: 'access';
}

export interface PlatformTokenClaims {
  sub: string;
  typ: 'platform';
}

function bearer(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers.authorization as string | undefined;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/**
 * Identity is re-read from the database on each request (cached briefly) so that
 * deactivating a user, changing their role or moving their branch assignments
 * takes effect immediately rather than at token expiry.
 */
interface CachedIdentity {
  payload: AuthPayload;
  expiresAt: number;
}
const identityCache = new Map<string, CachedIdentity>();
const IDENTITY_TTL_MS = 20_000;

export function invalidateIdentity(userId: string): void {
  identityCache.delete(userId);
}

export function invalidateAllIdentities(): void {
  identityCache.clear();
}

async function loadIdentity(userId: string): Promise<AuthPayload> {
  const cached = identityCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  // Loaded unscoped: we do not know the tenant until the user row is read.
  const user = await runUnscoped(() =>
    prisma.user.findUnique({
      where: { id: userId },
      include: {
        tenant: { select: { id: true, slug: true, status: true } },
        branches: { select: { branchId: true } },
        overrides: { select: { permission: true, allow: true } },
        staffProfile: { select: { id: true } },
      },
    }),
  );

  if (!user || !user.isActive) throw Unauthorized('Account is inactive or no longer exists');
  if (user.tenant.status === 'SUSPENDED' || user.tenant.status === 'CANCELLED') {
    throw Forbidden('This salon account is suspended. Please contact support.');
  }

  const seesAllBranches = ALL_BRANCH_ROLES.includes(user.role) || user.branches.length === 0;

  const payload: AuthPayload = {
    userId: user.id,
    tenantId: user.tenantId,
    tenantSlug: user.tenant.slug,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: resolvePermissions(user.role, user.overrides),
    branchIds: seesAllBranches ? null : user.branches.map((b) => b.branchId),
    staffId: user.staffProfile?.id ?? null,
  };

  identityCache.set(userId, { payload, expiresAt: Date.now() + IDENTITY_TTL_MS });
  return payload;
}

function applyToContext(req: Parameters<RequestHandler>[0], payload: AuthPayload): void {
  req.auth = payload;
  req.ctx.tenantId = payload.tenantId;
  req.ctx.userId = payload.userId;
  req.ctx.role = payload.role;
  req.ctx.branchIds = payload.branchIds;
  req.ctx.bypassTenantScope = false;
}

/** Require a valid tenant-user access token. */
export const authenticate: RequestHandler = (req, _res, next) => {
  // Idempotent: a route may authenticate at the mount point (so a feature gate
  // can read the tenant) and again inside its own router. Verifying the same
  // token twice is wasted work, not a second opinion.
  if (req.auth?.tenantId) return next();

  const token = bearer(req);
  if (!token) return next(Unauthorized('Missing bearer token'));

  let claims: AccessTokenClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenClaims;
  } catch (err) {
    const message = err instanceof jwt.TokenExpiredError ? 'Access token expired' : 'Invalid access token';
    return next(Unauthorized(message));
  }
  if (claims.typ !== 'access') return next(Unauthorized('Invalid token type'));

  loadIdentity(claims.sub)
    .then((payload) => {
      if (payload.tenantId !== claims.tid) throw Unauthorized('Token does not match this account');
      applyToContext(req, payload);
      next();
    })
    .catch(next);
};

/** Attach identity when a token is present, but do not require one. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  if (!token) return next();
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenClaims;
    if (claims.typ !== 'access') return next();
    loadIdentity(claims.sub)
      .then((payload) => {
        applyToContext(req, payload);
        next();
      })
      .catch(() => next());
  } catch {
    next();
  }
};

/** Platform-operator routes (tenant provisioning, plans, cross-tenant support). */
export const authenticatePlatform: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  if (!token) return next(Unauthorized('Missing bearer token'));

  let claims: PlatformTokenClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as PlatformTokenClaims;
  } catch {
    return next(Unauthorized('Invalid platform token'));
  }
  if (claims.typ !== 'platform') return next(Forbidden('Platform access required'));

  runUnscoped(() => prisma.platformUser.findUnique({ where: { id: claims.sub } }))
    .then((admin) => {
      if (!admin || !admin.isActive) throw Unauthorized('Platform account is inactive');
      req.platformAuth = { platformUserId: admin.id, email: admin.email, name: admin.name };
      req.ctx.isPlatformAdmin = true;
      req.ctx.bypassTenantScope = true;
      req.ctx.tenantId = null;
      next();
    })
    .catch(next);
};

/**
 * Platform operators can act inside a tenant by sending X-Tenant-Id. Everyone
 * else is pinned to the tenant in their token.
 */
export const impersonateTenant: RequestHandler = (req, _res, next) => {
  if (!req.ctx.isPlatformAdmin) return next();
  const tenantId = req.get('x-tenant-id');
  if (tenantId) {
    req.ctx.tenantId = tenantId;
    req.ctx.bypassTenantScope = false;
  }
  next();
};
