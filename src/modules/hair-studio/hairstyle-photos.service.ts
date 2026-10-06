import type { HairPose, HairstylePhoto } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, currentUserId, runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { logger } from '../../core/logger';
import { decodeDataUrl, destroyImage, readImageBytes, uploadBytes } from '../gallery/cloudinary';
import { PRIMARY_POSE, posesWorthShooting, type CutFamily } from './look-dimensions';

/**
 * A STYLE'S PHOTOGRAPHS, ONE PER ANGLE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY MORE THAN ONE ANGLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Because the back of the head is where most of the work is, and the front is
 * all anybody photographs. A butterfly cut, a U-cut, a V-cut, layers, a fade —
 * the whole point of each is a shape the customer cannot see on herself. She
 * approves a front view, sits down, and meets the back of her head in a mirror
 * afterwards. That is the commonest route from a technically correct haircut to a
 * complaint, and it is a photography problem rather than a cutting one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MIRRORING RULE, WHICH IS THE ONE THING TO GET RIGHT HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `hairstyle_catalog.previewUrl` and `.maskUrl` still exist and still mean THE
 * FRONT VIEW. Every existing reader — the look-book thumbnail, the studio's
 * canvas, the advisor, the recommendation screen — already means that by "the
 * picture", and rewriting all of them to join a table would be a large change
 * whose only benefit is tidiness.
 *
 * So the front pose is mirrored onto the catalogue row, and the rule has a
 * direction: PHOTOS ARE THE TRUTH, THE CATALOGUE COLUMNS ARE A CACHE OF ONE OF
 * THEM. Writes go through here and the mirror follows. Nothing writes the mirror
 * directly and expects this table to notice, because it will not.
 *
 * That direction is why `setPhoto` is the only way in, and why it is the function
 * that owns deleting the Cloudinary asset too: a photograph of a real customer
 * that outlives the row pointing at it is exactly the file that survives a
 * deletion request.
 */

/** Where these live in Cloudinary. Its own folder, away from the gallery. */
const FOLDER = 'hair-styles';

