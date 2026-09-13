import type { Channel } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { ConsoleProvider } from './console.provider';
import { WhatsAppCloudProvider } from './whatsapp.provider';
import { Msg91Provider } from './msg91.provider';
import { ResendEmailProvider } from './email.provider';
import type { MessageProvider } from './types';

/**
 * PROVIDER RESOLUTION IS PER TENANT.
 *
 * A salon's messages must arrive from the salon — their WhatsApp number, their
 * DLT-registered SMS header, their email domain. A customer who receives
 * "your appointment is confirmed" from a business they have never heard of
 * blocks the sender, and one salon's complaint then poisons delivery for every
 * other salon sharing that number.
 *
 * So credentials are read from the tenant's own config, and the environment is
 * only a fallback — useful for a demo tenant and for local development, never
 * the way a real salon should send.
 *
 * Anything unconfigured degrades to the console provider: logged, not sent.
 * That is deliberate. A journey that throws mid-run leaves customers half
 * messaged, which is worse than one that quietly records what it would have
 * sent while someone finishes the setup.
 */

export interface ResolvedProvider {
  provider: MessageProvider;
  /** False when we fell back to logging because nothing is configured. */
  live: boolean;
  source: 'tenant' | 'environment' | 'none';
}

export async function resolveProvider(channel: Channel, tenantId: string | null): Promise<ResolvedProvider> {
  const config = tenantId
    ? await runUnscoped(() => prisma.tenantMessagingConfig.findUnique({ where: { tenantId } }))
    : null;

  switch (channel) {
    case 'WHATSAPP': {
      if (config?.waAccessToken && config.waPhoneNumberId && config.waStatus === 'CONNECTED') {
        return {
          provider: new WhatsAppCloudProvider({
            accessToken: config.waAccessToken,
            phoneNumberId: config.waPhoneNumberId,
          }),
          live: true,
          source: 'tenant',
        };
      }
      if (env.MESSAGING_DRIVER === 'whatsapp_cloud' && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
        return {
          provider: new WhatsAppCloudProvider({
            accessToken: env.WHATSAPP_ACCESS_TOKEN,
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          }),
          live: true,
          source: 'environment',
        };
      }
      return { provider: new ConsoleProvider('WHATSAPP'), live: false, source: 'none' };
    }

    case 'SMS': {
      if (config?.smsApiKey && config.smsSenderId && config.smsStatus === 'CONNECTED') {
        return {
          provider: new Msg91Provider({
            apiKey: config.smsApiKey,
            senderId: config.smsSenderId,
            dltEntityId: config.smsDltEntityId,
            route: config.smsRoute,
          }),
          live: true,
          source: 'tenant',
        };
      }
      if (env.SMS_DRIVER === 'msg91' && env.SMS_API_KEY && env.SMS_SENDER_ID) {
        return {
          provider: new Msg91Provider({
            apiKey: env.SMS_API_KEY,
            senderId: env.SMS_SENDER_ID,
            dltEntityId: env.SMS_DLT_ENTITY_ID || null,
          }),
          live: true,
          source: 'environment',
        };
      }
      return { provider: new ConsoleProvider('SMS'), live: false, source: 'none' };
    }

    case 'EMAIL': {
      if (config?.emailApiKey && config.emailFromAddress && config.emailStatus === 'CONNECTED') {
        return {
          provider: new ResendEmailProvider({
            apiKey: config.emailApiKey,
            fromAddress: config.emailFromAddress,
            fromName: config.emailFromName,
            replyTo: config.emailReplyTo,
          }),
          live: true,
          source: 'tenant',
        };
      }
      if (env.EMAIL_DRIVER === 'resend' && env.EMAIL_API_KEY && env.EMAIL_FROM_ADDRESS) {
        // The platform's one address carries every salon's mail, so the salon
        // has to be visible another way: its name on the sender line, and its
        // own inbox as reply-to — a customer who hits Reply reaches the salon,
        // not a noreply@ that swallows the message.
        const tenant = tenantId
          ? await runUnscoped(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, email: true } }))
          : null;
        const platformName = env.EMAIL_FROM_NAME || null;
        return {
          provider: new ResendEmailProvider({
            apiKey: env.EMAIL_API_KEY,
            fromAddress: env.EMAIL_FROM_ADDRESS,
            fromName: tenant ? (platformName ? `${tenant.name} via ${platformName}` : tenant.name) : platformName,
            replyTo: tenant?.email ?? null,
          }),
          live: true,
          source: 'environment',
        };
      }
      return { provider: new ConsoleProvider('EMAIL'), live: false, source: 'none' };
    }

    default:
      return { provider: new ConsoleProvider(channel), live: false, source: 'none' };
  }
}

/** Synchronous fallback for callers with no tenant in hand (tests, tooling). */
export function getProvider(channel: Channel): MessageProvider {
  return new ConsoleProvider(channel);
}

export type { MessageProvider, OutboundMessage, SendResult } from './types';
