import { Router } from 'express';
import { z } from 'zod';
import { accepted, asyncHandler, created, noContent, ok } from '../../core/http';
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
import * as generation from './hair-generation.service';
import * as analysis from './hair-analysis.service';

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

// ------------------------------------------------------- generated images --

/**
 * PHOTOGRAPHIC PREVIEWS.
 *
 * Three routes and no fourth: ask for one, read one, list them. There is
 * deliberately no endpoint that takes a prompt. Every picture is built from a
 * SAVED DESIGN, which means every picture is of something the salon can actually
 * cut — and it means nobody can type a name into a box and get a photograph of a
 * real person back out.
 *
 * `POST` answers 202 with a PENDING row rather than the picture. It takes tens
 * of seconds and costs money; holding the request open would lose it the moment
 * the salon's phone slept, after it had been paid for.
 */
hairStudioRouter.get(
  '/generations/status',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  asyncHandler(async (_req, res) => ok(res, await generation.generationStatus())),
);

hairStudioRouter.get(
  '/generations',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    query: z.object({
      designId: idSchema.optional(),
      customerId: idSchema.optional(),
      branchId: idSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, await generation.listGenerations(req.query as unknown as Parameters<typeof generation.listGenerations>[0])),
  ),
);

hairStudioRouter.get(
  '/generations/:id',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await generation.getGeneration(req.params.id!))),
);

hairStudioRouter.post(
  '/generations',
  /**
   * SERVICE_VIEW, like designing — not SERVICE_MANAGE.
   *
   * It spends money, which argues for the owner's permission, and that would put
   * the feature behind the one person who is not in the room when it is useful.
   * The spend is bounded by a per-salon daily cap instead, which is the control
   * that actually matches the risk.
   */
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    body: z.object({
      kind: z.enum(['MODEL_PORTRAIT', 'STYLE_PREVIEW', 'RECOLOUR', 'CUSTOMER_PREVIEW']).default('MODEL_PORTRAIT'),
      designId: idSchema,
      customerId: idSchema.nullable().optional(),
      branchId: idSchema.nullable().optional(),
      sourceGenerationId: idSchema.nullable().optional(),
      /** CUSTOMER_PREVIEW only: the reading holding their consented photo. */
      sourceAnalysisId: idSchema.nullable().optional(),
      /**
       * Bounded to what the provider accepts as a seed. Allowed to be chosen
       * because "that same model again, in copper" is the first thing any salon
       * asks for, and the seed is the only thing that makes her the same woman.
       */
      seed: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const row = await generation.requestGeneration(req.body as generation.GenerationInput);
    audit({
      action: 'hair_generation.requested',
      entity: 'HairGeneration',
      entityId: row.id,
      after: { kind: row.kind, designId: row.designId, model: row.model },
    });
    // 202, not 201: the row exists, the picture does not yet.
    return accepted(res, row);
  }),
);

// --------------------------------------------- readings and the advisor ----

const hairlineEnum = z.enum(['STRAIGHT', 'ROUNDED', 'WIDOWS_PEAK', 'RECEDING', 'UNEVEN']);

/**
 * WHAT THIS PERSON'S HAIR ACTUALLY IS, AND WHICH CUTS SUIT IT.
 *
 * Two endpoints and a deliberate asymmetry between them:
 *
 *   A READING IS A WRITE, and needs CUSTOMER_MANAGE when it is attached to
 *   somebody. It can hold a photograph of their face, so it is not something a
 *   read-only role creates.
 *
 *   A RECOMMENDATION IS ARITHMETIC over the salon's own menu and needs nothing
 *   but SERVICE_VIEW. A stylist asking "what would suit her" is reading the menu
 *   aloud, which is the moment the product is useful.
 */
hairStudioRouter.post(
  '/analyses',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({
    body: z.object({
      customerId: idSchema.nullable().optional(),
      branchId: idSchema.nullable().optional(),
      /**
       * A data URL, matching how the logo and gallery uploads already work.
       * Bounded here as well as in the decoder: an eight-megabyte base64 body
       * should be refused by the validator rather than buffered and then
       * rejected.
       */
      photo: z.string().max(15_000_000).nullable().optional(),
      /**
       * Required with a photo, and the service refuses without it rather than
       * trusting this flag alone. A face stored without a yes cannot be
       * un-stored.
       */
      consent: z.boolean().optional(),
      faceShape: faceShapeEnum.nullable().optional(),
      texture: textureEnum.nullable().optional(),
      density: densityEnum.nullable().optional(),
      length: lengthEnum.nullable().optional(),
      volume: z.number().int().min(0).max(100).nullable().optional(),
      hairline: hairlineEnum.nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const row = await analysis.createAnalysis(req.body as analysis.AnalysisInput);
    audit({
      action: 'hair_analysis.created',
      entity: 'HairAnalysis',
      entityId: row.id,
      // The reading's source and whether a photo was kept — never the photo, and
      // never the reading itself, which is personal data about a named customer.
      after: { source: row.source, photoStored: !!row.imagePublicId },
    });
    return created(res, row);
  }),
);

/** The newest reading for a customer, which is the only one anybody wants. */
hairStudioRouter.get(
  '/analyses/customer/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await analysis.latestAnalysis(req.params.id!))),
);

hairStudioRouter.get(
  '/analyses/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => ok(res, await analysis.getAnalysis(req.params.id!))),
);

/**
 * FORGET THE PHOTOGRAPH.
 *
 * Exists because somebody will ask, and because an app that stores faces without
 * a way to remove them is not one a salon should be running. It deletes the
 * generated previews made from it too — those are the same person's face.
 */
hairStudioRouter.delete(
  '/analyses/:id',
  requirePermission(PERMISSIONS.CUSTOMER_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await analysis.deleteAnalysis(req.params.id!);
    audit({ action: 'hair_analysis.deleted', entity: 'HairAnalysis', entityId: req.params.id!, after: result });
    return ok(res, result);
  }),
);

/**
 * THE ADVISOR, AND THE APPLICATION OWNS THE RANKING.
 *
 * Weighted arithmetic over the salon's own active catalogue — face 30, texture
 * 25, length 15, density 10, stated preference 10, upkeep 10 — with every score
 * returned decomposed into its factors. No model is consulted and none is needed:
 * it answers offline, instantly, identically every time, and can be argued with.
 */
hairStudioRouter.post(
  '/recommendations',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  validate({
    body: z.object({
      analysisId: idSchema.nullable().optional(),
      customerId: idSchema.nullable().optional(),
      // Everything below overrides the stored reading, field by field, so a
      // stylist can try "what if her hair were longer" without saving anything.
      faceShape: faceShapeEnum.nullable().optional(),
      texture: textureEnum.nullable().optional(),
      density: densityEnum.nullable().optional(),
      length: lengthEnum.nullable().optional(),
      gender: genderEnum.nullable().optional(),
      preferences: z
        .object({
          desiredLength: lengthEnum.nullable().optional(),
          maintenance: maintenanceEnum.nullable().optional(),
          likedKinds: z.array(z.string().trim().max(64)).max(30).optional(),
          dislikedKinds: z.array(z.string().trim().max(64)).max(30).optional(),
          wantsBangs: z.boolean().nullable().optional(),
          wantsFade: z.boolean().nullable().optional(),
        })
        .optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await analysis.recommendFor(req.body as analysis.RecommendInput))),
);

export default hairStudioRouter;
