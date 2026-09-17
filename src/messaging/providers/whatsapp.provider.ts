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
        const code = String(data.error?.code ?? response.status);
        return {
          ok: false,
          errorCode: code,
          errorMessage: explain(code, data.error?.message, Boolean(message.templateName)),
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

/**
 * Meta's error text is written for the developer who made the API call, not
 * for the receptionist looking at a failed message in the app. "More than 24
 * hours have passed since the customer last replied" is accurate and tells
 * nobody what to do about it.
 *
 * These five cover almost every failure in practice. Meta's own wording is
 * kept on the end, because when the cause is something else that sentence is
 * the only clue anyone has.
 */
function explain(code: string, metaMessage: string | undefined, hadTemplate: boolean): string {
  const detail = metaMessage ? ` (WhatsApp said: ${metaMessage})` : '';

  switch (code) {
    case '131047':
      return hadTemplate
        ? `WhatsApp refused this template. It is usually not approved yet, or its name and language do not match what Meta approved.${detail}`
        : `WhatsApp will not deliver this message because it has no approved template. A business can only send free text within 24 hours of the customer messaging first; outside that window the message must use a template approved by Meta. Set the approved template name on this message template under Templates.${detail}`;

    case '131030':
      return `This number is not on the allowed list for your WhatsApp test number. A test number can only message the few recipients registered in the Meta dashboard — real customers need a production number.${detail}`;

    case '132001':
      return `Meta has no template by that name in this language. Check the approved template name and language code on this template — "en" and "en_US" are different templates to Meta.${detail}`;

    case '190':
      return `The WhatsApp access token has expired or been revoked. Reconnect WhatsApp under Settings → Messaging.${detail}`;

    case '131026':
      return `WhatsApp could not deliver to this number. It usually means the number has no WhatsApp account, or it cannot receive messages from businesses.${detail}`;

    case '133010':
      return `This WhatsApp number is not registered for sending yet. Finish registering it in the Meta dashboard.${detail}`;

    default:
      return metaMessage ?? `WhatsApp API returned ${code}`;
  }
}
