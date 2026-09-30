import { Router } from 'express';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './user.service';
import * as passwordResets from '../auth/password-reset.service';
import { requireTenantId } from '../../core/context';
import type { CreateUserInput } from './user.service';
import {
  createUserSchema,
  listUsersQuery,
  permissionOverrideSchema,
  updateUserSchema,
} from './user.schema';
import { ROLE_PERMISSIONS } from '../../core/permissions';

const router = Router();
router.use(authenticate);

router.get(
  '/roles',
  requirePermission(PERMISSIONS.USER_VIEW),
  asyncHandler(async (_req, res) =>
    ok(
      res,
      Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({ role, permissions })),
    ),
  ),
);

router.get(
  '/',
  requirePermission(PERMISSIONS.USER_VIEW),
  validate({ query: listUsersQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listUsers(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.createUser(req.body as CreateUserInput);
    audit({ action: 'user.created', entity: 'User', entityId: user.id, after: { email: user.email, role: user.role } });
    return created(res, user);
  }),
);

/**
 * The open "I cannot sign in" asks this salon can deal with itself.
 *
 * Behind the same permission as the reset, because the list is only useful to
 * somebody who can act on it — and it names staff, which is not something to
 * hand to everyone with a login.
 */
router.get(
  '/password-requests',
  requirePermission(PERMISSIONS.USER_RESET_PASSWORD),
  asyncHandler(async (_req, res) => {
    return ok(res, await passwordResets.listRequestsForSalon(requireTenantId()));
  }),
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.USER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getUser(req.params.id!))),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const user = await service.updateUser(req.params.id!, req.body as never);
    audit({ action: 'user.updated', entity: 'User', entityId: user.id, after: req.body });
    return ok(res, user);
  }),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await service.deactivateUser(req.params.id!);
    audit({ action: 'user.deactivated', entity: 'User', entityId: req.params.id! });
    return ok(res, user);
  }),
);

/**
 * Reset a colleague's password.
 *
 * Behind `user.reset_password`, deliberately NOT `user.manage`. Getting a
 * receptionist back into the till at eight in the morning is a shift-manager
 * job; creating accounts and handing out permissions is not, and bundling them
 * meant the only way to allow the first was to allow the second as well.
 *
 * The permission opens the door. WHO may be reset is settled per pair inside the
 * service, by comparing what the two people can actually do.
 *
 * No body: the password is generated server-side and returned once. See the
 * service for why letting the caller choose it was worse than it looks.
 */
router.post(
  '/:id/reset-password',
  requirePermission(PERMISSIONS.USER_RESET_PASSWORD),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await service.resetUserPassword(req.params.id!);
    /**
     * Audited with the target named, not just their id.
     *
     * This is the row somebody reads months later asking how a stylist's account
     * came to be signed in from a phone nobody recognises, and an id alone means
     * a second query to find out who it even was. The password is of course not
     * recorded — `after` carries what happened, never the credential.
     */
    audit({
      action: 'user.password_reset',
      entity: 'User',
      entityId: req.params.id!,
      after: { name: result.name, email: result.email, mustChangePassword: true, sessionsRevoked: true },
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/permissions',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: permissionOverrideSchema }),
  asyncHandler(async (req, res) => {
    const { permission, allow } = req.body as { permission: string; allow: boolean };
    const result = await service.setPermissionOverride(req.params.id!, permission, allow);
    audit({ action: 'user.permission_override', entity: 'User', entityId: req.params.id!, after: { permission, allow } });
    return ok(res, result);
  }),
);

router.delete(
  '/:id/permissions/:permission',
  requirePermission(PERMISSIONS.USER_MANAGE),
  asyncHandler(async (req, res) =>
    ok(res, await service.removePermissionOverride(req.params.id!, req.params.permission!)),
  ),
);

export default router;
