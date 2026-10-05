import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema } from '../../core/validators';
import { HAIRSTYLE_KINDS } from './hairstyle-kinds';
import {
  BALAYAGE_PLACEMENTS,
  BANGS,
  FADE_TYPES,
  INTENSITIES,
  LAYERS,
  PARTINGS,
  designConfigSchema,
} from './design-rules';
import * as studio from './hair-studio.service';

/**
 * THE HAIR DESIGN STUDIO.
 *
 * Two audiences on one router, split by permission rather than by path:
 *
 *   SERVICE_VIEW    look at the catalogue and design a look
 *   SERVICE_MANAGE  change what the salon offers
 *
 * Designing sits under SERVICE_VIEW on purpose. A stylist holds that already,
 * and designing a look is reading the menu aloud with a customer — it changes
 * nothing about the salon. Requiring SERVICE_MANAGE would mean only the owner
 * could use the product in the room where it is useful.
 *
 * Deliberately NOT behind a plan feature. Flip that decision the day the 3D
 * studio costs real money to serve; today it is arithmetic over a salon's own
 * catalogue, and the salons most likely to be won by seeing it are the ones on
 * the cheapest plan.
 */
export const hairStudioRouter = Router();
hairStudioRouter.use(authenticate);

const textureEnum = z.enum(['STRAIGHT', 'WAVY', 'CURLY', 'COILY']);
const lengthEnum = z.enum(['VERY_SHORT', 'SHORT', 'MEDIUM', 'LONG', 'VERY_LONG']);
const densityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const faceShapeEnum = z.enum(['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND']);
const maintenanceEnum = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const genderEnum = z.enum(['MALE', 'FEMALE', 'UNISEX']);

// ------------------------------------------------------- what exists -------

/**
 * The generator registry, and the vocabulary that goes with it.
 *
 * The configurator reads this rather than hard-coding its own copy of the
 * option lists, so a control the backend will reject never appears on screen in
 * the first place.
 */
hairStudioRouter.get(
  '/kinds',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  asyncHandler(async (_req, res) =>
    ok(res, {
      kinds: HAIRSTYLE_KINDS,
      options: {
        textures: textureEnum.options,
        lengths: lengthEnum.options,
        densities: densityEnum.options,
        faceShapes: faceShapeEnum.options,
        maintenance: maintenanceEnum.options,
        intensities: INTENSITIES,
        bangs: BANGS,
        layers: LAYERS,
        partings: PARTINGS,
        fadeTypes: FADE_TYPES,
        balayagePlacements: BALAYAGE_PLACEMENTS,
      },
    }),
  ),
);

// --------------------------------------------------------- catalogue -------

const hairstyleBody = z.object({
  kind: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).nullable().optional(),
  gender: genderEnum.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  supportedTextures: z.array(textureEnum).max(4).optional(),
  supportedLengths: z.array(lengthEnum).max(5).optional(),
  supportedDensities: z.array(densityEnum).max(3).optional(),
  recommendedFaceShapes: z.array(faceShapeEnum).max(6).optional(),
  supportsBangs: z.boolean().optional(),
  supportsLayers: z.boolean().optional(),
  supportsParting: z.boolean().optional(),
  supportsFade: z.boolean().optional(),
  maintenance: maintenanceEnum.optional(),
  serviceId: idSchema.nullable().optional(),
  previewUrl: z.string().trim().url().max(500).nullable().optional(),
  branchId: idSchema.nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

hairStudioRouter.get(
  '/hairstyles',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    query: z.object({
      branchId: idSchema.optional(),
      activeOnly: z.enum(['true', 'false']).optional(),
      gender: genderEnum.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as { branchId?: string; activeOnly?: string; gender?: 'MALE' | 'FEMALE' | 'UNISEX' };
    return ok(
      res,
      await studio.listHairstyles({
        branchId: q.branchId,
        activeOnly: q.activeOnly === 'true',
        gender: q.gender,
      }),
    );
  }),
);

hairStudioRouter.get(
  '/hairstyles/:id',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await studio.getHairstyle(req.params.id!))),
);

