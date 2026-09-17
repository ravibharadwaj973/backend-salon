import { Router } from 'express';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { asyncHandler } from '../../core/http';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { applyStatusUpdate } from '../../messaging/dispatcher';
import { normalizePhone } from '../../core/ids';
import { verifyWhatsAppSignature } from './whatsapp-signature';
import type { Prisma } from '@prisma/client';

const router = Router();

interface CloudApiStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  errors?: { title: string; message?: string }[];
}

interface CloudApiChangeValue {
  /**
   * Which of our salons this change is about. Every salon on the platform
   * reports to this one webhook URL, and `phone_number_id` is the only thing
   * in the payload that identifies whose number it is.
   */
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  statuses?: CloudApiStatus[];
  messages?: { from: string; text?: { body: string }; type: string }[];
}

interface CloudApiWebhook {
  entry?: { changes?: { value?: CloudApiChangeValue }[] }[];
}

/**
 * The salon a phone number belongs to.
 *
 * `waPhoneNumberId` is unique, so this is a single indexed lookup. A number we
 * do not recognise is not an error: Meta will keep delivering events for a
 * salon that has since disconnected, and for numbers on the same app that
 * belong to nobody here yet.
 */
async function tenantForPhoneNumber(phoneNumberId: string | undefined): Promise<string | null> {
  if (!phoneNumberId) return null;
  const config = await runUnscoped(() =>
    prisma.tenantMessagingConfig.findUnique({
      where: { waPhoneNumberId: phoneNumberId },
      select: { tenantId: true },
    }),
  );
  return config?.tenantId ?? null;
}

/** Meta's verification handshake. */
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

/**
 * Delivery receipts and inbound replies. Always answers 200 quickly: providers
 * retry aggressively on anything else.
 */
router.post(
  '/whatsapp',
  verifyWhatsAppSignature,
  asyncHandler(async (req, res) => {
    res.status(200).json({ received: true });

    const body = req.body as CloudApiWebhook;

    await runUnscoped(() =>
      prisma.webhookEvent.create({
        data: { provider: 'whatsapp_cloud', eventType: 'status', payload: body as unknown as Prisma.InputJsonValue },
      }),
    ).catch(() => undefined);

    // Walked change by change rather than flattened, because each change
    // carries its own phone_number_id and therefore its own salon. Flattening
    // the whole payload first throws that away — which is how a STOP meant for
    // one salon ended up applied to every salon on the platform.
    const changes = body.entry?.flatMap((e) => e.changes ?? []) ?? [];

    for (const change of changes) {
      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      const tenantId = await tenantForPhoneNumber(phoneNumberId);

      if (!tenantId) {
        // Not ours, or a salon that has since disconnected. Recorded above as a
        // webhook event either way, so nothing is lost.
        logger.warn({ phoneNumberId }, 'webhook for a phone number no salon has connected');
        continue;
      }

      // ------------------------------------------------------- delivery ---
      for (const status of value.statuses ?? []) {
        const mapped =
          status.status === 'delivered'
            ? ('DELIVERED' as const)
            : status.status === 'read'
              ? ('READ' as const)
              : status.status === 'failed'
                ? ('FAILED' as const)
                : null;
        if (!mapped) continue;

        await applyStatusUpdate({
          providerMessageId: status.id,
          status: mapped,
          errorMessage: status.errors?.[0]?.title,
          at: status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date(),
          tenantId,
        }).catch((err: unknown) => logger.warn({ err, id: status.id }, 'webhook status update failed'));
      }

      // --------------------------------------------------------- inbound ---
      // STOP / UNSUBSCRIBE switches marketing consent off — for the salon the
      // customer actually messaged, and only that one. Someone who tells their
      // hairdresser to stop has not opted out of the spa across town.
      for (const message of value.messages ?? []) {
        const text = message.text?.body?.trim().toUpperCase();
        if (!text || !['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT'].includes(text)) continue;

        const phone = normalizePhone(message.from);
        const result = await runUnscoped(() =>
          prisma.customer.updateMany({
            where: { tenantId, phone },
            data: { whatsappConsent: 'OPTED_OUT', consentUpdatedAt: new Date() },
          }),
        ).catch(() => ({ count: 0 }));

        logger.info({ tenantId, phone, updated: result.count }, 'customer opted out via WhatsApp');
      }
    }
  }),
);

