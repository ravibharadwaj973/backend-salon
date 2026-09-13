import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { ALL_ROLES, PAGES, describeLayout, normaliseLayout, type PageKey } from '../../core/page-layouts';
import { settingValue, upsertSetting } from '../tenants/tenant.service';

/**
 * "Who sees what" — the owner's control over which sections of a page each
 * role gets. One matrix per sectioned page; see core/page-layouts.ts for the
 * two rules that decide a section's visibility.
 */
const router = Router();
router.use(authenticate);

const pageParam = z.object({ page: z.enum(Object.keys(PAGES) as [PageKey, ...PageKey[]]) });

/** Every page's matrix at once — what Settings shows. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const canManage = auth.permissions.has(PERMISSIONS.SETTINGS_MANAGE);
    const pages = await Promise.all(
      Object.values(PAGES).map(async (def) => {
        const layout = normaliseLayout(def, await settingValue<unknown>(auth.tenantId, def.settingKey, {}));
        return describeLayout(def, { role: auth.role, permissions: auth.permissions }, layout, canManage);
      }),
    );
    return ok(res, pages);
  }),
);

router.get(
  '/:page',
  validate({ params: pageParam }),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const def = PAGES[req.params.page as PageKey];
    const layout = normaliseLayout(def, await settingValue<unknown>(auth.tenantId, def.settingKey, {}));
    return ok(res, describeLayout(def, { role: auth.role, permissions: auth.permissions }, layout, auth.permissions.has(PERMISSIONS.SETTINGS_MANAGE)));
  }),
);

router.put(
  '/:page',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  validate({
    params: pageParam,
    body: z.object({
      sections: z.record(z.string().max(40), z.array(z.enum(ALL_ROLES as [string, ...string[]])).max(ALL_ROLES.length)),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = req.auth!;
    const def = PAGES[req.params.page as PageKey];
    const before = await settingValue<unknown>(auth.tenantId, def.settingKey, {});
    const layout = normaliseLayout(def, (req.body as { sections: unknown }).sections);
    const setting = await upsertSetting(auth.tenantId, def.settingKey, layout);
    audit({ action: 'settings.updated', entity: 'Setting', entityId: setting.id, before: { layout: before }, after: { page: def.page, layout } });
    return ok(res, describeLayout(def, { role: auth.role, permissions: auth.permissions }, layout, true));
  }),
);

export default router;
