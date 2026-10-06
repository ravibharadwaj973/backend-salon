import { Prisma } from '@prisma/client';
import type { FaceShape, Gender, HairDensity, HairLength, HairMaintenance, HairTexture } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, currentUserId } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, NotFound, Conflict } from '../../core/errors';
import { logger } from '../../core/logger';
import { thumbnail } from '../gallery/thumbnail';
import { HAIRSTYLE_KINDS, isKnownKind, kindByKey, knownKindKeys } from './hairstyle-kinds';
import {
  checkCatalogEntry,
  checkDesign,
  designConfigSchema,
  normaliseConfig,
  type DesignConfig,
  type StyleCapabilities,
} from './design-rules';

/**
 * THE HAIR DESIGN STUDIO, MINUS THE PIXELS.
 *
 * The 3D studio is a drawing of this data. What lives here is the part that has
 * to be true a year later: which styles the salon offers, what each one allows,
 * what a customer chose, and which appointment it turned into.
 */

// ============================== the catalogue ==============================

export interface HairstyleInput {
  kind: string;
  name: string;
  category?: string | null;
  gender?: Gender;
  description?: string | null;
  supportedTextures?: HairTexture[];
  supportedLengths?: HairLength[];
  supportedDensities?: HairDensity[];
  recommendedFaceShapes?: FaceShape[];
  supportsBangs?: boolean;
  supportsLayers?: boolean;
  supportsParting?: boolean;
  supportsFade?: boolean;
  maintenance?: HairMaintenance;
  serviceId?: string | null;
  previewUrl?: string | null;
  branchId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

/**
 * A SMALL VERSION OF THE PICTURE, ADDED ON THE WAY OUT.
 *
 * Derived rather than stored, for the reason in thumbnail.ts: a second column
 * holding the same fact drifts from the first, and a look-book showing last
 * month's haircut beside this month's name errors nowhere.
 *
 * It matters most on the grid, which is the one screen that loads thirty-odd
 * portraits at once over a salon's phone connection.
 */
function withThumbnail<T extends { previewUrl: string | null }>(row: T) {
  return { ...row, thumbnailUrl: thumbnail(row.previewUrl, { width: 400 }) };
}

export async function listHairstyles(input: {
  branchId?: string;
  activeOnly?: boolean;
  gender?: Gender;
}) {
  const tenantId = requireTenantId();
  const rows = await prisma.hairstyleCatalog.findMany({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      ...(input.activeOnly ? { isActive: true } : {}),
      // UNISEX styles belong in both lists, so a gender filter widens to include
      // them rather than hiding the half of the menu that suits everybody.
      ...(input.gender ? { gender: { in: [input.gender, 'UNISEX'] } } : {}),
    },
    include: {
      service: { select: { id: true, name: true, price: true, durationMin: true } },
      /**
       * HOW OFTEN THIS SALON HAS ACTUALLY CHOSEN IT.
       *
       * So that a "popular" tab can be a fact rather than a label. Every product
       * with a trending section is tempted to fill it with whatever the team
       * wants to sell, and a salon can tell within a week — this is the salon's
       * OWN saved looks, which is the only popularity that means anything to the
       * person reading it.
       *
       * One grouped count, not a query per row.
       */
      _count: { select: { designs: true } },
    },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((row) => {
    const { _count, ...rest } = row;
    return { ...withThumbnail(rest), timesChosen: _count.designs };
  });
}

export async function getHairstyle(id: string) {
  const tenantId = requireTenantId();
  const style = await prisma.hairstyleCatalog.findFirst({
    where: { id, tenantId },
    include: { service: { select: { id: true, name: true, price: true, durationMin: true } } },
  });
  if (!style) throw NotFound('Hairstyle not found');
  return withThumbnail(style);
}

function assertEntryIsDrawable(input: Partial<HairstyleInput> & { kind: string }): void {
  if (!isKnownKind(input.kind)) {
    throw BadRequest(
      `"${input.kind}" is not a style the studio can draw. Pick one of: ${knownKindKeys().join(', ')}`,
    );
  }
  const errors = checkCatalogEntry({ ...input, kind: input.kind });
  if (errors.length) throw BadRequest(errors.join(' '));
}

export async function createHairstyle(input: HairstyleInput) {
  const tenantId = requireTenantId();
  assertEntryIsDrawable(input);

  if (input.serviceId) await assertServiceExists(input.serviceId);

  return prisma.hairstyleCatalog.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      kind: input.kind,
      name: input.name,
      category: input.category ?? kindByKey(input.kind)?.category ?? null,
      gender: input.gender ?? kindByKey(input.kind)?.gender ?? 'UNISEX',
      description: input.description ?? null,
      supportedTextures: input.supportedTextures ?? [],
      supportedLengths: input.supportedLengths ?? [],
      supportedDensities: input.supportedDensities ?? [],
      recommendedFaceShapes: input.recommendedFaceShapes ?? [],
      supportsBangs: input.supportsBangs ?? false,
      supportsLayers: input.supportsLayers ?? false,
      supportsParting: input.supportsParting ?? true,
      supportsFade: input.supportsFade ?? false,
      maintenance: input.maintenance ?? 'MEDIUM',
      serviceId: input.serviceId ?? null,
      previewUrl: input.previewUrl ?? null,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export async function updateHairstyle(id: string, input: Partial<HairstyleInput>) {
  const existing = await getHairstyle(id);

  /*
   * Validated against the MERGED entry, not the patch. A request that only
   * turns on `supportsFade` carries no `kind`, and checking the patch alone
   * would wave through a fade on a bob.
   */
  const merged = {
    kind: input.kind ?? existing.kind,
    supportedTextures: input.supportedTextures ?? existing.supportedTextures,
    supportedLengths: input.supportedLengths ?? existing.supportedLengths,
    supportedDensities: input.supportedDensities ?? existing.supportedDensities,
    supportsBangs: input.supportsBangs ?? existing.supportsBangs,
    supportsLayers: input.supportsLayers ?? existing.supportsLayers,
    supportsParting: input.supportsParting ?? existing.supportsParting,
    supportsFade: input.supportsFade ?? existing.supportsFade,
  };
  assertEntryIsDrawable(merged);

  if (input.serviceId) await assertServiceExists(input.serviceId);

  return prisma.hairstyleCatalog.update({
    where: { id },
    data: {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.supportedTextures !== undefined ? { supportedTextures: input.supportedTextures } : {}),
      ...(input.supportedLengths !== undefined ? { supportedLengths: input.supportedLengths } : {}),
      ...(input.supportedDensities !== undefined ? { supportedDensities: input.supportedDensities } : {}),
      ...(input.recommendedFaceShapes !== undefined ? { recommendedFaceShapes: input.recommendedFaceShapes } : {}),
      ...(input.supportsBangs !== undefined ? { supportsBangs: input.supportsBangs } : {}),
      ...(input.supportsLayers !== undefined ? { supportsLayers: input.supportsLayers } : {}),
      ...(input.supportsParting !== undefined ? { supportsParting: input.supportsParting } : {}),
      ...(input.supportsFade !== undefined ? { supportsFade: input.supportsFade } : {}),
      ...(input.maintenance !== undefined ? { maintenance: input.maintenance } : {}),
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
      ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  });
}

async function assertServiceExists(serviceId: string): Promise<void> {
  const tenantId = requireTenantId();
  const service = await prisma.service.findFirst({ where: { id: serviceId, tenantId }, select: { id: true } });
  if (!service) throw BadRequest('That service does not exist in this salon.');
}

/**
 * Give a salon a menu to start from.
 *
 * Nobody types thirty hairstyles into a form before they will try a product
 * once, so an empty studio is a studio that never gets used. Existing names are
 * skipped rather than overwritten: this is safe to run twice, and a salon that
 * has already renamed "Low fade" keeps its name.
 */
export async function installStarterCatalog(input: { branchId?: string | null } = {}) {
  const tenantId = requireTenantId();

  const existing = await prisma.hairstyleCatalog.findMany({
    where: { tenantId },
    select: { kind: true, name: true },
  });
  const taken = new Set(existing.map((row) => `${row.kind}::${row.name}`));

  const rows: Prisma.HairstyleCatalogCreateManyInput[] = [];
  let sortOrder = 0;

  for (const kind of HAIRSTYLE_KINDS) {
    for (const name of kind.variants) {
      sortOrder += 1;
      if (taken.has(`${kind.key}::${name}`)) continue;
      rows.push({
        tenantId,
        branchId: input.branchId ?? null,
        kind: kind.key,
        name,
        category: kind.category,
        gender: kind.gender,
        supportedTextures: kind.textures,
        supportedLengths: kind.lengths,
        supportedDensities: kind.densities,
        recommendedFaceShapes: kind.faceShapes,
        supportsBangs: kind.supportsBangs,
        supportsLayers: kind.supportsLayers,
        supportsParting: kind.supportsParting,
        supportsFade: kind.supportsFade,
        maintenance: kind.maintenance,
        sortOrder,
      });
    }
  }

  if (rows.length === 0) return { created: 0, skipped: taken.size };

  const result = await prisma.hairstyleCatalog.createMany({ data: rows, skipDuplicates: true });
  return { created: result.count, skipped: taken.size };
}

// ================================ designs ==================================

export interface DesignInput {
  name: string;
  catalogId?: string | null;
  modelKey: string;
  texture: HairTexture;
  length: HairLength;
  density?: HairDensity;
  volume?: number;
  baseColor: string;
  config?: unknown;
  customerId?: string | null;
  notes?: string | null;
  serviceId?: string | null;
  staffId?: string | null;
  branchId?: string | null;
  isCurrent?: boolean;
}

function capabilitiesOf(style: {
  kind: string;
  supportedTextures: HairTexture[];
  supportedLengths: HairLength[];
  supportedDensities: HairDensity[];
  supportsBangs: boolean;
  supportsLayers: boolean;
  supportsParting: boolean;
  supportsFade: boolean;
}): StyleCapabilities {
  return {
    kind: style.kind,
    supportedTextures: style.supportedTextures,
    supportedLengths: style.supportedLengths,
    supportedDensities: style.supportedDensities,
    supportsBangs: style.supportsBangs,
    supportsLayers: style.supportsLayers,
    supportsParting: style.supportsParting,
    supportsFade: style.supportsFade,
  };
}

/**
 * Parse and check a design against the style it claims to be.
 *
 * Returns the pieces the caller needs to write: the normalised config and the
 * hairstyleKey to snapshot onto the row.
 */
async function prepareDesign(input: DesignInput, catalogId: string | null) {
  if (!catalogId) throw BadRequest('A design needs a hairstyle from the catalogue.');
  const style = await getHairstyle(catalogId);

  const parsed = designConfigSchema.safeParse(input.config ?? {});
  if (!parsed.success) {
    throw BadRequest(parsed.error.issues.map((issue) => issue.message).join(' '));
  }

  const capabilities = capabilitiesOf(style);
  const shape = {
    texture: input.texture,
    length: input.length,
    density: input.density ?? 'MEDIUM',
    volume: input.volume ?? 50,
    baseColor: input.baseColor,
    config: parsed.data,
  };

  const errors = checkDesign(capabilities, shape);
  if (errors.length) throw BadRequest(errors.join(' '));

  return {
    style,
    config: normaliseConfig(capabilities, parsed.data) as unknown as Prisma.InputJsonValue,
    shape,
  };
}

export async function createDesign(input: DesignInput) {
  const tenantId = requireTenantId();
  const { style, config, shape } = await prepareDesign(input, input.catalogId ?? null);

  if (input.customerId) await assertCustomerExists(input.customerId);
  if (input.serviceId) await assertServiceExists(input.serviceId);

  const design = await prisma.hairDesign.create({
    data: {
      tenantId,
      branchId: input.branchId ?? style.branchId ?? null,
      customerId: input.customerId ?? null,
      catalogId: style.id,
      name: input.name,
      // The snapshot. Everything else about this row may be edited later; this
      // is what redraws the look when the catalogue has moved on.
      hairstyleKey: style.kind,
      modelKey: input.modelKey,
      texture: shape.texture,
      length: shape.length,
      density: shape.density,
      volume: shape.volume,
      baseColor: shape.baseColor,
      config,
      notes: input.notes ?? null,
      // Falls back to the style's own service, so "Book this look" works
      // without the studio having to pass it every time.
      serviceId: input.serviceId ?? style.serviceId ?? null,
      staffId: input.staffId ?? null,
      createdById: currentUserId(),
    },
  });

  if (input.isCurrent && design.customerId) await setCurrentDesign(design.id);
  return getDesign(design.id);
}

export async function updateDesign(id: string, input: Partial<DesignInput>) {
  const existing = await getDesign(id);

  /*
   * An edit is re-checked against the style as a whole, for the same reason the
   * catalogue patch is: a request that only changes the length must still be
   * judged against the texture and config already on the row.
   */
  const merged: DesignInput = {
    name: input.name ?? existing.name,
    catalogId: input.catalogId ?? existing.catalogId,
    modelKey: input.modelKey ?? existing.modelKey,
    texture: input.texture ?? existing.texture,
    length: input.length ?? existing.length,
    density: input.density ?? existing.density,
    volume: input.volume ?? existing.volume,
    baseColor: input.baseColor ?? existing.baseColor,
    config: input.config ?? existing.config,
    notes: input.notes !== undefined ? input.notes : existing.notes,
  };

  const { style, config, shape } = await prepareDesign(merged, merged.catalogId ?? null);

  if (input.customerId) await assertCustomerExists(input.customerId);
  if (input.serviceId) await assertServiceExists(input.serviceId);

  await prisma.hairDesign.update({
    where: { id },
    data: {
      name: merged.name,
      catalogId: style.id,
      hairstyleKey: style.kind,
      modelKey: merged.modelKey,
      texture: shape.texture,
      length: shape.length,
      density: shape.density,
      volume: shape.volume,
      baseColor: shape.baseColor,
      config,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
      ...(input.staffId !== undefined ? { staffId: input.staffId } : {}),
    },
  });

  if (input.isCurrent) await setCurrentDesign(id);
  return getDesign(id);
}

const DESIGN_INCLUDE = {
  catalog: { select: { id: true, kind: true, name: true, maintenance: true } },
  service: { select: { id: true, name: true, price: true, durationMin: true } },
  staff: { select: { id: true, displayName: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  appointment: { select: { id: true, startAt: true, status: true } },
} satisfies Prisma.HairDesignInclude;

export async function getDesign(id: string) {
  const tenantId = requireTenantId();
  const design = await prisma.hairDesign.findFirst({ where: { id, tenantId }, include: DESIGN_INCLUDE });
  if (!design) throw NotFound('Design not found');
  return design;
}

export async function listDesigns(input: { customerId?: string; branchId?: string; limit?: number }) {
  const tenantId = requireTenantId();
  return prisma.hairDesign.findMany({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    include: DESIGN_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(input.limit ?? 50, 200),
  });
}

/**
 * THE CUSTOMER'S HAIR OVER TIME.
 *
 * The current look is pulled out rather than left for the caller to find, since
 * every screen that shows this wants "what they are wearing now" above "what
 * they have tried".
 */
export async function customerHistory(customerId: string) {
  const tenantId = requireTenantId();
  await assertCustomerExists(customerId);

  const designs = await prisma.hairDesign.findMany({
    where: { tenantId, customerId },
    include: DESIGN_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
    take: 100,
  });

  return {
    current: designs.find((design) => design.isCurrent) ?? null,
    designs,
  };
}

/**
 * Make this the look the customer is wearing.
 *
 * The clear-then-set runs in one transaction, and the database carries a
 * partial unique index behind it. Both, because two stylists saving for the
 * same customer at the same moment is an ordinary Saturday, and a customer
 * record with two current hairstyles cannot be untangled afterwards.
 */
export async function setCurrentDesign(id: string) {
  const design = await getDesign(id);
  if (!design.customerId) {
    throw BadRequest('A design has to belong to a customer before it can be their current look.');
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.hairDesign.updateMany({
        where: { customerId: design.customerId!, isCurrent: true, id: { not: id } },
        data: { isCurrent: false },
      });
      await tx.hairDesign.update({ where: { id }, data: { isCurrent: true } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw Conflict('Somebody else set this customer’s current look a moment ago. Try again.');
    }
    throw error;
  }

  return getDesign(id);
}

export async function deleteDesign(id: string) {
  await getDesign(id);
  await prisma.hairDesign.delete({ where: { id } });
}

async function assertCustomerExists(customerId: string): Promise<void> {
  const tenantId = requireTenantId();
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId }, select: { id: true } });
  if (!customer) throw BadRequest('That customer does not exist in this salon.');
}

// =========================== book this look ================================

/**
 * WHAT "BOOK THIS LOOK" NEEDS TO KNOW.
 *
 * The studio does not book anything itself — appointments have one way in, and
 * a second one written here would drift from it. This hands back the service to
 * preselect, and the booking flow does what it always does.
 */
export async function bookingIntent(id: string) {
  const design = await getDesign(id);

  if (!design.service) {
    return {
      designId: design.id,
      serviceId: null as string | null,
      // Said plainly, because the fix is in the catalogue and the person reading
      // this is the one who can make it.
      reason: 'This style has no service attached yet, so there is nothing to book. Add one in the hairstyle catalogue.',
    };
  }

  return {
    designId: design.id,
    serviceId: design.service.id,
    serviceName: design.service.name,
    price: design.service.price,
    durationMin: design.service.durationMin,
    customerId: design.customerId,
    staffId: design.staffId,
    reason: null as string | null,
  };
}

/**
 * Tie a design to the appointment it produced.
 *
 * Checked rather than trusted: an appointment id arriving from a browser is a
 * claim, and linking a design to another customer's appointment would put one
 * customer's chosen look on another customer's record.
 */
export async function attachAppointment(id: string, appointmentId: string) {
  const tenantId = requireTenantId();
  const design = await getDesign(id);

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    select: { id: true, customerId: true, branchId: true },
  });
  if (!appointment) throw BadRequest('That appointment does not exist in this salon.');

  if (design.customerId && appointment.customerId && design.customerId !== appointment.customerId) {
    throw BadRequest('That appointment belongs to a different customer.');
  }

  await prisma.hairDesign.update({
    where: { id },
    data: {
      appointmentId: appointment.id,
      // A design made on the counter tablet has no customer until it is booked.
      // This is the moment one appears, so take it.
      ...(design.customerId ? {} : { customerId: appointment.customerId }),
      ...(design.branchId ? {} : { branchId: appointment.branchId }),
    },
  });

  logger.info({ designId: id, appointmentId }, 'hair design booked');
  return getDesign(id);
}

export type { DesignConfig };
