import { Router } from 'express';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './user.service';
import type { CreateUserInput } from './user.service';
import {
  createUserSchema,
  listUsersQuery,
  permissionOverrideSchema,
  resetUserPasswordSchema,
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

router.post(
  '/:id/reset-password',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: idParam, body: resetUserPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { newPassword, mustChangePassword } = req.body as { newPassword: string; mustChangePassword: boolean };
    const result = await service.resetUserPassword(req.params.id!, newPassword, mustChangePassword);
    audit({ action: 'user.password_reset', entity: 'User', entityId: req.params.id! });
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
