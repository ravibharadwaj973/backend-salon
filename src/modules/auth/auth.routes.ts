import { Router } from 'express';
import { asyncHandler, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { audit } from '../../middleware/audit';
import { Unauthorized } from '../../core/errors';
import * as service from './auth.service';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  platformLoginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './auth.schema';
import { isProd } from '../../config/env';

const router = Router();

router.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password, tenantSlug } = req.body as { email: string; password: string; tenantSlug?: string };
    const result = await service.login(email, password, tenantSlug, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    return ok(res, result);
  }),
);

router.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const tokens = await service.refresh((req.body as { refreshToken: string }).refreshToken, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    return ok(res, tokens);
  }),
);

router.post(
  '/logout',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    await service.logout((req.body as { refreshToken: string }).refreshToken);
    return ok(res, { loggedOut: true });
  }),
);

router.post(
  '/logout-all',
  authenticate,
  asyncHandler(async (req, res) => {
    await service.logoutAllSessions(req.auth!.userId);
    return ok(res, { loggedOut: true });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const session = await service.buildSession(req.auth!.userId);
    return ok(res, session);
  }),
);

router.post(
  '/change-password',
  authenticate,
  authLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    await service.changePassword(req.auth!.userId, currentPassword, newPassword);
    audit({ action: 'auth.password_changed', entity: 'User', entityId: req.auth!.userId });
    return ok(res, { changed: true });
  }),
);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { email, tenantSlug } = req.body as { email: string; tenantSlug?: string };
    const result = await service.requestPasswordReset(email, tenantSlug);
    // The token is echoed only outside production, so local development works
    // without a mail/WhatsApp provider configured.
    return ok(res, {
      message: 'If that email is registered, a reset link is on its way.',
      ...(isProd ? {} : { devToken: result.token }),
    });
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    await service.resetPassword(token, newPassword);
    return ok(res, { reset: true });
  }),
);

router.post(
  '/platform/login',
  authLimiter,
  validate({ body: platformLoginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const result = await service.platformLogin(email, password);
    if (!result) throw Unauthorized();
    return ok(res, result);
  }),
);

export default router;
