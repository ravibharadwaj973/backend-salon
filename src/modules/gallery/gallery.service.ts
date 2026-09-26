import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { NotFound } from '../../core/errors';
import { logger } from '../../core/logger';
import { env, cloudinaryReady } from '../../config/env';
import { destroyImage, uploadImage } from './cloudinary';

/**
 * THE SALON'S GALLERY.
 *
 * ── The collections, and why they are a fixed list ───────────────────────
 *
 * A gallery groups by the KIND of work, not by the price list. A salon's
 * services are finer than a customer's question: the menu has "Root touch-up",
 * "Global colour" and "Balayage" at three prices, and the customer wants to see
 * colour. Free-text categories would drift the moment two people typed
 * "Bridal" and "bridal & occasion", and the website's tags would drift with
 * them.
 *
 * So the list is fixed and shared: these keys ARE the website's tags, which is
 * what lets a photograph uploaded here appear there with nothing in between.
 */
export const COLLECTIONS = [
  { key: 'colour', label: 'Colour' },
  { key: 'cuts', label: 'Cuts' },
  { key: 'treatments', label: 'Treatments' },
  { key: 'skin', label: 'Skin' },
  { key: 'bridal', label: 'Bridal & occasion' },
  { key: 'studio', label: 'The studio' },
] as const;

export type CollectionKey = (typeof COLLECTIONS)[number]['key'];

export const COLLECTION_KEYS = COLLECTIONS.map((c) => c.key) as unknown as [CollectionKey, ...CollectionKey[]];

/**
 * The Cloudinary tag for a collection, and the SECOND tag every photograph
 * carries.
 *
 * The per-salon tag matters on a shared Cloudinary account: without it, two
 * salons both using `gallery-colour` would each render the other's work. The
 * website reads the collection tag because it already knows whose site it is;
 * the salon tag is what makes the account safe to share.
 */
export function tagsFor(tenantSlug: string, collection: string): string[] {
  return [`gallery-${collection}`, `salon-${tenantSlug}`];
}

export async function listPhotos(input: { collection?: string; includeHidden?: boolean } = {}) {
  const tenantId = requireTenantId();

  const photos = await prisma.galleryPhoto.findMany({
    where: {
      tenantId,
      ...(input.collection ? { collection: input.collection } : {}),
      ...(input.includeHidden ? {} : { isVisible: true }),
    },
    orderBy: [{ collection: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

  return {
    /**
     * Said on every response rather than discovered on the first failed upload.
     * A salon looking at an empty gallery needs to know whether they have no
     * photographs or no image host.
     */
    ready: cloudinaryReady,
    cloudName: env.CLOUDINARY_CLOUD_NAME || null,
    collections: COLLECTIONS,
    photos,
  };
}

export interface AddPhotoInput {
  collection: CollectionKey;
  dataUrl: string;
  alt: string;
  caption?: string;
}

export async function addPhoto(input: AddPhotoInput, userId: string | null) {
  const tenantId = requireTenantId();

  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );
  if (!tenant) throw NotFound('Salon');

  /**
   * Cloudinary first, the row second.
   *
   * The other order leaves a row pointing at a publicId that does not exist,
   * which the website renders as a broken image — and a broken image on a
   * salon's gallery is worse than a missing one, because it looks like the
   * salon's fault to every customer who sees it. A failed upload throws before
   * anything is written.
   */
  const uploaded = await uploadImage({
    dataUrl: input.dataUrl,
    folder: tenant.slug,
    tags: tagsFor(tenant.slug, input.collection),
    context: { alt: input.alt, caption: input.caption },
  });

  /**
   * New photographs go to the FRONT of their collection.
   *
   * A salon uploading this week's work wants it seen first, and the alternative
   * — appending — means every new picture lands at the bottom of a page nobody
   * scrolls to. Negative sortOrder rather than renumbering the rest, which
   * would be an UPDATE over the whole collection on every upload.
   */
  const lowest = await prisma.galleryPhoto.aggregate({
    where: { tenantId, collection: input.collection },
    _min: { sortOrder: true },
  });

  return prisma.galleryPhoto.create({
    data: {
      tenantId,
      collection: input.collection,
      publicId: uploaded.publicId,
      format: uploaded.format,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      alt: input.alt.trim().slice(0, 300),
      caption: input.caption?.trim().slice(0, 300) || null,
      sortOrder: (lowest._min.sortOrder ?? 0) - 1,
      uploadedById: userId,
    },
  });
}

export async function updatePhoto(
  id: string,
  data: { alt?: string; caption?: string | null; isVisible?: boolean; collection?: CollectionKey; sortOrder?: number },
) {
  const tenantId = requireTenantId();
  const photo = await prisma.galleryPhoto.findFirst({ where: { id, tenantId } });
  if (!photo) throw NotFound('Photograph');

  return prisma.galleryPhoto.update({
    where: { id },
    data: {
      ...(data.alt !== undefined ? { alt: data.alt.trim().slice(0, 300) } : {}),
      ...(data.caption !== undefined ? { caption: data.caption?.trim().slice(0, 300) || null } : {}),
      ...(data.isVisible !== undefined ? { isVisible: data.isVisible } : {}),
      ...(data.collection !== undefined ? { collection: data.collection } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
    },
  });
}

/**
 * Remove a photograph from the gallery and from Cloudinary.
 *
 * The row goes whether or not Cloudinary answers. A salon that pressed delete —
 * very often because the customer in the picture asked them to — must see it
 * gone from their website, and a failed API call must not leave it up. The
 * orphaned file is logged and costs a fraction of a paisa; the alternative is a
 * photograph the owner believes they took down and which is still public.
 */
export async function deletePhoto(id: string) {
  const tenantId = requireTenantId();
  const photo = await prisma.galleryPhoto.findFirst({ where: { id, tenantId } });
  if (!photo) throw NotFound('Photograph');

  const removed = await destroyImage(photo.publicId);
  if (!removed) {
    logger.warn(
      { publicId: photo.publicId, tenantId },
      'gallery photo row deleted but the file is still in Cloudinary — remove it there',
    );
  }

  await prisma.galleryPhoto.delete({ where: { id } });
  return { deleted: true, fileRemoved: removed };
}

/**
 * The gallery as the salon's own website reads it.
 *
 * Grouped, visible only, in the salon's order. Deliberately served from here
 * rather than left to the website's Cloudinary tag lookup: the tag list has no
 * idea about order, about hidden photographs, or about a caption the salon
 * edited after uploading. The tag route still works and is the fallback when
 * this API is unreachable — see the website's lib/gallery.ts.
 */
export async function publicGallery(tenantId: string) {
  const photos = await runUnscoped(() =>
    prisma.galleryPhoto.findMany({
      where: { tenantId, isVisible: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: {
        publicId: true,
        collection: true,
        alt: true,
        caption: true,
        width: true,
        height: true,
      },
    }),
  );

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME || null,
    collections: COLLECTIONS,
    photos,
  };
}
