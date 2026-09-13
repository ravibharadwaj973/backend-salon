import type { Channel } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import type { MessageProvider, OutboundMessage, SendResult } from './types';

interface CloudApiResponse {
  messages?: { id: string }[];
  error?: { message: string; code: number; error_subcode?: number };
}

/**
 * WhatsApp Business Cloud API.
 *
 * Platform rules this deliberately respects:
 *  - business-initiated messages must use a template that Meta has approved,
 *    so `templateName` is required unless we are inside a 24-hour service
 *    window (free-form text);
 *  - opt-in is enforced upstream in the dispatcher, not here.
 */
export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export class WhatsAppCloudProvider implements MessageProvider {
  readonly name = 'whatsapp_cloud';
  readonly channel: Channel = 'WHATSAPP';

  /**
   * Credentials are passed in rather than read from the environment, because
   * each salon sends from its own WhatsApp Business Account — see
   * `resolveProvider` in ./index.ts.
   */
  constructor(private readonly credentials: WhatsAppCredentials) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const { accessToken, phoneNumberId } = this.credentials;

    if (!accessToken || !phoneNumberId) {
      return { ok: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'WhatsApp is not connected for this salon' };
    }

    const url = `${env.WHATSAPP_API_URL}/${phoneNumberId}/messages`;

    const payload = message.templateName
      ? {
          messaging_product: 'whatsapp',
          to: message.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: message.templateName,
            language: { code: message.language ?? 'en' },
            components: message.variableOrder?.length
              ? [
                  {
                    type: 'body',
                    parameters: message.variableOrder.map((key) => ({
                      type: 'text',
                      text: message.variables?.[key] ?? '',
                    })),
                  },
                ]
              : [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          to: message.to.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body: message.body },
        };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as CloudApiResponse;

      if (!response.ok || data.error) {
        return {
          ok: false,
          errorCode: String(data.error?.code ?? response.status),
          errorMessage: data.error?.message ?? `WhatsApp API returned ${response.status}`,
        };
      }

      return { ok: true, providerMessageId: data.messages?.[0]?.id };
    } catch (err) {
      logger.error({ err }, 'whatsapp send failed');
      return {
        ok: false,
        errorCode: 'NETWORK_ERROR',
        errorMessage: err instanceof Error ? err.message : 'Unknown network error',
      };
    }
  }
}