export async function listPhotos(catalogId: string): Promise<HairstylePhoto[]> {
  const tenantId = requireTenantId();
  const entry = await prisma.hairstyleCatalog.findFirst({
    where: { id: catalogId, tenantId },
    select: { id: true },
  });
  if (!entry) throw NotFound('Hairstyle not found');

  return prisma.hairstylePhoto.findMany({
    where: { catalogId, tenantId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * WHICH ANGLES THIS STYLE STILL OWES, AND WHICH IT HAS.
 *
 * The checklist the asset studio draws. Derived from the cut rather than fixed at
 * five, because a checklist nobody can finish is a feature nobody starts: a
 * one-length cut does not need four views of the same curtain of hair, and asking
 * for them is how a salon decides the whole thing is too much work.
 */
export async function photoChecklist(catalogId: string) {
  const photos = await listPhotos(catalogId);
  const entry = await prisma.hairstyleCatalog.findFirst({
    where: { id: catalogId, tenantId: requireTenantId() },
    select: { cutFamily: true },
  });

  const wanted = posesWorthShooting((entry?.cutFamily ?? '') as CutFamily);
  const have = new Set(photos.map((photo) => photo.pose));

  return {
    wanted,
    /*
     * Reported separately from `wanted` rather than filtered out of it, because a
     * salon that has photographed an angle nobody asked for has not made a
     * mistake — and a screen that hides it would look like it had lost the file.
     */
    extra: photos.filter((photo) => !wanted.includes(photo.pose)).map((photo) => photo.pose),
    missing: wanted.filter((pose) => !have.has(pose)),
    photos,
  };
}

/**
 * ADD, REPLACE OR REMOVE ONE ANGLE.
 *
 * `photo: null` removes that angle. There is one picture per angle and it is
 * replaced rather than accumulated — the unique key on (catalogId, pose) enforces
 * it — because the failure worth preventing is a style with eleven front views
 * and no back view. This is a checklist of angles, not a gallery.
 */
export async function setPhoto(
  catalogId: string,
  input: { pose: HairPose; photo: string | null; consent?: boolean },
): Promise<HairstylePhoto | null> {
  const tenantId = requireTenantId();

  const entry = await prisma.hairstyleCatalog.findFirst({ where: { id: catalogId, tenantId } });
  if (!entry) throw NotFound('Hairstyle not found');

  const existing = await prisma.hairstylePhoto.findUnique({
    where: { catalogId_pose: { catalogId, pose: input.pose } },
  });

  if (input.photo === null) {
    if (!existing) return null;
    await prisma.hairstylePhoto.delete({ where: { id: existing.id } });
    await forget(existing.imagePublicId);
    await mirrorFront(catalogId, input.pose);
    return null;
  }

  /*
   * Consent per ANGLE, not per style.
   *
   * Each angle is a separate photograph and may be of a different person on a
   * different day, and consent to appear in a look-book is given for a picture
   * rather than for a catalogue entry. Asking once per style would be recording
   * an agreement somebody never made about a photograph that did not exist yet.
   */
  if (!input.consent) {
    throw BadRequest(
      'Confirm that whoever is in this photograph is happy for the salon to show it before uploading it.',
    );
  }

  const { bytes, contentType } = readImageBytes(decodeDataUrl(input.photo).bytes);
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );
  const slug = tenant?.slug ?? tenantId;

  const uploaded = await uploadBytes({
    bytes,
    contentType,
    folder: `${slug}/${FOLDER}`,
    tags: ['hair-style-photo', `pose-${input.pose.toLowerCase()}`, `salon-${slug}`],
  });

  const saved = await prisma.hairstylePhoto.upsert({
    where: { catalogId_pose: { catalogId, pose: input.pose } },
    create: {
      tenantId,
      catalogId,
      pose: input.pose,
      imageUrl: uploaded.secureUrl,
      imagePublicId: uploaded.publicId,
      isUploaded: true,
      consentAt: new Date(),
      createdById: currentUserId(),
    },
    update: {
      imageUrl: uploaded.secureUrl,
      imagePublicId: uploaded.publicId,
      /*
       * THE MASK GOES. It was a silhouette of the picture being replaced, and
       * keeping it would paint colour wherever the OLD hair happened to be —
       * which looks like a bug in the renderer rather than a stale file.
       */
      maskUrl: null,
      isUploaded: true,
      consentAt: new Date(),
    },
  });

  // Replacing a picture orphans the old asset unless somebody deletes it.
  if (existing?.imagePublicId && existing.imagePublicId !== uploaded.publicId) {
    await forget(existing.imagePublicId);
  }

  await mirrorFront(catalogId, input.pose);
  return saved;
}

/**
 * CUT THE HAIR OUT OF ONE ANGLE.
 *
 * Per pose and never shared. Hair occupies completely different pixels from the
 * side than from the front, so one mask reused across angles would recolour a
 * cheek — and it would do it convincingly enough to ship.
 */
export async function setPhotoMask(
  catalogId: string,
  input: { pose: HairPose; mask: string | null },
): Promise<HairstylePhoto> {
  const tenantId = requireTenantId();

  const photo = await prisma.hairstylePhoto.findFirst({
    where: { catalogId, pose: input.pose, tenantId },
  });
  if (!photo) throw NotFound('There is no photograph at that angle to cut the hair out of');

  if (input.mask === null) {
    const cleared = await prisma.hairstylePhoto.update({ where: { id: photo.id }, data: { maskUrl: null } });
    await mirrorFront(catalogId, input.pose);
    return cleared;
  }

  const { bytes, contentType } = readImageBytes(decodeDataUrl(input.mask).bytes);
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );
  const slug = tenant?.slug ?? tenantId;

  const uploaded = await uploadBytes({
    bytes,
    contentType,
    folder: `${slug}/hair-masks`,
    /*
     * Its own tag, well away from the gallery's. A mask is a black-and-white
     * silhouette of somebody's hair; it is of no interest to anyone but the
     * renderer, and it must never appear on the salon's public page because it
     * happened to share a tag with the photographs.
     */
    tags: ['hair-mask', `pose-${input.pose.toLowerCase()}`, `salon-${slug}`],
  });

  const saved = await prisma.hairstylePhoto.update({
    where: { id: photo.id },
    data: { maskUrl: uploaded.secureUrl },
  });

  await mirrorFront(catalogId, input.pose);
  return saved;
}

/**
 * KEEP THE CATALOGUE'S OWN COLUMNS SHOWING THE FRONT VIEW.
 *
 * One direction only, and only for the front pose. Called after every write so
 * that the dozen readers of `previewUrl` keep working unchanged — see the header.
 *
 * A no-op for every other angle, deliberately: a salon that uploads a back view
 * first has not thereby chosen a look-book thumbnail of the back of somebody's
 * head.
 */
async function mirrorFront(catalogId: string, pose: HairPose): Promise<void> {
  if (pose !== PRIMARY_POSE) return;

  const front = await prisma.hairstylePhoto.findUnique({
    where: { catalogId_pose: { catalogId, pose: PRIMARY_POSE } },
  });

  await prisma.hairstyleCatalog.update({
    where: { id: catalogId },
    data: {
      previewUrl: front?.imageUrl ?? null,
      maskUrl: front?.maskUrl ?? null,
      photoIsUploaded: front?.isUploaded ?? false,
    },
  });
}

/**
 * Delete the hosted file, and do not fail the request if that fails.
 *
 * The row is already gone or already pointing elsewhere; a Cloudinary outage must
 * not leave the database disagreeing with what the salon just did on screen. It
 * is logged at warn because an asset nobody deleted is a real thing to clean up
 * later — these are sometimes real customers' photographs.
 */
async function forget(publicId: string | null): Promise<void> {
  if (!publicId) return;
  try {
    await destroyImage(publicId);
  } catch (error) {
    logger.warn({ err: error, publicId }, 'hair style photo left behind in cloudinary');
  }
}
