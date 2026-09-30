import type { Request } from 'express';
import { Forbidden } from '../core/errors';

/**
 * A TEMPORARY PASSWORD THAT IS ACTUALLY TEMPORARY.
 *
 * `mustChangePassword` has been set on every user this app has ever created, and
 * on every password a colleague resets. Until now nothing read it. It travelled
 * out in the session, the interface ignored it, and the person carried on with
 * the password their manager had read out across the counter — permanently.
 *
 * ── Why this is enforced here and not in the browser ─────────────────────
 *
 * A redirect in the front end is a suggestion. The temporary password is a real
 * credential: it signs in, it returns real tokens, and those tokens work against
 * every endpoint in the API whether or not a browser chose to send somebody to a
 * change-password screen first. Anyone who has ever opened developer tools can
 * skip a redirect.
 *
 * So the flag is enforced where the credential is checked. Until the password is
 * changed the token opens four things and nothing else, and that is true of
 * curl, a mobile app and a browser alike.
 *
 * ── Why these four ──────────────────────────────────────────────────────
 *
 * Exactly what is needed to get out of the state, and nothing that could be
 * useful to somebody holding a password they should not have:
 *
 *   /auth/me              the app cannot draw the change-password screen without
 *                         knowing who it is drawing it for
 *   /auth/change-password the way out — and it asks for the current password, so
 *                         holding the temporary one is not enough to skip a step
 *   /auth/refresh         a short access token must be renewable while somebody
 *                         is choosing a password, or a slow typist is thrown out
 *                         halfway
 *   /auth/logout(-all)    leaving must always work. A person who realises they
 *                         have been given the wrong login needs to get out
 *
 * Notably absent: reading the customer book, the diary, anything. A temporary
 * password handed over in a busy salon may well be overheard, and the window
 * between being told it and changing it is exactly when it is worth the least.
 */
const ALLOWED_WHILE_PENDING: readonly RegExp[] = [
  /\/auth\/me$/,
  /\/auth\/change-password$/,
  /\/auth\/refresh$/,
  /\/auth\/logout$/,
  /\/auth\/logout-all$/,
];

export function isAllowedWhilePasswordPending(path: string): boolean {
  return ALLOWED_WHILE_PENDING.some((allowed) => allowed.test(path));
}

/**
 * Throws when this request needs a password that has already been changed.
 *
 * The message is written for a person, not a log: somebody meeting this in an
 * app that has not been updated yet should still understand what to do.
 */
export function assertPasswordChanged(req: Request): void {
  if (!req.auth?.mustChangePassword) return;

  const path = req.originalUrl.split('?')[0] ?? '';
  if (isAllowedWhilePasswordPending(path)) return;

  throw Forbidden('Choose your own password before carrying on — the one you were given is temporary.', {
    mustChangePassword: true,
  });
}
