import crypto from 'node:crypto';
import { env, cloudinaryReady } from '../../config/env';
import { BadRequest } from '../../core/errors';
import { logger } from '../../core/logger';

/**
 * CLOUDINARY, SIGNED SERVER-SIDE.
 *
 * ── Why the upload goes through us at all ────────────────────────────────
 *
 * Cloudinary offers unsigned uploads, where the browser posts straight to them
 * with a preset name and no secret. It is tempting and it is wrong here: an
 * unsigned preset is a public write endpoint. Anybody who reads the page's
 * JavaScript can upload anything to the salon's account — any size, any
 * content, under any tag, including the tag the salon's gallery renders. The
 * salon finds out when a customer tells them what is on their website.
 *
 * So the browser sends the image to this API, which checks who is asking, what
 * the file actually is and how big, and then signs one upload of its own. The
 * secret never leaves the server.
 *
 * ── Why no SDK ───────────────────────────────────────────────────────────
 *
 * The upload API is one multipart POST and the signature is a SHA-1 of sorted
 * parameters. The `cloudinary` package brings a dependency tree and a
 * configuration singleton to save writing forty lines, and it is one more thing
 * to keep current in an app that already pins its own HTTP behaviour.
 */

const UPLOAD_URL = () => `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`;
const DESTROY_URL = () => `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`;

/**
 * What may be uploaded as a photograph.
 *
 * SVG is absent for the same reason it is absent from the logo uploader: an SVG
 * is a document that can carry a script, and it would be served back under a
 * content type that runs it. A gallery has no use for vector anyway.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * 10MB after decoding. Generous, because these are photographs off a phone
 * rather than logos and Cloudinary does the resizing — but bounded, so a video
 * picked by mistake fails immediately with a sentence rather than after two
 * minutes of a salon's upload bandwidth.
 */
const MAX_BYTES = 10 * 1024 * 1024;

/** The magic numbers. A declared content type is a claim, not evidence. */
function sniff(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Cloudinary's signature: every parameter except file, api_key and
 * resource_type, sorted by name, joined as a query string, with the secret
 * appended, SHA-1'd.
 *
 * Exported and pure so it can be tested against Cloudinary's own published
 * example. A signature that is subtly wrong comes back as "Invalid Signature"
 * with nothing to say which parameter did it, so this is the one part of the
 * integration worth pinning to a known-good answer.
 */
export function signParams(params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'file' && key !== 'api_key' && key !== 'resource_type' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return crypto.createHash('sha1').update(canonical + secret).digest('hex');
}

/**
 * Cloudinary's context is a pipe-delimited key=value list, so a value holding a
 * pipe or an equals sign would break the next field open — an alt text reading
 * "before=after" would silently create a field called "after".
 *
 * Stripped rather than escaped: Cloudinary's escaping rules here are not worth
 * relying on, and no sentence describing a haircut needs either character.
 */
export function buildContext(input: { alt?: string; caption?: string }): string {
  const clean = (value: string) => value.replace(/[|=]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return [
    input.alt?.trim() ? `alt=${clean(input.alt)}` : '',
    input.caption?.trim() ? `caption=${clean(input.caption)}` : '',
  ]
    .filter(Boolean)
    .join('|');
}

/**
 * Take a data URL from the browser and read out the bytes.
 *
 * A data URL rather than multipart, matching how the logo uploader already
 * works: no new middleware and no new dependency for one file at a time.
 */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; contentType: string } {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw BadRequest('That does not look like an image file');

  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length === 0) throw BadRequest('That file was empty');
  if (bytes.length > MAX_BYTES) {
    throw BadRequest(`That photograph is about ${Math.round(bytes.length / 1024 / 1024)}MB. The limit is 10MB.`);
  }

  /**
   * The sniffed type wins over the declared one.
   *
   * A browser will label a PDF image/jpeg if asked to, and what gets served
   * back is decided by the contents. Refusing on the bytes is the only check
   * that means anything.
   */
  const actual = sniff(bytes);
  if (!actual || !ALLOWED.has(actual)) {
    throw BadRequest('Only JPEG, PNG and WebP photographs can be uploaded');
  }

  return { bytes, contentType: actual };
}

export interface UploadResult {
  publicId: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  secureUrl: string;
}

export interface UploadOptions {
  dataUrl: string;
  /** Subfolder under CLOUDINARY_FOLDER. One per salon. */
  folder: string;
  /** The tags the website reads by. */
  tags: string[];
  /** Stored on the image, so the website can read the alt text back out. */
  context?: { alt?: string; caption?: string };
}

export async function uploadImage(options: UploadOptions): Promise<UploadResult> {
  if (!cloudinaryReady) {
    throw BadRequest('Photograph hosting is not set up on this server yet.');
  }

  const { bytes, contentType } = decodeDataUrl(options.dataUrl);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const context = buildContext(options.context ?? {});

  const params: Record<string, string> = {
    timestamp,
    folder: `${env.CLOUDINARY_FOLDER}/${options.folder}`,
    tags: options.tags.join(','),
    ...(context ? { context } : {}),
  };

  const form = new FormData();
  for (const [key, value] of Object.entries(params)) form.append(key, value);
  form.append('api_key', env.CLOUDINARY_API_KEY);
  form.append('signature', signParams(params, env.CLOUDINARY_API_SECRET));
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), 'upload');

  const response = await fetch(UPLOAD_URL(), { method: 'POST', body: form });
  const payload = (await response.json().catch(() => null)) as
    | {
        public_id?: string;
        format?: string;
        width?: number;
        height?: number;
        bytes?: number;
        secure_url?: string;
        error?: { message?: string };
      }
    | null;

  if (!response.ok || !payload?.public_id) {
    /**
     * Cloudinary's own message, passed through rather than swallowed.
     *
     * "Invalid Signature", "account over quota" and "Resource list is
     * restricted" each need a different action from whoever set this up, and a
     * generic "upload failed" gives them none of it. The person reading this is
     * the owner who typed the keys in.
     */
    logger.warn({ status: response.status, cloudinary: payload?.error?.message }, 'cloudinary upload refused');
    throw BadRequest(payload?.error?.message ?? 'Cloudinary refused the upload.');
  }

  return {
    publicId: payload.public_id,
    format: payload.format ?? 'jpg',
    width: payload.width ?? 0,
    height: payload.height ?? 0,
    bytes: payload.bytes ?? bytes.length,
    secureUrl: payload.secure_url ?? '',
  };
}

/**
 * Remove an image from Cloudinary.
 *
 * Returns whether it is gone rather than throwing, and the caller removes its
 * own row either way: a photograph the salon deleted must disappear from their
 * website even if Cloudinary is having a bad minute. An orphaned file costs a
 * fraction of a paisa; a picture the owner believes they removed and which is
 * still public is what ends up in a complaint.
 */
export async function destroyImage(publicId: string): Promise<boolean> {
  if (!cloudinaryReady) return false;

  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { public_id: publicId, timestamp };

  const form = new FormData();
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', env.CLOUDINARY_API_KEY);
  form.append('signature', signParams(params, env.CLOUDINARY_API_SECRET));

  try {
    const response = await fetch(DESTROY_URL(), { method: 'POST', body: form });
    const payload = (await response.json().catch(() => null)) as { result?: string } | null;
    // "not found" counts as done: whatever the salon wanted gone is gone.
    return payload?.result === 'ok' || payload?.result === 'not found';
  } catch (err) {
    logger.warn({ err, publicId }, 'cloudinary delete failed; the row is removed anyway');
    return false;
  }
}