/**
 * Resend delivery events.
 *
 * This is what turns "we sent 500" into "482 delivered, 301 opened, 74
 * clicked": without it the campaign screen can only ever report what left the
 * building. Point Resend at POST /webhooks/email and subscribe to the
 * email.* events.
 *
 * A bounce or a spam complaint switches email consent OFF for that customer,
 * and that is not optional politeness — a sending domain that keeps mailing
 * dead addresses or people who pressed "spam" is in the junk folder within
 * weeks, for every salon sharing it.
 */
interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; subject?: string; bounce?: { type?: string } };
}

router.post(
  '/email',
  asyncHandler(async (req, res) => {
    res.status(200).json({ received: true });

    const body = req.body as ResendEvent;
    const type = body.type ?? '';
    const providerMessageId = body.data?.email_id;

    await runUnscoped(() =>
      prisma.webhookEvent.create({
        data: { provider: 'resend', eventType: type || 'unknown', payload: body as unknown as Prisma.InputJsonValue },
      }),
    ).catch(() => undefined);

    if (!providerMessageId) return;
    const at = body.created_at ? new Date(body.created_at) : new Date();

    // Each Resend event keeps its own meaning rather than collapsing into
    // "failed". A bounce, a spam complaint and a temporary deferral call for
    // three different reactions from a salon, and lumping them together hides
    // the one that actually threatens the sending domain.
    const mapped =
      type === 'email.delivered'
        ? ('DELIVERED' as const)
        : type === 'email.opened'
          ? ('READ' as const)
          : type === 'email.clicked'
            ? ('CLICKED' as const)
            : type === 'email.bounced'
              ? ('BOUNCED' as const)
              : type === 'email.complained'
                ? ('COMPLAINED' as const)
                : type === 'email.delivery_delayed'
                  ? ('DELAYED' as const)
                  : type === 'email.failed'
                    ? ('FAILED' as const)
                    : null;

    // The salon this message belonged to. Looked up from the message itself,
    // because a Resend event carries nothing that identifies a tenant — and
    // without it the consent update below would reach across every salon.
    const owner = await runUnscoped(() =>
      prisma.messageLog.findFirst({
        where: { providerMessageId },
        select: { tenantId: true, customerId: true, toAddress: true },
      }),
    );

    if (mapped) {
      await applyStatusUpdate({
        providerMessageId,
        status: mapped,
        tenantId: owner?.tenantId,
        errorMessage:
          type === 'email.bounced'
            ? `Bounced (${body.data?.bounce?.type ?? 'unknown'})`
            : type === 'email.complained'
              ? 'Marked as spam by the recipient'
              : type === 'email.delivery_delayed'
                ? 'Delivery delayed by the receiving server — it may still arrive'
                : undefined,
        at,
      }).catch((err: unknown) => logger.warn({ err, providerMessageId }, 'email status update failed'));
    }

    // Stop mailing an address that bounced hard or complained.
    if (type === 'email.bounced' || type === 'email.complained') {
      const hardBounce = type === 'email.complained' || body.data?.bounce?.type !== 'Transient';
      if (!hardBounce) return;

      const address = owner?.toAddress ?? (Array.isArray(body.data?.to) ? body.data?.to[0] : body.data?.to);
      if (!address) return;

      // Scoped to the salon that sent it. Matching on the address alone would
      // opt that person out of every salon on the platform that happens to
      // have them on file — the same mistake the WhatsApp STOP handler made.
      // Without a tenant there is nothing safe to do, so nothing is done.
      if (!owner?.tenantId) {
        logger.warn({ providerMessageId, type }, 'bounce for a message no salon owns — consent left alone');
        return;
      }

      const result = await runUnscoped(() =>
        prisma.customer.updateMany({
          where: owner.customerId
            ? { id: owner.customerId }
            : { tenantId: owner.tenantId, email: address },
          data: { emailConsent: 'OPTED_OUT', consentUpdatedAt: new Date() },
        }),
      ).catch(() => ({ count: 0 }));

      logger.info(
        { tenantId: owner.tenantId, address, type, updated: result.count },
        'email consent switched off after bounce or complaint',
      );
    }
  }),
);

export default router;
