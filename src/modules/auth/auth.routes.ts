import { Router } from 'express';
import { asyncHandler, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { audit } from '../../middleware/audit';
import { Unauthorized } from '../../core/errors';
import * as service from './auth.service';
import * as passwordResets from './password-reset.service';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  platformLoginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './auth.schema';

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
    const tokens = await service.changePassword(req.auth!.userId, currentPassword, newPassword, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    audit({ action: 'auth.password_changed', entity: 'User', entityId: req.auth!.userId });
    /**
     * A fresh pair comes back because the change revoked every session,
     * including the one that made this request. The caller swaps its cookies for
     * these and carries on; without them, finishing a forced password change
     * would log you straight out.
     */
    return ok(res, { changed: true, tokens });
  }),
);

/**
 * "I CANNOT SIGN IN" — AN ASK, NOT A LINK.
 *
 * This used to mint a reset token, log a line, and answer "a reset link is on
 * its way". Nothing sent it. In production the token was unreachable by anyone,
 * so the endpoint's entire behaviour was to tell a locked-out person to go and
 * wait for an email that would never arrive.
 *
 * It now records a request that a person resolves — a colleague inside the salon
 * for everybody except a sole owner, and support for that one case. See
 * password-reset.service.ts for why email is the wrong identity check here and
 * what replaces it.
 *
 * The answer is byte-identical whatever the email turns out to be. A different
 * message, a different status, even a noticeably different response time would
 * turn this form into a way of finding out who works at a salon.
 */
router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { email, tenantSlug } = req.body as { email: string; tenantSlug?: string };
    await passwordResets.requestPasswordHelp(email, tenantSlug, { ip: req.ip });
    return ok(res, { message: passwordResets.NEUTRAL_ANSWER });
  }),
);

/**
 * Redeeming a link support issued. The only way a reset token is ever created.
 */
router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    await passwordResets.redeemResetLink(token, newPassword);
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
