import type {
  FaceShape,
  Gender,
  HairAnalysis,
  HairDensity,
  HairLength,
  HairTexture,
  HairlineShape,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../core/prisma';
import { requireTenantId, currentUserId, runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { logger } from '../../core/logger';
import { visionJson } from '../../core/ai';
import { decodeDataUrl, destroyImage, uploadBytes } from '../gallery/cloudinary';
import { recommend, type Candidate, type HairPreferences, type HairProfile } from './recommendation';

/**
 * READING A CUSTOMER'S HAIR, AND WHO IS ALLOWED TO BE WRONG ABOUT IT.
 *
 * The advisor needs six facts: face shape, texture, density, current length,
 * volume and hairline. There are two ways to get them and the product depends on
 * BOTH working:
 *
 *   A STYLIST FILLS THEM IN. Thirty seconds, free, and more accurate than any
 *   model, because they are looking at the person. This is the path that must
 *   never require a key, a network or a photograph.
 *
 *   A MODEL READS A PHOTOGRAPH. Faster for a customer doing this on their own
 *   phone, and the only version that works without a stylist in the room.
 *
 * So the AI reading is a PRE-FILL, never the authority. Every field it produces
 * can be corrected, a correction is recorded as such, and the confidence it
 * returns scales how much the recommendation leans on it. A reading nobody could
 * contradict would be a worse product than no reading at all.
 *
 * ── The photograph is the most sensitive thing this app stores ─────────────
 *
 * It is a customer's face. Consent is recorded before it is uploaded, the file is
 * tagged so the salon's public website cannot render it, and deleting the row
 * destroys the hosted file. None of that is in the specification; all of it is
 * the difference between a feature and a liability.
 */

const faceShapes: FaceShape[] = ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'];
const textures: HairTexture[] = ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'];
const densities: HairDensity[] = ['LOW', 'MEDIUM', 'HIGH'];
const lengths: HairLength[] = ['VERY_SHORT', 'SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'];
const hairlines: HairlineShape[] = ['STRAIGHT', 'ROUNDED', 'WIDOWS_PEAK', 'RECEDING', 'UNEVEN'];

/**
 * WHAT THE MODEL IS ASKED FOR, AND EVERYTHING IT IS TOLD NOT TO DO.
 *
 * The three refusals matter more than the request. A model given a photograph of
 * a face will volunteer an age, a guess at ethnicity and an opinion about
 * attractiveness unless told not to, and every one of those would then be sitting
 * in a salon's database attached to a named customer. None of them is needed to
 * recommend a haircut.
 */
const VISION_SYSTEM = `You read photographs for a hair salon and answer only with JSON.

Report ONLY these observations about hair and head shape:
  faceShape: one of OVAL, ROUND, SQUARE, OBLONG, HEART, DIAMOND
  faceShapeConfidence: a number from 0 to 1
  texture: one of STRAIGHT, WAVY, CURLY, COILY
  density: one of LOW, MEDIUM, HIGH
  length: one of VERY_SHORT, SHORT, MEDIUM, LONG, VERY_LONG
  volume: an integer from 0 to 100
  hairline: one of STRAIGHT, ROUNDED, WIDOWS_PEAK, RECEDING, UNEVEN
  notes: at most one short sentence about the hair only

Rules you must follow:
  Never report or guess age, gender, ethnicity, race, attractiveness, weight,
  health, mood or identity. Never describe clothing or the background.
  Omit any field you cannot see clearly rather than guessing it.
  If the image does not show a person's head, return {}.
  Answer with a single JSON object and nothing else.`;

/** The model's answer, trusted for nothing until it has been through this. */
const visionSchema = z
  .object({
    faceShape: z.string().optional(),
    faceShapeConfidence: z.coerce.number().min(0).max(1).optional(),
    texture: z.string().optional(),
    density: z.string().optional(),
    length: z.string().optional(),
    volume: z.coerce.number().int().min(0).max(100).optional(),
    hairline: z.string().optional(),
    notes: z.string().max(300).optional(),
  })
  .strip();

/**
 * Keep only values that are actually in the enum.
 *
 * A model will cheerfully answer "oval-ish", "2A" or "medium-long", and a
 * Prisma write with any of those fails with a type error at the database rather
 * than at the edge. Anything unrecognised becomes absent, which the recommender
 * already handles as "not part of this score".
 */
function pick<T extends string>(allowed: T[], value: unknown): T | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (allowed as string[]).includes(upper) ? (upper as T) : null;
}

export interface AnalysisInput {
  customerId?: string | null;
  branchId?: string | null;
  /** A data URL from the browser. Optional: a stylist may fill the fields in. */
  photo?: string | null;
  /**
   * Required with a photograph. Not a checkbox on a form somewhere — the
   * service refuses to store a face without it.
   */
  consent?: boolean;
  /** Anything a person has entered or corrected. Always beats the reading. */
  faceShape?: FaceShape | null;
  texture?: HairTexture | null;
  density?: HairDensity | null;
  length?: HairLength | null;
  volume?: number | null;
  hairline?: HairlineShape | null;
  notes?: string | null;
}

export async function createAnalysis(input: AnalysisInput): Promise<HairAnalysis> {
  const tenantId = requireTenantId();

  const manual = {
    faceShape: input.faceShape ?? null,
    texture: input.texture ?? null,
    density: input.density ?? null,
    length: input.length ?? null,
    volume: input.volume ?? null,
    hairline: input.hairline ?? null,
  };
  const anyManual = Object.values(manual).some((value) => value !== null);

  if (!input.photo && !anyManual) {
    throw BadRequest('Either a photo or at least one observation is needed to make a reading.');
  }

  let imageUrl: string | null = null;
  let imagePublicId: string | null = null;
  let read: Partial<typeof manual> & { notes?: string | null; confidence?: number | null } = {};

  if (input.photo) {
    if (!input.consent) {
      /*
       * Refused outright rather than stored-and-flagged. A photograph of
       * somebody's face taken without a yes is not a data-quality problem that
       * can be tidied up afterwards — once it is in Cloudinary it has been
       * copied to a third party, and no later correction undoes that.
       */
      throw BadRequest("The customer has to agree to their photo being kept before it can be uploaded.");
    }

    // Validated and sniffed before anything is sent anywhere, by the same gate a
    // gallery upload goes through.
    const { bytes, contentType } = decodeDataUrl(input.photo);

    /*
     * THE READING HAPPENS BEFORE THE UPLOAD.
     *
     * Deliberate: if the model cannot read the picture there is no reason to
     * have stored it, and a failed analysis should not leave a customer's face
     * sitting on a third party's servers for nothing.
     */
    read = await readPhoto(input.photo);

    const tenant = await runUnscoped(() =>
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
    );

    const uploaded = await uploadBytes({
      bytes,
      contentType,
      folder: `${tenant?.slug ?? tenantId}/hair-analysis`,
      /**
       * NOT the gallery's tags, and this is the line that keeps a customer's
       * face off the salon's public website. The site renders by collection tag;
       * nothing here matches one, and `private-analysis` is not a tag any public
       * query asks for.
       */
      tags: ['private-analysis', `salon-${tenant?.slug ?? tenantId}`],
    });
    imageUrl = uploaded.secureUrl;
    imagePublicId = uploaded.publicId;
  }

  /*
   * A PERSON'S ANSWER WINS, FIELD BY FIELD.
   *
   * Not whole-record: a stylist who corrects the face shape and leaves the rest
   * alone should keep the model's reading of the texture. Merging per field is
   * what makes the AI a pre-fill rather than a thing to be overridden wholesale.
   */
  const merged = {
    faceShape: manual.faceShape ?? read.faceShape ?? null,
    texture: manual.texture ?? read.texture ?? null,
    density: manual.density ?? read.density ?? null,
    length: manual.length ?? read.length ?? null,
    volume: manual.volume ?? read.volume ?? null,
    hairline: manual.hairline ?? read.hairline ?? null,
  };

  const usedAi = Object.keys(read).length > 0;
  const source = usedAi ? (anyManual ? 'CORRECTED' : 'AI') : 'MANUAL';

  return prisma.hairAnalysis.create({
    data: {
      tenantId,
      branchId: input.branchId ?? null,
      customerId: input.customerId ?? null,
      source,
      ...merged,
      /*
       * A hand-entered face shape carries full confidence, because somebody
       * looked at the person. Only a guess from a photograph is hedged.
       */
      faceShapeConfidence: manual.faceShape ? 1 : (read.confidence ?? (read.faceShape ? 0.6 : null)),
      notes: input.notes ?? read.notes ?? null,
      imageUrl,
      imagePublicId,
      consentAt: input.photo ? new Date() : null,
      createdById: currentUserId(),
    },
  });
}

/** The model's reading, cleaned down to values the database will accept. */
async function readPhoto(dataUrl: string) {
  const raw = await visionJson<unknown>(
    VISION_SYSTEM,
    'Read this photograph and report only the hair and head-shape observations listed.',
    { dataUrl },
  );
  if (!raw) return {};

  const parsed = visionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('hair analysis: the reading did not match the expected shape; falling back to manual entry');
    return {};
  }

  const data = parsed.data;
  const result = {
    faceShape: pick(faceShapes, data.faceShape),
    texture: pick(textures, data.texture),
    density: pick(densities, data.density),
    length: pick(lengths, data.length),
    hairline: pick(hairlines, data.hairline),
    volume: data.volume ?? null,
    notes: data.notes ?? null,
    confidence: data.faceShapeConfidence ?? null,
  };

  // An empty object means "nothing usable came back", which the caller reads as
  // MANUAL. Without this an unreadable photo would be recorded as an AI reading
  // of nothing at all.
  return Object.values(result).some((value) => value !== null) ? result : {};
}

