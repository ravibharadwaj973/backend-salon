import { Router } from 'express';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { asyncHandler } from '../../core/http';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { applyStatusUpdate } from '../../messaging/dispatcher';
import type { Prisma } from '@prisma/client';

const router = Router();

interface CloudApiStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  errors?: { title: string; message?: string }[];
}

interface CloudApiWebhook {
  entry?: {
    changes?: {
      value?: {
        statuses?: CloudApiStatus[];
        messages?: { from: string; text?: { body: string }; type: string }[];
      };
    }[];
  }[];
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
  asyncHandler(async (req, res) => {
    res.status(200).json({ received: true });

    const body = req.body as CloudApiWebhook;

    await runUnscoped(() =>
      prisma.webhookEvent.create({
        data: { provider: 'whatsapp_cloud', eventType: 'status', payload: body as unknown as Prisma.InputJsonValue },
      }),
    ).catch(() => undefined);

    const statuses = body.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.statuses ?? []) ?? []) ?? [];

    for (const status of statuses) {
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
      }).catch((err: unknown) => logger.warn({ err, id: status.id }, 'webhook status update failed'));
    }

    // Inbound replies: STOP / UNSUBSCRIBE must switch marketing consent off.
    const inbound = body.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages ?? []) ?? []) ?? [];
    for (const message of inbound) {
      const text = message.text?.body?.trim().toUpperCase();
      if (!text || !['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT'].includes(text)) continue;

      const phone = message.from.replace(/^\+?91/, '');
      await runUnscoped(() =>
        prisma.customer.updateMany({
          where: { phone },
          data: { whatsappConsent: 'OPTED_OUT', consentUpdatedAt: new Date() },
        }),
      ).catch(() => undefined);
      logger.info({ phone }, 'customer opted out via WhatsApp');
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

    const mapped =
      type === 'email.delivered'
        ? ('DELIVERED' as const)
        : type === 'email.opened'
          ? ('READ' as const)
          : type === 'email.clicked'
            ? ('CLICKED' as const)
            : type === 'email.bounced' || type === 'email.complained' || type === 'email.delivery_delayed'
              ? ('FAILED' as const)
              : null;

    if (mapped) {
      await applyStatusUpdate({
        providerMessageId,
        status: mapped,
        errorMessage:
          type === 'email.bounced'
            ? `Bounced (${body.data?.bounce?.type ?? 'unknown'})`
            : type === 'email.complained'
              ? 'Marked as spam by the recipient'
              : type === 'email.delivery_delayed'
                ? 'Delivery delayed by the receiving server'
                : undefined,
        at,
      }).catch((err: unknown) => logger.warn({ err, providerMessageId }, 'email status update failed'));
    }

    // Stop mailing an address that bounced hard or complained.
    if (type === 'email.bounced' || type === 'email.complained') {
      const hardBounce = type === 'email.complained' || body.data?.bounce?.type !== 'Transient';
      if (!hardBounce) return;

      const log = await runUnscoped(() =>
        prisma.messageLog.findFirst({ where: { providerMessageId }, select: { customerId: true, toAddress: true } }),
      );
      const address = log?.toAddress ?? (Array.isArray(body.data?.to) ? body.data?.to[0] : body.data?.to);
      if (!address) return;

      await runUnscoped(() =>
        prisma.customer.updateMany({
          where: log?.customerId ? { id: log.customerId } : { email: address },
          data: { emailConsent: 'OPTED_OUT', consentUpdatedAt: new Date() },
        }),
      ).catch(() => undefined);
      logger.info({ address, type }, 'email consent switched off after bounce or complaint');
    }
  }),
);

export default router;
