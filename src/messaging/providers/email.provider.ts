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

  /**
   * The body is plain text; wrap it so it is readable in a mail client.
   *
   * Everything is escaped first, because the body carries customer-supplied
   * values -- a name with an angle bracket in it must not become markup. The
   * links are put back AFTERWARDS, on the escaped text, so a bare
   * https://... in the wording is clickable rather than a string of
   * characters the customer has to select and copy. Gmail guesses at this;
   * plenty of clients do not.
   */
  private html(body: string, links: { text: string; url: string }[] = []): string {
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const linked = escaped
      .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#0f766e">$1</a>')
      .replace(/\n/g, '<br>');

    // A real button, built the way email has to build one: a table cell with a
    // background and an anchor filling it. Outlook ignores padding on an <a>
    // and rounded corners on anything, so the button degrades to a square
    // block of colour there rather than to nothing.
    const buttons = links
      .filter((link) => /^https?:\/\//i.test(link.url))
      .map(
        (link) => `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px">
            <tr><td style="background:#0f766e;border-radius:6px">
              <a href="${this.attr(link.url)}"
                 style="display:inline-block;padding:11px 22px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${this.text(link.text)}</a>
            </td></tr>
          </table>
          <p style="margin:0;font-size:12px;color:#6b625f">
            If the button does not work, copy this into your browser:<br>
            <a href="${this.attr(link.url)}" style="color:#6b625f">${this.text(link.url)}</a>
          </p>`,
      )
      .join('');

    return (
      `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#221a20">` +
      `${linked}${buttons}</div>`
    );
  }

  /** Escaping for an attribute, where a stray quote would end it early. */
  private attr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private text(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * The plain-text half. A client that shows text only still has to be able to
   * reach the invoice, so the button becomes a line with the address in it.
   */
  private plain(body: string, links: { text: string; url: string }[] = []): string {
    const tail = links
      .filter((link) => /^https?:\/\//i.test(link.url))
      .map((link) => `\n\n${link.text}: ${link.url}`)
      .join('');
    return `${body}${tail}`;
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
          text: this.plain(message.body, message.links),
          html: this.html(message.body, message.links),
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
