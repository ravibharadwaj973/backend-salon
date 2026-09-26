import express, { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam } from '../../core/validators';
import * as service from './gallery.service';

const router = Router();
router.use(authenticate);

const collectionSchema = z.enum(service.COLLECTION_KEYS);

router.get(
  '/',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  validate({
    query: z.object({
      collection: collectionSchema.optional(),
      /** The owner's own screen shows hidden photographs; the website does not. */
      includeHidden: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { collection?: string; includeHidden?: string };
    return ok(res, await service.listPhotos({ collection: q.collection, includeHidden: q.includeHidden !== 'false' }));
  }),
);

/**
 * A photograph, as a data URL.
 *
 * The body limit is raised for this route alone. The app-wide limit is 5MB,
 * which is right for JSON and wrong for a 10MB photograph off a phone carrying
 * base64's extra third — and raising it globally would mean every endpoint in
 * the app would accept a 15MB body, which is a memory cost paid on the one
 * route that needs it and 200 that do not.
 */
router.post(
  '/',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  express.json({ limit: '15mb' }),
  validate({
    body: z.object({
      collection: collectionSchema,
      dataUrl: z.string().min(32),
      /**
       * Required, not optional.
       *
       * A gallery is the page somebody chooses a salon from, and a screen
       * reader reading "image 4" to them is not information. Asking at upload
       * is the only moment somebody knows what is in the picture — a week
       * later nobody can write it, and the field stays empty forever.
       */
      alt: z.string().trim().min(3).max(300),
      caption: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as service.AddPhotoInput;
    const photo = await service.addPhoto(body, req.ctx.userId ?? null);
    audit({ action: 'gallery.photo.added', entity: 'GalleryPhoto', entityId: photo.id });
    return created(res, photo);
  }),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      alt: z.string().trim().min(3).max(300).optional(),
      caption: z.string().trim().max(300).nullable().optional(),
      isVisible: z.boolean().optional(),
      collection: collectionSchema.optional(),
      sortOrder: z.coerce.number().int().min(-100_000).max(100_000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await service.updatePhoto(req.params.id!, req.body as never))),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const result = await service.deletePhoto(req.params.id!);
    audit({ action: 'gallery.photo.deleted', entity: 'GalleryPhoto', entityId: req.params.id! });
    /**
     * 204 even when Cloudinary did not confirm. From the salon's side the
     * photograph IS gone: it is off their website and out of their gallery. The
     * orphaned file is an operational note in the log, not something to hand
     * back as a failure to somebody who asked for a picture to come down.
     */
    return result ? noContent(res) : noContent(res);
  }),
);

export default router;
