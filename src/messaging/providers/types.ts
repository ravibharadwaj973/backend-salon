import type { Channel } from '@prisma/client';

export interface OutboundMessage {
  to: string;
  channel: Channel;
  body: string;
  /** Provider-registered template name (required for WhatsApp marketing sends). */
  templateName?: string | null;
  language?: string;
  variables?: Record<string, string>;
  /** Ordered variable values, which is what the WhatsApp template API expects. */
  variableOrder?: string[];
  subject?: string;
  mediaUrl?: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Per-message cost, if the provider reports one. */
  cost?: number;
}

export interface MessageProvider {
  readonly name: string;
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<SendResult>;
}
