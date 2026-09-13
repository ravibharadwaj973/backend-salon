import type { NextFunction, Request, Response } from 'express';
import { assertFeature } from '../modules/quotas/limits.service';
import { FEATURE_LABELS, type FeatureKey } from '../core/features';

/**
 * Gate a route on what the salon's plan includes.
 *
 * This is a different question from permissions. `requirePermission` asks whether
 * *this user* is allowed to do it; `requireFeature` asks whether *this salon*
 * bought it. Both run: an owner has every permission and still cannot open
 * campaigns on a Starter plan.
 *
 * Order matters — put this after `authenticate` and after `requirePermission`, so
 * a receptionist poking at an owner-only route gets 403 (you may not) rather than
 * 402 (buy more), which would leak what the plan above includes.
 */
export function requireFeature(feature: FeatureKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // No identity yet means the request is not authenticated. Let it through so
    // the router below answers 401 — which is both the correct answer and the
    // one that does not reveal which features the plan above includes.
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return next();

    try {
      await assertFeature(tenantId, feature, FEATURE_LABELS[feature]);
      next();
    } catch (error) {
      next(error);
    }
  };
}
