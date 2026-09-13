import type { Channel } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import type { MessageProvider, OutboundMessage, SendResult } from './types';

export interface EmailCredentials {
  apiKey: string;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
}

interface ResendResponse {
  id?: string;
  message?: string;
  name?: string;
}

/**
 * Email via Resend.
 *
 * Email is the quietest of the three channels for an Indian salon — only about
 * 2% of their customers have given an address — so this exists for invoices,
 * statements and the occasional owner-facing report rather than for campaigns.
 *
 * The from-address belongs to the salon and their domain has to be verified
 * with the provider first; sending as a salon from an unverified domain is how
 * a sending reputation is destroyed in a week.
 */
export class ResendEmailProvider implements MessageProvider {
  readonly name = 'resend';
  readonly channel: Channel = 'EMAIL';

  constructor(private readonly credentials: EmailCredentials) {}

  /** The body is plain text; wrap it so it is readable in a mail client. */
  private html(body: string): string {
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#221a20">${escaped}</div>`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const { apiKey, fromAddress, fromName, replyTo } = this.credentials;

    if (!apiKey || !fromAddress) {
      return { ok: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Email sender is not set up for this salon' };
    }

    try {
      const response = await fetch(`${env.EMAIL_API_URL}/emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
          to: [message.to],
          subject: message.subject ?? 'A message from your salon',
          text: message.body,
          html: this.html(message.body),
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });

      const data = (await response.json().catch(() => ({}))) as ResendResponse;

      if (!response.ok || !data.id) {
        return {
          ok: false,
          errorCode: data.name ?? `HTTP_${response.status}`,
          errorMessage: data.message ?? `Email provider rejected the message (${response.status})`,
        };
      }

      return { ok: true, providerMessageId: data.id, cost: env.EMAIL_COST_PER_MESSAGE };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'email send failed');
      return { ok: false, errorCode: 'NETWORK_ERROR', errorMessage };
    }
  }
}
