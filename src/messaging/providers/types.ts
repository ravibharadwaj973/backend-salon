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
  /**
   * The value filling each dynamic URL button's suffix, by button index.
   * Sparse: a static button leaves a hole, because Meta addresses a button's
   * parameter by its position among the buttons, not among the dynamic ones.
   */
  buttonValues?: (string | null)[];
  /**
   * Buttons with their URLs already resolved, for channels that carry the link
   * itself rather than a reference to an approved template.
   *
   * WhatsApp uses `buttonValues` instead, because Meta holds the button and we
   * only supply the tail of its URL. Email has no such arrangement: whatever we
   * send IS the message, so the whole address travels here and the provider
   * draws the button.
   */
  links?: { text: string; url: string }[];
  /**
   * Whose message this is, for a channel that draws one.
   *
   * The SALON's, never Parlon's. The customer booked with the salon, paid the
   * salon, and has never heard of the platform -- a Parlon logo at the top of
   * their invoice would be a company they do not recognise asking them for
   * money, which is what a phishing email looks like. Parlon's only appearance
   * is in the sender name when a salon uses the shared address, where it is
   * there to explain the unfamiliar domain rather than to advertise.
   */
  brand?: { name: string; logoUrl?: string | null };
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
