import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { NotFound } from '../../core/errors';
import { logger } from '../../core/logger';
import { env, cloudinaryReady } from '../../config/env';
import { destroyImage, uploadImage } from './cloudinary';

/**
 * THE SALON'S GALLERY.
 *
 * ── The collections come from the salon, not from this file ───────────────
 *
 * They used to be a fixed list here: colour, cuts, treatments, skin, bridal,
 * studio. That was wrong in two ways at once.
 *
 * It assumed every salon is a hair-and-skin salon. A nail bar has Nails,
 * Extensions and Art; a barber has Beard and Fade; neither has "bridal". A
 * fixed list means every salon that is not the one it was written for either
 * files their work under a heading that does not fit or does not use the
 * gallery.
 *
 * And it was a SECOND list of the same thing. The salon already has service
 * categories — Hair, Skin, Nails, Spa & Massage, Makeup, Grooming — and the
 * gallery had its own parallel set that duplicated some, contradicted others
 * ("colour" and "cuts" are both Hair) and could drift from all of them. A
 * customer reading "Colour" in the gallery and "Hair" on the menu is reading
 * about two things that are the same thing.
 *
 * The earlier note here argued against grouping by SERVICE, because a service
 * list is finer than a customer's question: nobody browses by price point.
 * That was right, and categories are the level it pointed at. So the
 * collections are now the salon's own categories, plus one built-in bucket for
 * the photographs that are not work for anything.
 *
 * `collection` therefore holds either a ServiceCategory id or the literal
 * 'studio'. Ids rather than names, so renaming a category in the catalogue does
 * not orphan every photograph filed under it.
 */
import { STUDIO_KEY, collectionTag } from './collections';

export { STUDIO_KEY, collectionTag };

export interface Collection {
  /** A ServiceCategory id, or STUDIO_KEY. */
  key: string;
  label: string;
  /** The Cloudinary tag, for the website's fallback path. */
  tag: string;
}

/**
 * The collections this salon's gallery has.
 *
 * Every category, whether or not it has photographs yet — an empty one is how
 * an owner discovers where their nail pictures are supposed to go. The website
 * drops the empty ones before rendering; the app keeps them, because the app is
 * where you put things in.
 */
export async function collectionsFor(tenantId: string): Promise<Collection[]> {
  const categories = await runUnscoped(() =>
    prisma.serviceCategory.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
  );

  return [
    ...categories.map((category) => ({
      key: category.id,
      label: category.name,
      tag: collectionTag(category.name),
    })),
    /**
     * Last, and built in. The room, the tools and the shopfront are worth
     * showing and belong to no service category; putting them first would open
     * the gallery on the furniture rather than on the work.
     */
    { key: STUDIO_KEY, label: 'The studio', tag: collectionTag('studio') },
  ];
}

/**
 * Whether a salon may file a photograph under this key.
 *
 * Checked in the service rather than as a zod enum on the route, because the
 * valid values are now per-salon data and a route cannot know them.
 */
export async function assertCollection(tenantId: string, key: string): Promise<void> {
  if (key === STUDIO_KEY) return;

  const owns = await prisma.serviceCategory.count({ where: { id: key, tenantId } });
  if (!owns) throw NotFound('Collection');
}

export async function listPhotos(input: { collection?: string; includeHidden?: boolean } = {}) {
  const tenantId = requireTenantId();

  const [photos, services, collections] = await Promise.all([
    prisma.galleryPhoto.findMany({
      where: {
        tenantId,
        ...(input.collection ? { collection: input.collection } : {}),
        ...(input.includeHidden ? {} : { isVisible: true }),
      },
      orderBy: [{ collection: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    }),
    /**
     * The bookable menu, for the upload screen's service picker.
     *
     * onlineBookable only: offering to tag a photograph with a service a
     * customer cannot book online would put a "Book this" button on the website
     * that leads nowhere.
     */
    prisma.service.findMany({
      where: { tenantId, isActive: true, onlineBookable: true },
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      select: { id: true, name: true, price: true, category: { select: { id: true, name: true } } },
    }),
    collectionsFor(tenantId),
  ]);

  return {
    /**
     * Said on every response rather than discovered on the first failed upload.
     * A salon looking at an empty gallery needs to know whether they have no
     * photographs or no image host.
     */
    ready: cloudinaryReady,
    cloudName: env.CLOUDINARY_CLOUD_NAME || null,
    collections,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      price: service.price,
      categoryName: service.category?.name ?? null,
    })),
    photos,
  };
}

export interface AddPhotoInput {
  /** A ServiceCategory id, or STUDIO_KEY. */
  collection: string;
  dataUrl: string;
  alt: string;
  caption?: string;
  /** The service this is work for, when it is one. */
  serviceId?: string;
}