hairStudioRouter.post(
  '/hairstyles',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ body: hairstyleBody }),
  asyncHandler(async (req, res) => {
    const style = await studio.createHairstyle(req.body as studio.HairstyleInput);
    audit({ action: 'hairstyle.created', entity: 'HairstyleCatalog', entityId: style.id, after: { kind: style.kind, name: style.name } });
    return created(res, style);
  }),
);

hairStudioRouter.patch(
  '/hairstyles/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam, body: hairstyleBody.partial() }),
  asyncHandler(async (req, res) => {
    const patch = req.body as Partial<studio.HairstyleInput>;
    const style = await studio.updateHairstyle(req.params.id!, patch);
    audit({ action: 'hairstyle.updated', entity: 'HairstyleCatalog', entityId: style.id, after: patch });
    return ok(res, style);
  }),
);

/** Fill an empty catalogue from the registry. Safe to run twice. */
hairStudioRouter.post(
  '/hairstyles/install-starter',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ body: z.object({ branchId: idSchema.nullable().optional() }).optional() }),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { branchId?: string | null };
    const result = await studio.installStarterCatalog({ branchId: body.branchId ?? null });
    audit({ action: 'hairstyle.starter_installed', entity: 'HairstyleCatalog', after: result });
    return ok(res, result);
  }),
);

// ----------------------------------------------------------- designs -------

const designBody = z.object({
  name: z.string().trim().min(1).max(120),
  catalogId: idSchema,
  modelKey: z.string().trim().min(1).max(64),
  texture: textureEnum,
  length: lengthEnum,
  density: densityEnum.optional(),
  volume: z.number().int().min(0).max(100).optional(),
  baseColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'A colour must be a hex value like #3B2417'),
  config: designConfigSchema.optional(),
  customerId: idSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  serviceId: idSchema.nullable().optional(),
  staffId: idSchema.nullable().optional(),
  branchId: idSchema.nullable().optional(),
  isCurrent: z.boolean().optional(),
});

hairStudioRouter.get(
  '/designs',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    query: z.object({
      customerId: idSchema.optional(),
      branchId: idSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { customerId?: string; branchId?: string; limit?: number };
    return ok(res, await studio.listDesigns(q));
  }),
);

/** A customer's looks over time, with the one they are wearing pulled out. */
hairStudioRouter.get(
  '/designs/history/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await studio.customerHistory(req.params.id!))),
);

hairStudioRouter.get(
  '/designs/:id',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await studio.getDesign(req.params.id!))),
);

hairStudioRouter.post(
  '/designs',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ body: designBody }),
  asyncHandler(async (req, res) => {
    const design = await studio.createDesign(req.body as studio.DesignInput);
    return created(res, design);
  }),
);

hairStudioRouter.patch(
  '/designs/:id',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam, body: designBody.partial() }),
  asyncHandler(async (req, res) =>
    ok(res, await studio.updateDesign(req.params.id!, req.body as Partial<studio.DesignInput>)),
  ),
);

hairStudioRouter.post(
  '/designs/:id/current',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await studio.setCurrentDesign(req.params.id!))),
);

/** What to preselect in the booking flow. The studio books nothing itself. */
hairStudioRouter.get(
  '/designs/:id/booking-intent',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await studio.bookingIntent(req.params.id!))),
);

hairStudioRouter.post(
  '/designs/:id/appointment',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam, body: z.object({ appointmentId: idSchema }) }),
  asyncHandler(async (req, res) => {
    const { appointmentId } = req.body as { appointmentId: string };
    return ok(res, await studio.attachAppointment(req.params.id!, appointmentId));
  }),
);

hairStudioRouter.delete(
  '/designs/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await studio.deleteDesign(req.params.id!);
    audit({ action: 'hair_design.deleted', entity: 'HairDesign', entityId: req.params.id! });
    return noContent(res);
  }),
);

export default hairStudioRouter;
