import type { Channel } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import type { MessageProvider, OutboundMessage, SendResult } from './types';

interface SendApiResponse {
  message_id?: string;
  recipient_id?: string;
  error?: { message: string; code: number; error_subcode?: number; type?: string };
}

/**
 * INSTAGRAM AND MESSENGER DIRECT MESSAGES.
 *
 * One provider for both, because the Send API is the same call with a different
 * id in front of it: POST /{account}/messages with a recipient id and a text
 * body. Splitting it into two classes would be two copies of one HTTP request
 * and two places to fix the next error-code mapping.
 *
 * What is NOT here, and deliberately:
 *
 *  - no templates. Neither channel has them. Outside the 24-hour window there
 *    is no approved-template fallback to reach for, so the dispatcher's window
 *    gate is the whole of the protection rather than half of it;
 *  - no cost. Meta charges nothing for a DM, so SendResult carries no `cost`
 *    and the meters these feed are counted-but-never-refused;
 *  - no link buttons. A DM carries the URL as text, which is why `links` is
 *    appended to the body rather than rendered as a structure the API would
 *    reject.
 */
export interface MetaDmCredentials {
  accessToken: string;
  /** The salon's Instagram account id, or their Page id. */
  accountId: string;
}

export class MetaDmProvider implements MessageProvider {
  readonly name: string;
  readonly channel: Channel;

  constructor(
    private readonly credentials: MetaDmCredentials,
    channel: Extract<Channel, 'INSTAGRAM' | 'MESSENGER'>,
  ) {
    this.channel = channel;
    this.name = channel === 'INSTAGRAM' ? 'instagram_dm' : 'messenger';
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const { accessToken, accountId } = this.credentials;

    if (!accessToken || !accountId) {
      return {
        ok: false,
        errorCode: 'NOT_CONFIGURED',
        errorMessage:
          this.channel === 'INSTAGRAM'
            ? 'Instagram is not connected for this salon'
            : 'Facebook is not connected for this salon',
      };
    }

    /**
     * `to` is a scoped id — an IGSID or a PSID — not a phone number.
     *
     * Worth stating because every other provider in this folder takes an
     * address a human could read, and a phone number arriving here is the
     * signature of a message that was routed to the wrong channel. It would
     * fail at Meta with a generic error; this says so plainly instead.
     */
    if (/^\+?\d{7,15}$/.test(message.to.trim())) {
      return {
        ok: false,
        errorCode: 'WRONG_ADDRESS',
        errorMessage:
          'A phone number was given for a direct message. Instagram and Messenger address people by a ' +
          'scoped id from the webhook, never by number — this message was routed to the wrong channel.',
      };
    }

    // A DM has no button structure, so a link travels as part of the sentence.
    const links = (message.links ?? []).map((link) => link.url).join(' ');
    const text = [message.body, links].filter(Boolean).join('\n\n').slice(0, 1000);

    const url = `${env.WHATSAPP_API_URL}/${accountId}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: message.to },
          message: { text },
          messaging_type: 'RESPONSE',
        }),
      });

      const data = (await response.json().catch(() => ({}))) as SendApiResponse;

      if (!response.ok || data.error) {
        const code = data.error?.code != null ? String(data.error.code) : String(response.status);
        logger.warn(
          { channel: this.channel, accountId, code, subcode: data.error?.error_subcode },
          'direct message refused by Meta',
        );
        return {
          ok: false,
          errorCode: code,
          errorMessage: data.error?.message ?? `Meta refused the message (HTTP ${response.status})`,
        };
      }

      return { ok: true, providerMessageId: data.message_id };
    } catch (error) {
      // A network failure is not a refusal. Returned as a failure with its own
      // code so the log can tell "Meta said no" from "we never reached Meta",
      // which have completely different fixes.
      logger.warn({ error, channel: this.channel }, 'direct message could not be sent');
      return {
        ok: false,
        errorCode: 'NETWORK',
        errorMessage: error instanceof Error ? error.message : 'could not reach Meta',
      };
    }
  }
}
