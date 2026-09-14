import { resolveProvider } from './providers';
import { logger } from '../core/logger';

/**
 * MESSAGES FROM THE PLATFORM TO A SALON — not from a salon to its customers.
 *
 * A renewal reminder is our letter to the salon owner. It is deliberately kept
 * off the tenant messaging path, for two reasons that both matter:
 *
 *   1. It must not be metered. Telling a salon its plan is ending should never
 *      consume the allowance it is paying for, and must still go out when that
 *      allowance is exhausted — which is precisely when a salon is most likely
 *      to be behind on payment.
 *
 *   2. It must not be consent-gated. A billing notice is not marketing; a
 *      salon that opted out of our product emails is still owed the message
 *      saying its account is about to lapse.
 *
 * It uses the platform's own email account (the env-level provider), never the
 * salon's — this is us writing to them, and it should look like it.
 */
export interface PlatformNotice {
  to: string;
  subject: string;
  body: string;
  /** For the log line only; nothing about the send is tenant-scoped. */
  tenantId?: string;
}

export async function notifyPlatform(notice: PlatformNotice): Promise<boolean> {
  if (!notice.to) {
    logger.warn({ tenantId: notice.tenantId }, 'platform notice skipped: no address on the salon');
    return false;
  }

  // `null` tenant means "resolve from the environment", i.e. our own account.
  const { provider, live } = await resolveProvider('EMAIL', null);

  const result = await provider.send({
    to: notice.to,
    channel: 'EMAIL',
    subject: notice.subject,
    body: notice.body,
  });

  if (!result.ok) {
    logger.error(
      { tenantId: notice.tenantId, to: notice.to, error: result.errorMessage, live },
      'platform notice failed',
    );
    return false;
  }

  logger.info({ tenantId: notice.tenantId, subject: notice.subject, live }, 'platform notice sent');
  return true;
}
