import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticatePlatform } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { Forbidden } from '../../core/errors';
import * as service from './password-reset.service';

/**
 * THE ONE CASE A SALON CANNOT SOLVE FOR ITSELF.
 *
 * A salon's only owner, locked out. Nobody inside the business can reset them —
 * there is no account with more reach — so this is where it lands.
 *
 * Two things shape every line below.
 *
 * FIRST, support never holds a salon's credential. Approving does not set a
 * password and does not show one to the person approving; it sends a single-use
 * link to the address already on the account, and the owner chooses their own
 * password in their own browser. The authority being exercised here is "this
 * request is genuine", nothing more. That boundary is worth guarding: the moment
 * support can read a password aloud, every support conversation becomes a
 * social-engineering target, and the salon has to trust us in a way it should
 * not have to.
 *
 * SECOND, a reason is compulsory. The real identity check happens off-screen —
 * a call to the number on the account, a known contact — and the reason field is
 * the only record that it happened at all. An approval with no reason is an
 * approval nobody can review, and this is precisely the action that gets
 * reviewed.
 */

export const platformPasswordResetRouter = Router();

platformPasswordResetRouter.use(authenticatePlatform);

/**
 * Long enough to be a sentence, because a word is not a reason.
 *
 * "verified" and "ok" are what a free-text field collects when it permits them,
 * and neither tells the next person anything. Twenty characters is roughly
 * "spoke to Ravi on the salon number", which does.
 */
const decisionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(20, 'Say how you verified them — a name, a number you called, or what was checked.')
    .max(500),
});

const idParam = z.object({ id: z.string().min(1) });

platformPasswordResetRouter.get(
  '/password-requests',
  asyncHandler(async (_req, res) => {
    return ok(res, await service.listRequestsForPlatform());
  }),
);

platformPasswordResetRouter.post(
  '/password-requests/:id/approve',
  validate({ params: idParam, body: decisionSchema }),
  asyncHandler(async (req, res) => {
    const actor = req.platformAuth;
    if (!actor) throw Forbidden('Platform access required');

    const { reason } = req.body as { reason: string };
    const result = await service.approveByPlatform(req.params.id!, actor, reason);

    /**
     * Written into the SALON'S own trail, not ours.
     *
     * They are the ones entitled to know that somebody outside their business
     * touched their owner's account, and their audit screen is where they would
     * look. `tenantId` is passed explicitly because a platform request carries no
     * tenant in context — without it this call wrote nothing at all, silently,
     * which is how support could reset an owner and leave no trace anywhere.
     */
    audit({
      tenantId: result.tenantId,
      action: 'auth.reset_link_issued_by_support',
      entity: 'User',
      entityId: result.userId,
      // The address is recorded so the salon can see where the link went. The
      // token is not, here or anywhere: the database holds only its hash.
      after: { sentTo: result.to, delivered: result.sent, reason },
    });

    return ok(res, {
      approved: true,
      sent: result.sent,
      /**
       * Said plainly rather than swallowed. If the mail did not go out, the
       * request is still resolved and the link still exists — the person
       * approving needs to know to follow it up, not to press approve again and
       * invalidate the link they just made.
       */
      message: result.sent
        ? `A reset link has been sent to ${result.to}. It works once and expires in two hours.`
        : `The request was approved but the email did not go out. Check the mail provider — do not approve again, that would cancel the link already issued.`,
    });
  }),
);

platformPasswordResetRouter.post(
  '/password-requests/:id/reject',
  validate({ params: idParam, body: decisionSchema }),
  asyncHandler(async (req, res) => {
    const actor = req.platformAuth;
    if (!actor) throw Forbidden('Platform access required');

    const { reason } = req.body as { reason: string };
    const result = await service.rejectByPlatform(req.params.id!, actor, reason);

    /**
     * A refusal is audited as carefully as an approval.
     *
     * A request refused because the caller could not be verified is the single
     * most interesting row in this whole feature: it is somebody trying to take
     * an owner's account, and it needs to be visible to the salon it was aimed
     * at.
     */
    audit({
      tenantId: result.tenantId,
      action: 'auth.reset_request_refused_by_support',
      entity: 'User',
      entityId: result.userId,
      after: { reason },
    });

    return ok(res, { rejected: true });
  }),
);