export async function addPhoto(input: AddPhotoInput, userId: string | null) {
  const tenantId = requireTenantId();

  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );
  if (!tenant) throw NotFound('Salon');

  /**
   * The collection has to be one of THIS salon's, checked before the upload.
   *
   * Without it a photograph could be filed under another salon's category id —
   * invisible in this salon's gallery, and the owner would have no way to find
   * out where it went.
   */
  await assertCollection(tenantId, input.collection);

  /**
   * Cloudinary first, the row second.
   *
   * The other order leaves a row pointing at a publicId that does not exist,
   * which the website renders as a broken image — and a broken image on a
   * salon's gallery is worse than a missing one, because it looks like the
   * salon's fault to every customer who sees it. A failed upload throws before
   * anything is written.
   */
  /**
   * The service is checked against THIS salon before the upload, not after.
   *
   * An id that is not theirs would otherwise put another salon's service name
   * and price under their photograph on their own website. Refusing before the
   * file goes to Cloudinary also means a rejected upload leaves nothing behind
   * to clean up.
   */
  if (input.serviceId) {
    const owns = await prisma.service.count({ where: { id: input.serviceId, tenantId } });
    if (!owns) throw NotFound('Service');
  }

  /**
   * Two tags: the collection's own, which the website reads by, and the salon's.
   *
   * The salon tag matters on a shared Cloudinary account — without it two salons
   * both with a "Hair" category would each render the other's work.
   */
  const collection = (await collectionsFor(tenantId)).find((entry) => entry.key === input.collection);

  const uploaded = await uploadImage({
    dataUrl: input.dataUrl,
    folder: tenant.slug,
    tags: [collection?.tag ?? collectionTag('other'), `salon-${tenant.slug}`],
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
      serviceId: input.serviceId ?? null,
      sortOrder: (lowest._min.sortOrder ?? 0) - 1,
      uploadedById: userId,
    },
  });
}

export async function updatePhoto(
  id: string,
  data: {
    alt?: string;
    caption?: string | null;
    isVisible?: boolean;
    collection?: string;
    sortOrder?: number;
    serviceId?: string | null;
  },
) {
  const tenantId = requireTenantId();
  const photo = await prisma.galleryPhoto.findFirst({ where: { id, tenantId } });
  if (!photo) throw NotFound('Photograph');

  // Moving a photograph between collections is the same check as filing it.
  if (data.collection !== undefined) await assertCollection(tenantId, data.collection);

  return prisma.galleryPhoto.update({
    where: { id },
    data: {
      ...(data.alt !== undefined ? { alt: data.alt.trim().slice(0, 300) } : {}),
      ...(data.caption !== undefined ? { caption: data.caption?.trim().slice(0, 300) || null } : {}),
      ...(data.isVisible !== undefined ? { isVisible: data.isVisible } : {}),
      ...(data.collection !== undefined ? { collection: data.collection } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...(data.serviceId !== undefined ? { serviceId: data.serviceId } : {}),
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
  const collections = await collectionsFor(tenantId);

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
        serviceId: true,
      },
    }),
  );

  /**
   * WHAT THE PHOTOGRAPH IS OF — THE NAME, AND DELIBERATELY NOT THE PRICE.
   *
   * The gallery names the work and offers to book it. It does not quote for it.
   *
   * A price on a photograph is a price for one service on one head, and the work
   * in the picture almost never costs what the line item says: length, condition
   * and how long it took all move it. "Balayage from ₹6,000" under a photograph
   * of six hours on very long hair sets up a conversation at the counter that
   * starts with the customer feeling misled — and a gallery's job is to make
   * somebody want to come in, not to pre-negotiate.
   *
   * So the price is not returned at all, rather than returned and left unused.
   * A field in a response that nothing renders is a field somebody renders by
   * accident later, and the booking flow asks for prices on its own where a
   * total is actually being quoted.
   *
   * One query for the services referenced, not a join per photo.
   */
  const serviceIds = [...new Set(photos.map((photo) => photo.serviceId).filter((id): id is string => Boolean(id)))];

  const services = serviceIds.length
    ? await runUnscoped(() =>
        prisma.service.findMany({
          where: { id: { in: serviceIds }, tenantId, isActive: true, onlineBookable: true },
          select: { id: true, name: true },
        }),
      )
    : [];

  const byId = new Map(services.map((service) => [service.id, service]));

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME || null,
    collections,
    photos: photos.map((photo) => {
      const service = photo.serviceId ? byId.get(photo.serviceId) : undefined;

      return {
        publicId: photo.publicId,
        collection: photo.collection,
        alt: photo.alt,
        caption: photo.caption,
        width: photo.width,
        height: photo.height,
        /**
         * Absent rather than half-filled when the service has been deleted,
         * deactivated or taken off online booking.
         *
         * The photograph stays — the work was really done, and deleting a
         * salon's portfolio because they retired a service would be absurd. But
         * a name and a price with no bookable service behind them is a "Book
         * this" button that leads nowhere, which is worse than no button.
         */
        service: service ? { id: service.id, name: service.name } : null,
      };
    }),
  };
}
