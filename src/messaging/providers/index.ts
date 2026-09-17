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
  /**
   * When not live, what is actually missing.
   *
   * "Not connected" is a useless thing to read when you have just pasted an
   * API key and saved it. Half-configured is the common case — a key with no
   * from-address, a WhatsApp number saved but never verified — and it looks
   * identical to nothing at all from the send screen.
   */
  missing: string | null;
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
          missing: null,
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
          missing: null,
        };
      }
      return {
        provider: new ConsoleProvider('WHATSAPP'),
        live: false,
        source: 'none',
        missing: whatIsMissing([
          [!config?.waPhoneNumberId, 'the WhatsApp Phone Number ID'],
          [!config?.waAccessToken, 'the access token'],
          [Boolean(config?.waAccessToken && config.waPhoneNumberId && config.waStatus !== 'CONNECTED'), 'a successful test send — the number is saved but not verified yet'],
        ]),
      };
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
          missing: null,
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
          missing: null,
        };
      }
      return {
        provider: new ConsoleProvider('SMS'),
        live: false,
        source: 'none',
        missing: whatIsMissing([
          [!config?.smsApiKey, 'the SMS API key'],
          [!config?.smsSenderId, 'the DLT-registered sender ID'],
          [Boolean(config?.smsApiKey && config.smsSenderId && config.smsStatus !== 'CONNECTED'), 'a successful test send — the details are saved but not verified yet'],
        ]),
      };
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
          missing: null,
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
          missing: null,
        };
      }
      // The platform fallback is the usual way email is sent, so when the salon
      // has configured nothing itself, say what the SERVER is missing — that is
      // where somebody setting Resend up has actually gone wrong.
      const salonTried = Boolean(config?.emailApiKey || config?.emailFromAddress);
      return {
        provider: new ConsoleProvider('EMAIL'),
        live: false,
        source: 'none',
        missing: salonTried
          ? whatIsMissing([
              [!config?.emailApiKey, 'the email API key'],
              [!config?.emailFromAddress, 'the from address'],
              [Boolean(config?.emailApiKey && config.emailFromAddress && config.emailStatus !== 'CONNECTED'), 'a successful test send — the details are saved but not verified yet'],
            ])
          : whatIsMissing([
              [!env.EMAIL_API_KEY, 'RESEND_API_KEY on the server'],
              [!env.EMAIL_FROM_ADDRESS, 'RESEND_FROM_EMAIL on the server — an address on the verified domain, not the bare domain'],
            ]),
      };
    }

    default:
      return { provider: new ConsoleProvider(channel), live: false, source: 'none', missing: null };
  }
}

/**
 * Join the reasons that apply into one readable phrase, or null if none do.
 *
 * Listing everything that is absent beats naming only the first: somebody who
 * fixes one thing and sees the same screen again assumes it did not save.
 */
function whatIsMissing(checks: [boolean, string][]): string | null {
  const reasons = checks.filter(([applies]) => applies).map(([, reason]) => reason);
  if (reasons.length === 0) return null;
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`;
}

/** Synchronous fallback for callers with no tenant in hand (tests, tooling). */
export function getProvider(channel: Channel): MessageProvider {
  return new ConsoleProvider(channel);
}

export type { MessageProvider, OutboundMessage, SendResult } from './types';
