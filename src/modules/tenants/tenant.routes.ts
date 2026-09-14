import { Router } from 'express';
import { asyncHandler, created, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate, authenticatePlatform } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './tenant.service';
import * as renewals from './renewal.service';
import { provisionTenant } from './provisioning.service';
import {
  assignPlanSchema,
  createPlanSchema,
  createTenantSchema,
  listPlansQuery,
  listTenantsQuery,
  settingSchema,
  tenantStatusSchema,
  updatePlanSchema,
  updateTenantSchema,
} from './tenant.schema';
import type { ProvisionTenantInput } from './provisioning.service';
import type { PlanInput } from './tenant.service';
import type { TenantStatus } from '@prisma/client';

// -------------------------------------------------------- platform operator --

export const platformTenantRouter = Router();

platformTenantRouter.use(authenticatePlatform);

platformTenantRouter.post(
  '/tenants',
  validate({ body: createTenantSchema }),
  asyncHandler(async (req, res) => {
    const result = await provisionTenant(req.body as ProvisionTenantInput);
    return created(res, {
      tenant: result.tenant,
      branch: result.branch,
      owner: { id: result.owner.id, email: result.owner.email, name: result.owner.name },
    });
  }),
);

platformTenantRouter.get(
  '/tenants',
  validate({ query: listTenantsQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { page: number; pageSize: number; q?: string; status?: TenantStatus };
    const result = await service.listTenants(q);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

platformTenantRouter.get(
  '/tenants/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.getTenant(req.params.id!))),
);

platformTenantRouter.patch(
  '/tenants/:id',
  validate({ params: idParam, body: updateTenantSchema }),
  asyncHandler(async (req, res) => ok(res, await service.updateTenant(req.params.id!, req.body as Record<string, unknown>))),
);

platformTenantRouter.patch(
  '/tenants/:id/status',
  validate({ params: idParam, body: tenantStatusSchema }),
  asyncHandler(async (req, res) => {
    const { status } = req.body as { status: TenantStatus };
    return ok(res, await service.setTenantStatus(req.params.id!, status));
  }),
);

platformTenantRouter.post(
  '/tenants/:id/plan',
  validate({ params: idParam, body: assignPlanSchema }),
  asyncHandler(async (req, res) => {
    const { planCode, months, amount } = req.body as { planCode: string; months: number; amount?: number };
    return ok(res, await service.assignPlan(req.params.id!, planCode, months, amount));
  }),
);

platformTenantRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => ok(res, await service.platformStats())),
);

/** How one salon is actually doing — aggregate only, never their records. */
platformTenantRouter.get(
  '/tenants/:id/overview',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await service.tenantOverview(req.params.id!))),
);

// --------------------------------------------------------------- renewals --

/** Plans ending soon, and plans that have already lapsed. The working list. */
platformTenantRouter.get(
  '/renewals',
  asyncHandler(async (_req, res) =>
    ok(res, {
      upcoming: await renewals.subscriptionsDueForReminder(),
      lapsed: await renewals.lapsedTenants(),
    }),
  ),
);

/**
 * Send today's reminders now rather than waiting for the 08:00 sweep. Same
 * function, same once-per-milestone guard, so pressing it twice is harmless.
 */
platformTenantRouter.post(
  '/renewals/send-reminders',
  asyncHandler(async (_req, res) => ok(res, await renewals.sendRenewalReminders())),
);

// ------------------------------------------------------------------ plans --

platformTenantRouter.get(
  '/plans',
  validate({ query: listPlansQuery }),
  asyncHandler(async (req, res) => {
    const { activeOnly } = req.query as unknown as { activeOnly?: string };
    return ok(res, await service.listPlans(activeOnly === 'true'));
  }),
);

platformTenantRouter.post(
  '/plans',
  validate({ body: createPlanSchema }),
  asyncHandler(async (req, res) => created(res, await service.createPlan(req.body as PlanInput))),
);

platformTenantRouter.patch(
  '/plans/:id',
  validate({ params: idParam, body: updatePlanSchema }),
  asyncHandler(async (req, res) => ok(res, await service.updatePlan(req.params.id!, req.body as Partial<PlanInput>))),
);

/**
 * Only ever for a plan nobody is on. One that salons are using is retired with
 * PATCH { isActive: false }, which is what the console offers instead.
 */
platformTenantRouter.delete(
  '/plans/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await service.deletePlan(req.params.id!);
    audit({ action: 'plan.deleted', entity: 'Plan', entityId: req.params.id!, before: result });
    return ok(res, result);
  }),
);

// ------------------------------------------------------------ tenant-facing --

export const tenantRouter = Router();

tenantRouter.use(authenticate);

tenantRouter.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await service.getTenant(req.auth!.tenantId))),
);

tenantRouter.patch(
  '/',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  validate({ body: updateTenantSchema }),
  asyncHandler(async (req, res) => {
    const tenant = await service.updateTenant(req.auth!.tenantId, req.body as Record<string, unknown>);
    audit({ action: 'tenant.updated', entity: 'Tenant', entityId: tenant.id, after: req.body });
    return ok(res, tenant);
  }),
);

tenantRouter.get(
  '/settings',
  asyncHandler(async (req, res) => ok(res, await service.getSettings(req.auth!.tenantId, req.branchId))),
);

tenantRouter.put(
  '/settings',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate({ body: settingSchema }),
  asyncHandler(async (req, res) => {
    const { key, value, branchId } = req.body as { key: string; value: unknown; branchId?: string };
    const setting = await service.upsertSetting(req.auth!.tenantId, key, value, branchId);
    audit({ action: 'settings.updated', entity: 'Setting', entityId: setting.id, after: { key, value } });
    return ok(res, setting);
  }),
);

export default tenantRouter;
