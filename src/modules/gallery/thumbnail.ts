/**
 * A SMALL VERSION OF A PICTURE, WITHOUT STORING A SECOND PICTURE.
 *
 * Cloudinary resizes on delivery: the transformation lives in the path, so
 * `.../upload/w_400,c_fill,q_auto,f_auto/v123/parlon/bob.jpg` is the same stored
 * file served smaller. Nothing is uploaded twice and nothing has to be cleaned up
 * when a thumbnail is no longer wanted.
 *
 * ── Why this is derived rather than a column ──────────────────────────────
 *
 * A `thumbnailUrl` column would be a second copy of a fact, and the two copies
 * drift: a picture replaced without its thumbnail being updated shows last
 * month's haircut next to this month's name, and nothing errors. Derivation
 * cannot drift.
 *
 * ── Why it refuses rather than guesses ────────────────────────────────────
 *
 * `previewUrl` on a menu entry is a plain string a salon may have pasted from
 * anywhere. Rewriting a path inside a url we do not own produces a 404 at best
 * and somebody else's image at worst, so anything that is not recognisably a
 * Cloudinary delivery url comes back unchanged — a full-size picture is a
 * correct answer to "show me this smaller", and a broken one is not.
 */

/** Cloudinary delivery urls, and only those. */
const DELIVERY = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//;

export interface ThumbOptions {
  /** Pixels across. Height follows from the crop. */
  width?: number;
  /**
   * `fill` crops to a square, which is what a grid of faces wants — `fit` would
   * letterbox portraits and leave the row ragged.
   */
  crop?: 'fill' | 'fit';
}

export function thumbnail(url: string | null | undefined, options: ThumbOptions = {}): string | null {
  if (!url || !DELIVERY.test(url)) return url ?? null;

  const width = Math.max(32, Math.min(2000, options.width ?? 400));
  /*
   * q_auto and f_auto are the two that matter and cost nothing: the first picks a
   * quality that still looks right, the second serves WebP or AVIF to browsers
   * that take it. On a salon's phone connection this is the difference between a
   * look-book that loads and one nobody scrolls.
   *
   * g_face on a fill crop keeps the head in frame — a square crop of a portrait
   * taken from the centre cuts the top of the hair off, which on a page about
   * haircuts is the one part that must survive.
   */
  const transform =
    options.crop === 'fit'
      ? `w_${width},c_fit,q_auto,f_auto`
      : `w_${width},h_${width},c_fill,g_face,q_auto,f_auto`;

  return url.replace(DELIVERY, (match) => `${match}${transform}/`);
}
