import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { PUBLIC_API_BASE, env } from '../../config/env';

const PUBLIC_API_URL_SET = Boolean(env.PUBLIC_API_URL);

/**
 * WHAT A SALON MAY UPLOAD AS ITS LOGO.
 *
 * SVG is deliberately absent. An SVG is a document, not a picture: it can
 * carry <script>, and served from our own origin that script runs with our
 * cookies. Every salon on the platform could then be attacked by any one of
 * them uploading a file. Raster formats cannot do that, and a logo has no need
 * to be vector on a phone screen or in an email — Outlook would rasterise it
 * anyway.
 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * 1MB after decoding. A logo that big is already far larger than anything that
 * will be displayed at 40 pixels high, and the limit exists mostly so a
 * mis-selected photograph fails immediately with a sentence rather than
 * slowly, somewhere else.
 */
const MAX_BYTES = 1024 * 1024;

/** The magic numbers, checked because a Content-Type is only a claim. */
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
 * Take a data URL from the browser and keep the bytes.
 *
 * A data URL rather than multipart because it needs no new dependency and no
 * new middleware for one small file, and the JSON body limit is already 5MB —
 * comfortably above a 1MB image plus base64's third.
 */
export async function saveTenantLogo(dataUrl: string) {
  const tenantId = requireTenantId();

  /**
   * Refused here rather than at boot.
   *
   * The address is STORED when the logo is uploaded, so a relative one would
   * sit in every email already sent and resolve against the customer's mail
   * client — a broken image nobody can repair afterwards, because a sent
   * message is never re-rendered. Better to refuse the upload with a sentence
   * somebody can act on than to write a URL that can never be right.
   */
  if (!PUBLIC_API_URL_SET) {
    throw BadRequest(
      'This server does not know its own public address yet, so the logo would be saved with a link that cannot be ' +
        'opened from an email. Set PUBLIC_API_URL on the server and try again.',
    );
  }

  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw BadRequest('That file could not be read. Choose a PNG, JPEG or WebP image.');
  }

  const declared = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!, 'base64');

  if (bytes.length === 0) throw BadRequest('That file is empty.');
  if (bytes.length > MAX_BYTES) {
    throw BadRequest(
      `That image is ${Math.round(bytes.length / 1024)}KB and the limit is 1MB. A logo displays at about 40 pixels ` +
        'high, so a smaller file loses nothing.',
    );
  }

  // The browser's claim and the file's own header have to agree. A PNG renamed
  // .jpg is harmless; a file claiming to be an image and containing something
  // else is the case this rejects.
  const actual = sniff(bytes);
  if (!actual || !ALLOWED.has(actual) || !ALLOWED.has(declared)) {
    throw BadRequest('Only PNG, JPEG and WebP images can be used as a logo.');
  }

  const asset = await prisma.tenantAsset.create({
    data: { tenantId, kind: 'LOGO', mimeType: actual, sizeBytes: bytes.length, data: bytes },
  });

  const url = `${PUBLIC_API_BASE}/public/assets/${asset.id}`;
  const previous = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { logoUrl: true } });

  await prisma.tenant.update({ where: { id: tenantId }, data: { logoUrl: url } });

  /**
   * The old one goes only after the new one is pointed at.
   *
   * The other order leaves a window where logoUrl names a row that is gone,
   * and the emails sent in that window carry a 404 for ever — a message is not
   * re-rendered when somebody changes a logo. Cleaning up afterwards can fail
   * harmlessly; cleaning up first cannot.
   */
  const previousId = previous?.logoUrl?.split('/').pop();
  if (previousId && previousId !== asset.id) {
    await prisma.tenantAsset.deleteMany({ where: { id: previousId, tenantId } }).catch(() => undefined);
  }

  return { url, sizeBytes: bytes.length, mimeType: actual };
}

export async function clearTenantLogo() {
  const tenantId = requireTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { logoUrl: true } });

  await prisma.tenant.update({ where: { id: tenantId }, data: { logoUrl: null } });

  const assetId = tenant?.logoUrl?.split('/').pop();
  if (assetId) await prisma.tenantAsset.deleteMany({ where: { id: assetId, tenantId } }).catch(() => undefined);

  return { url: null };
}

/**
 * Serve an uploaded file.
 *
 * Unscoped and unauthenticated on purpose: this URL sits in emails a customer
 * opens weeks later and on a public booking page. The id is a cuid, so it is
 * not guessable, and a logo is not a secret — it is on the salon's own
 * shopfront.
 *
 * Content-Disposition: inline with a nosniff header, so a browser renders it as
 * the type we state and never as something it decided for itself.
 */
export async function readAsset(assetId: string) {
  const asset = await runUnscoped(() => prisma.tenantAsset.findUnique({ where: { id: assetId } }));
  if (!asset) throw NotFound('File');
  return asset;
}
