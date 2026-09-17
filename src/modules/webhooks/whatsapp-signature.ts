import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { logger } from '../../core/logger';

/**
 * Proves a webhook really came from Meta.
 *
 * Meta signs the raw request body with the app secret and sends the result as
 * `X-Hub-Signature-256: sha256=<hex>`. Without checking it, the webhook URL is
 * an open endpoint: anyone who learns it can post delivery receipts marking
 * messages as read that were never sent, or forge an inbound "STOP" that
 * unsubscribes a salon's customers.
 *
 * Three details that matter:
 *
 *  - the signature covers the EXACT bytes Meta sent, so it is checked against
 *    the raw buffer captured in app.ts, never against a re-serialised object;
 *  - the comparison is timing-safe, because a plain `===` leaks how much of the
 *    signature was correct, one byte at a time;
 *  - a request with no signature is rejected outright rather than waved
 *    through, since that is exactly what a forged request looks like.
 */
export function verifyWhatsAppSignature(req: Request, res: Response, next: NextFunction): void {
  // Unconfigured is a real state during local development, and failing closed
  // would make the webhook impossible to test. It is loud about it instead.
  if (!env.WHATSAPP_APP_SECRET) {
    logger.warn(
      'WHATSAPP_APP_SECRET is not set — webhook signatures are NOT being checked. ' +
        'Anyone who knows this URL can post events. Set it before going live.',
    );
    next();
    return;
  }

  const header = req.get('x-hub-signature-256');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!header || !raw) {
    logger.warn({ hasHeader: Boolean(header), hasBody: Boolean(raw) }, 'webhook rejected: no signature');
    res.sendStatus(401);
    return;
  }

  const expected = `sha256=${crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which is itself a difference,
  // so the length is checked first rather than letting it throw.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn('webhook rejected: signature did not match');
    res.sendStatus(401);
    return;
  }

  next();
}