export async function latestAnalysis(customerId: string): Promise<HairAnalysis | null> {
  const tenantId = requireTenantId();
  return prisma.hairAnalysis.findFirst({
    where: { tenantId, customerId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAnalysis(id: string): Promise<HairAnalysis> {
  const tenantId = requireTenantId();
  const analysis = await prisma.hairAnalysis.findFirst({ where: { id, tenantId } });
  if (!analysis) throw NotFound('Reading not found');
  return analysis;
}

/**
 * Forget a customer's photograph, properly.
 *
 * The hosted file goes first and the row second. The other order leaves a face
 * on a third party's servers with nothing in the database pointing at it, which
 * is unrecoverable rather than merely untidy: there is then no record of what to
 * delete. If Cloudinary refuses, the row stays and the caller is told, so the
 * deletion can be retried rather than silently believed.
 */
export async function deleteAnalysis(id: string): Promise<{ photos: number }> {
  const analysis = await getAnalysis(id);

  /**
   * THE PICTURES MADE FROM THE PHOTOGRAPH ARE ALSO THE PHOTOGRAPH.
   *
   * This is the part that is easy to miss and impossible to undo. A customer
   * preview is that customer's own face with different hair on it — deleting the
   * original and keeping those would mean "delete my photo" left a dozen pictures
   * of her in a salon's storage. The database rows cascade; Cloudinary does not,
   * so the files have to be destroyed by hand, here, before the cascade removes
   * the only record of which files they were.
   */
  const derived = await prisma.hairGeneration.findMany({
    where: { analysisId: analysis.id, imagePublicId: { not: null } },
    select: { imagePublicId: true },
  });

  const files = [analysis.imagePublicId, ...derived.map((row) => row.imagePublicId)].filter(
    (value): value is string => !!value,
  );

  for (const publicId of files) {
    const gone = await destroyImage(publicId);
    if (!gone) {
      /*
       * Stops at the first refusal and keeps the row. The alternative is a
       * half-finished deletion with no record of what is left, which is worse
       * than a deletion the salon can retry.
       */
      throw BadRequest('A photograph could not be deleted from storage, so nothing was removed. Try again.');
    }
  }

  // The generations cascade with it, by the relation on HairGeneration.analysisId.
  await prisma.hairAnalysis.delete({ where: { id: analysis.id } });
  return { photos: files.length };
}

// ------------------------------------------------------- recommendations ----

export interface RecommendInput {
  /** Use a stored reading. Everything below it overrides what it says. */
  analysisId?: string | null;
  customerId?: string | null;
  faceShape?: FaceShape | null;
  texture?: HairTexture | null;
  density?: HairDensity | null;
  length?: HairLength | null;
  gender?: Gender | null;
  preferences?: HairPreferences;
  limit?: number;
}

/**
 * The salon's own menu, ranked for this person.
 *
 * ── Why it reads the catalogue rather than the generator registry ──────────
 *
 * Because the salon is going to have to cut it. Recommending a wolf cut to
 * somebody whose salon does not offer one wastes the only moment in the
 * consultation when the customer was excited, and sends them somewhere else to
 * get it. Only active catalogue rows are scored, which also means a salon narrows
 * its own advice simply by maintaining its menu.
 */
export async function recommendFor(input: RecommendInput) {
  const tenantId = requireTenantId();

  const analysis = input.analysisId
    ? await getAnalysis(input.analysisId)
    : input.customerId
      ? await latestAnalysis(input.customerId)
      : null;

  const customer = input.customerId
    ? await prisma.customer.findFirst({
        where: { id: input.customerId, tenantId },
        select: { gender: true },
      })
    : null;

  const profile: HairProfile = {
    faceShape: input.faceShape ?? analysis?.faceShape ?? null,
    faceShapeConfidence: input.faceShape ? 1 : (analysis?.faceShapeConfidence ?? null),
    texture: input.texture ?? analysis?.texture ?? null,
    density: input.density ?? analysis?.density ?? null,
    length: input.length ?? analysis?.length ?? null,
    gender: input.gender ?? customer?.gender ?? null,
  };

  /**
   * WHAT THEY HAVE ASKED FOR BEFORE COUNTS AS A PREFERENCE.
   *
   * A customer's own saved designs are the most reliable preference signal in the
   * system — better than anything they would tick on a form, because they already
   * sat in a chair and chose it. Read when nothing explicit was passed.
   */
  let preferences = input.preferences ?? {};
  if (!preferences.likedKinds?.length && input.customerId) {
    const past = await prisma.hairDesign.findMany({
      where: { tenantId, customerId: input.customerId },
      select: { hairstyleKey: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const likedKinds = [...new Set(past.map((row) => row.hairstyleKey))];
    if (likedKinds.length) preferences = { ...preferences, likedKinds };
  }

  const rows = await prisma.hairstyleCatalog.findMany({
    where: { tenantId, isActive: true },
    include: { service: { select: { id: true, name: true, price: true, durationMin: true } } },
  });

  const candidates: Candidate[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    gender: row.gender,
    category: row.category,
    maintenance: row.maintenance,
    supportedTextures: row.supportedTextures,
    supportedLengths: row.supportedLengths,
    supportedDensities: row.supportedDensities,
    recommendedFaceShapes: row.recommendedFaceShapes,
    supportsBangs: row.supportsBangs,
    supportsFade: row.supportsFade,
    serviceId: row.serviceId,
  }));

  const ranked = recommend(candidates, profile, preferences, { limit: input.limit ?? 5 });
  const byId = new Map(rows.map((row) => [row.id, row]));

  return {
    /**
     * WHAT THE SCORE WAS BASED ON, RETURNED ALONGSIDE IT.
     *
     * A 94% match computed from one known fact and a 94% computed from six are
     * very different claims, and only one of them should be read out to a
     * customer. The screen can say "based on your photo" or "add a photo for a
     * sharper match" because this says which it was.
     */
    basis: {
      source: analysis?.source ?? null,
      analysisId: analysis?.id ?? null,
      known: (Object.keys(profile) as (keyof HairProfile)[]).filter(
        (key) => key !== 'faceShapeConfidence' && profile[key] != null,
      ),
      catalogueSize: rows.length,
    },
    results: ranked.map((item) => {
      const row = byId.get(item.catalogId);
      return {
        ...item,
        category: row?.category ?? null,
        maintenance: row?.maintenance ?? null,
        previewUrl: row?.previewUrl ?? null,
        service: row?.service ?? null,
      };
    }),
  };
}
