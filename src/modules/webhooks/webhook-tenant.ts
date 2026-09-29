import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { env } from '../../config/env';

/**
 * WHOSE SALON DID THIS WEBHOOK ARRIVE FOR?
 *
 * Every salon on the platform reports to one webhook URL, and the only thing in
 * Meta's payload that identifies a salon is `phone_number_id`. So this one
 * lookup decides whether an inbound message is stored, answered and credited —
 * or dropped.
 *
 * ── The failure this exists to fix ────────────────────────────────────────
 *
 * There are two ways a deployment can hold WhatsApp credentials. A salon that
 * connects its own account through Settings gets a TenantMessagingConfig row,
 * and the row carries `waPhoneNumberId` — which is exactly what a webhook needs
 * to find it. A deployment that instead puts one number in the server
 * environment gets no row at all, because nothing ever wrote one.
 *
 * Both send perfectly well: resolveProvider falls back to the environment. The
 * asymmetry only shows on the way back in, and only for half of it —
 *
 *   · delivery receipts kept working, because a receipt carries a provider
 *     message id we stored at send time and that id already knows its tenant;
 *   · inbound messages did not, because a reply carries nothing but the
 *     customer's phone number, which is meaningless until you know whose salon
 *     they wrote to.
 *
 * So on an env-configured deployment the symptom was: messages go out, ticks
 * come back, and every reply a customer sends disappears. It was dropped one
 * line before it would have been stored, at `warn` — which is not the level
 * anybody greps when they are hunting an error, so it read as "the webhook
 * isn't firing" for days. It was firing the whole time.
 *
 * ── Why the fallback needs to be told, not guessed ────────────────────────
 *
 * The environment supplies a number. It does not say which salon owns it, and
 * on a platform with more than one salon that is not a question to answer by
 * inference: attributing an inbound message to the wrong tenant means the
 * assistant answers a stranger with another salon's prices and availability,
 * and a STOP is applied to the wrong business. Guessing is worse than dropping.
 *
 * Hence the order below: an explicit WHATSAPP_TENANT_ID, or the only salon
 * there is, or nothing — and the nothing says loudly what to set.
 */

/**
 * Memoised for the life of the process, deliberately.
 *
 * The question is "which salon owns the number in the environment", and the
 * environment cannot change without a restart. Re-deriving it would mean a
 * `count` on every delivery receipt to answer a question whose inputs are
 * fixed — and, worse, a single-salon deployment that later adds a second salon
 * would silently stop attributing its own inbound messages. The number still
 * belongs to whoever it belonged to.
 */
let cached: { tenantId: string | null } | null = null;

/** For tests, which need a fresh resolution per case. */
export function resetEnvTenantCache(): void {
  cached = null;
}

/**
 * The salon a phone number belongs to, or null if this number is nobody's.
 *
 * A number we do not recognise is not an error: Meta keeps delivering events
 * for a salon that has since disconnected, and for other numbers on the same
 * Meta app that belong to nobody here yet.
 */
export async function tenantForPhoneNumber(phoneNumberId: string | undefined): Promise<string | null> {
  if (!phoneNumberId) return null;

  // The real mapping, and the only one that scales: waPhoneNumberId is unique,
  // so this is a single indexed lookup and it is unambiguous by construction.
  const config = await runUnscoped(() =>
    prisma.tenantMessagingConfig.findUnique({
      where: { waPhoneNumberId: phoneNumberId },
      select: { tenantId: true },
    }),
  );
  if (config) return config.tenantId;

  // Same number as the one in the environment: this is the env-configured
  // deployment described above, and the salon has to be worked out some other
  // way. Any OTHER number falls through to null, as it should.
  if (env.WHATSAPP_PHONE_NUMBER_ID && phoneNumberId === env.WHATSAPP_PHONE_NUMBER_ID) {
    return envConfiguredTenant();
  }

  return null;
}

async function envConfiguredTenant(): Promise<string | null> {
  if (cached) return cached.tenantId;
  const tenantId = await resolveEnvConfiguredTenant();
  cached = { tenantId };
  return tenantId;
}

async function resolveEnvConfiguredTenant(): Promise<string | null> {
  /**
   * Told, by id or by slug. Slug accepted because it is the thing a person
   * knows — nobody has a cuid to hand while editing an env file, and a setting
   * that is hard to fill in correctly gets filled in incorrectly.
   */
  if (env.WHATSAPP_TENANT_ID) {
    const tenant = await runUnscoped(() =>
      prisma.tenant.findFirst({
        where: { OR: [{ id: env.WHATSAPP_TENANT_ID }, { slug: env.WHATSAPP_TENANT_ID }] },
        select: { id: true, name: true },
      }),
    );
    if (tenant) {
      logger.info(
        { tenantId: tenant.id, salon: tenant.name },
        'inbound WhatsApp for the number in the environment will be attributed to this salon (WHATSAPP_TENANT_ID)',
      );
      return tenant.id;
    }
    logger.error(
      { configured: env.WHATSAPP_TENANT_ID },
      'WHATSAPP_TENANT_ID names no salon on this database, so inbound WhatsApp cannot be attributed ' +
        'and every customer reply will be dropped. Set it to a salon id or slug that exists.',
    );
    return null;
  }

  /**
   * Nobody told us, so the only safe inference: if there is exactly one salon,
   * the number is theirs. `take: 2` because the question is "is there more than
   * one", and counting the whole table to answer it is wasted work.
   */
  const tenants = await runUnscoped(() =>
    prisma.tenant.findMany({ select: { id: true, name: true }, take: 2 }),
  );

  if (tenants.length === 1) {
    const only = tenants[0]!;
    // Said out loud even though it is almost certainly right, because it is an
    // inference and the day it is wrong is the day somebody needs to find this
    // line in a log.
    logger.info(
      { tenantId: only.id, salon: only.name },
      'inbound WhatsApp for the number in the environment attributed to the only salon on this database',
    );
    return only.id;
  }

  if (tenants.length === 0) return null;

  logger.error(
    { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID },
    'WhatsApp is configured in the server environment and this database has more than one salon, ' +
      'so an inbound message cannot be attributed to one of them and customer replies are being dropped. ' +
      'Either connect WhatsApp per salon under Settings, or set WHATSAPP_TENANT_ID to the slug of the ' +
      'salon that owns this number.',
  );
  return null;
}
