import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { logger } from '../../core/logger';

/** Anything older than this is a replay, not a retry. Svix's own tolerance. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Proves a delivery event really came from Resend.
 *
 * Resend signs with Svix, which is not the same shape as Meta's signature and
 * so needs its own check:
 *
 *   svix-id         a unique id for this delivery
 *   svix-timestamp  unix seconds
 *   svix-signature  one or more space-separated "v1,<base64>" entries
 *
 * The signed value is `${id}.${timestamp}.${rawBody}`, keyed with the bytes of
 * the secret after its `whsec_` prefix, base64-decoded. Several signatures can
 * appear at once while a secret is being rotated, and any one matching is
 * enough.
 *
 * The timestamp is checked as well as the signature. A signature stays valid
 * forever on its own, so without a time window a captured bounce event could
 * be replayed later to switch a customer's email consent off — and consent is
 * the one thing here that is hard to notice and slow to undo.
 *
 * Unconfigured is a real state in local development, so it warns loudly and
 * lets the request through rather than making the webhook impossible to test.
 */
export function verifyResendSignature(req: Request, res: Response, next: NextFunction): void {
  if (!env.RESEND_WEBHOOK_SECRET) {
    logger.warn(
      'RESEND_WEBHOOK_SECRET is not set — email webhook signatures are NOT being checked. ' +
        'Anyone who knows this URL can mark messages bounced and withdraw email consent. ' +
        'Set it before going live.',
    );
    next();
    return;
  }

  const id = req.get('svix-id');
  const timestamp = req.get('svix-timestamp');
  const header = req.get('svix-signature');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!id || !timestamp || !header || !raw) {
    logger.warn(
      { hasId: Boolean(id), hasTimestamp: Boolean(timestamp), hasSignature: Boolean(header), hasBody: Boolean(raw) },
      'email webhook rejected: not signed',
    );
    res.sendStatus(401);
    return;
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > TOLERANCE_SECONDS) {
    logger.warn({ timestamp }, 'email webhook rejected: timestamp outside the replay window');
    res.sendStatus(401);
    return;
  }

  // The secret is stored base64 after the prefix; the HMAC key is its bytes.
  const secret = Buffer.from(env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${raw.toString('utf8')}`)
    .digest('base64');

  // During a secret rotation Svix sends both signatures; one match is enough.
  const matched = header.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch, which is itself a
    // difference, so length is checked first rather than letting it throw.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!matched) {
    logger.warn('email webhook rejected: signature did not match');
    res.sendStatus(401);
    return;
  }

  next();
}
