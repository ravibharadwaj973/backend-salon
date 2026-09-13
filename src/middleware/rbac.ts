import type { RequestHandler } from 'express';
import type { UserRole } from '@prisma/client';
import { Forbidden, Unauthorized } from '../core/errors';
import type { Permission } from '../core/permissions';

/** Require every listed permission. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(Unauthorized());
    const missing = permissions.filter((p) => !req.auth!.permissions.has(p));
    if (missing.length) {
      return next(Forbidden(`Missing permission: ${missing.join(', ')}`, { required: permissions, missing }));
    }
    next();
  };
}

/** Require at least one of the listed permissions. */
export function requireAnyPermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(Unauthorized());
    const granted = permissions.some((p) => req.auth!.permissions.has(p));
    if (!granted) {
      return next(Forbidden(`Requires one of: ${permissions.join(', ')}`, { required: permissions }));
    }
    next();
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(Unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(Forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

export function hasPermission(req: { auth?: { permissions: Set<string> } }, permission: Permission): boolean {
  return Boolean(req.auth?.permissions.has(permission));
}
