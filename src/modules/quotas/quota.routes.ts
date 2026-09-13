import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate, authenticatePlatform } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './quota.service';
import { limitsSummary } from './limits.service';
import { enabledFeatures } from '../../core/features';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import {
  createPackSchema,
  grantCreditsSchema,
  listPacksQuery,
  updatePackSchema,
} from './quota.schema';
import type { PackInput } from './quota.service';
import type { MeterKey, PaymentMode } from '@prisma/client';

// ------------------------------------------------------------ salon-facing --

export const usageRouter = Router();

usageRouter.use(authenticate);

/** What the salon has used this month, and what is left. */
usageRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await service.usageSummary(req.auth!.tenantId))),
);

/** Plan limits — branches, staff, customers — with how close they are. */
usageRouter.get(
  '/limits',
  asyncHandler(async (req, res) => ok(res, await limitsSummary(req.auth!.tenantId))),
);

/** Everything the salon's plan includes, for the app to show or hide. */
usageRouter.get(
  '/plan',
  asyncHandler(async (req, res) => {
    const tenant = await runUnscoped(() =>
      prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, include: { plan: true } }),
    );
    return ok(res, {
      plan: tenant?.plan
        ? {
            code: tenant.plan.code,
            name: tenant.plan.name,
            pricePerMonth: tenant.plan.pricePerMonth,
            extraBranchPrice: tenant.plan.extraBranchPrice,
          }
        : null,
      features: enabledFeatures(tenant?.plan?.features),
    });
  }),
);

/**
 * The add-on catalogue the salon can buy from. Buying is not self-serve: there
 * is no payment gateway here, so the salon pays by UPI or transfer and the
 * platform records the top-up.
 */
usageRouter.get(
  '/packs',
  asyncHandler(async (req, res) => {
    const tenant = await runUnscoped(() =>
      prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { planId: true } }),
    );
    return ok(
      res,
      await service.listPacks({ activeOnly: true, planId: tenant?.planId ?? undefined }),
    );
  }),
);

/** Top-ups this salon has been given, most recent first. */
usageRouter.get(
  '/credits',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => ok(res, await service.creditHistory(req.auth!.tenantId))),
);

// -------------------------------------------------------- platform operator --

export const platformQuotaRouter = Router();

platformQuotaRouter.use(authenticatePlatform);

platformQuotaRouter.get(
  '/packs',
  validate({ query: listPacksQuery }),
  asyncHandler(async (req, res) => {
    const { activeOnly, planId } = req.query as unknown as { activeOnly?: string; planId?: string };
    return ok(res, await service.listPacks({ activeOnly: activeOnly === 'true', planId }));
  }),
);

platformQuotaRouter.post(
  '/packs',
  validate({ body: createPackSchema }),
  asyncHandler(async (req, res) => created(res, await service.createPack(req.body as PackInput))),
);

platformQuotaRouter.patch(
  '/packs/:id',
  validate({ params: idParam, body: updatePackSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await service.updatePack(req.params.id!, req.body as Partial<PackInput>)),
  ),
);

/** A salon's usage, seen from the console. */
platformQuotaRouter.get(
  '/tenants/:id/usage',
  validate({ params: idParam }),
  asyncHandler(async (req, res) =>
    ok(res, {
      usage: await service.usageSummary(req.params.id!),
      limits: await limitsSummary(req.params.id!),
      history: await service.creditHistory(req.params.id!, 20),
    }),
  ),
);

/**
 * Switch sending back on for a salon that overdrew its allowance.
 *
 * This is deliberately a human decision rather than an automatic reset: a salon
 * that overdraws every month and is unblocked by a cron job never has a reason
 * to pay. The operator does this once the money has arrived — usually alongside
 * a top-up, which is why both live on the same screen.
 */
platformQuotaRouter.post(
  '/tenants/:id/messaging/unblock',
  validate({
    params: idParam,
    body: z.object({
      /** Clear what they owe as well, which is the normal case after payment. */
      settleOwed: z.boolean().default(true),
      note: z.string().trim().max(240).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { settleOwed, note } = req.body as { settleOwed: boolean; note?: string };
    const by = req.platformAuth?.email ?? 'platform';

    const before = await service.sendingStatus(req.params.id!);
    const result = await service.unblockSending(req.params.id!, by, settleOwed);

    audit({
      action: 'messaging.unblocked',
      entity: 'TenantMessagingConfig',
      entityId: result.id,
      before: { blocked: before.blocked, owedMessages: before.owedMessages },
      after: { blocked: false, settleOwed, note: note ?? null, by },
    });

    return ok(res, { blocked: false, owedMessages: settleOwed ? 0 : before.owedMessages });
  }),
);

/** Every salon currently stopped, so nothing sits blocked and unnoticed. */
platformQuotaRouter.get(
  '/messaging/blocked',
  asyncHandler(async (_req, res) => ok(res, await service.blockedTenants())),
);

/**
 * Record a top-up after the salon has paid you off-platform. Either name a pack
 * from the catalogue, or set a meter and quantity directly (a goodwill credit,
 * or a correction — pass a negative quantity to take credits back).
 */
platformQuotaRouter.post(
  '/tenants/:id/credits',
  validate({ params: idParam, body: grantCreditsSchema }),
  asyncHandler(async (req, res) => {
    const tenantId = req.params.id!;
    const body = req.body as {
      packCode?: string;
      meter?: MeterKey;
      quantity?: number;
      amountPaid?: number;
      paymentMode?: PaymentMode;
      reference?: string;
      note?: string;
    };
    const createdBy = req.platformAuth?.email ?? 'platform';

    const result = body.packCode
      ? await service.redeemPack(tenantId, body.packCode, {
          amountPaid: body.amountPaid,
          paymentMode: body.paymentMode,
          reference: body.reference,
          createdBy,
        })
      : await service.grantCredits(tenantId, {
          meter: body.meter!,
          quantity: body.quantity!,
          amountPaid: body.amountPaid,
          paymentMode: body.paymentMode,
          reference: body.reference,
          note: body.note,
          createdBy,
        });

    audit({
      action: 'credits.granted',
      entity: 'CreditBalance',
      entityId: result.balance.id,
      after: { meter: result.balance.meter, delta: result.entry.delta, balance: result.balance.balance },
    });

    return created(res, result);
  }),
);

export default usageRouter;
