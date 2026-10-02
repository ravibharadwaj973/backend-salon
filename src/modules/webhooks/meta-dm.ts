/**
 * READING AN INSTAGRAM OR MESSENGER WEBHOOK.
 *
 * Pure, and separate from the route, because this is the part that is easy to
 * get quietly wrong and impossible to notice: the shapes are nested, the same
 * payload carries several kinds of event, and one of them — the echo — looks
 * exactly like a customer message with the sender and recipient the other way
 * round. A parser with tests is cheaper than finding that out from a salon.
 *
 * Both channels arrive at the same endpoint and differ only in `object`:
 * "instagram" for a DM to the salon's Instagram account, "page" for one to
 * their Facebook Page. Everything below is shared.
 */

export type DmChannel = 'INSTAGRAM' | 'MESSENGER';

export interface MetaDmEvent {
  channel: DmChannel;
  /**
   * The salon's own Instagram account id or Page id.
   *
   * The ONLY thing in the payload that says which business this belongs to,
   * which is why it is unique in the database. Everything else — the sender,
   * the text — is about the customer.
   */
  accountId: string;
  /**
   * The customer's scoped id: an IGSID on Instagram, a PSID on Messenger.
   *
   * NOT a phone number, and nothing can turn it into one. It is scoped to this
   * business — the same person messaging two salons is two different ids — so
   * it identifies a thread and never a person across salons.
   */
  customerAddress: string;
  providerMessageId: string;
  body: string;
  messageType: string;
  at: Date;
  /**
   * The salon said this, from the Instagram or Facebook app on their phone.
   *
   * Stored so the thread is complete and the assistant can see that a person
   * already answered — but never replied to, and never treated as the customer
   * writing in. Missing this is how an assistant ends up in a conversation with
   * itself.
   */
  isEcho: boolean;
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: { type?: string }[];
    reply_to?: { story?: unknown };
  };
}

interface RawWebhook {
  object?: string;
  entry?: { id?: string; messaging?: RawMessaging[] }[];
}

/**
 * What to show for a message that is not plain text.
 *
 * A photograph is most of what a salon receives on Instagram — somebody sends
 * a picture of the hair they want. The body has to say that something arrived,
 * because an empty bubble in the inbox reads as a bug and the salon will not
 * know to open Instagram and look.
 */
function describe(message: NonNullable<RawMessaging['message']>): { body: string; type: string } {
  const text = (message.text ?? '').trim();
  const attachment = message.attachments?.[0]?.type;

  if (text && attachment) return { body: text, type: attachment };
  if (text) return { body: text, type: message.reply_to?.story ? 'story_reply' : 'text' };

  switch (attachment) {
    case 'image':
      return { body: '[photo]', type: 'image' };
    case 'video':
      return { body: '[video]', type: 'video' };
    case 'audio':
      return { body: '[voice note]', type: 'audio' };
    case 'story_mention':
      return { body: '[mentioned you in a story]', type: 'story_mention' };
    case 'share':
      return { body: '[shared a post]', type: 'share' };
    default:
      return { body: attachment ? `[${attachment}]` : '', type: attachment ?? 'unknown' };
  }
}

/**
 * Every message in one webhook delivery, flattened but never merged.
 *
 * Walked entry by entry on purpose: each entry carries its OWN account id and
 * therefore its own salon. Flattening the messages first and reading the
 * account once would attribute a second salon's DMs to the first — the same
 * mistake the WhatsApp handler has a comment about, and the same reason.
 *
 * Anything that is not a message — a read receipt, a delivery receipt, a
 * reaction, a postback — is dropped here rather than half-handled downstream.
 */
export function parseMetaDmWebhook(payload: unknown): MetaDmEvent[] {
  const body = (payload ?? {}) as RawWebhook;

  const channel: DmChannel | null =
    body.object === 'instagram' ? 'INSTAGRAM' : body.object === 'page' ? 'MESSENGER' : null;
  if (!channel) return [];

  const events: MetaDmEvent[] = [];

  for (const entry of body.entry ?? []) {
    const accountId = entry.id;
    if (!accountId) continue;

    for (const item of entry.messaging ?? []) {
      const message = item.message;
      if (!message?.mid) continue;

      // A deletion and an unsupported type both arrive as messages with nothing
      // in them. Neither is something to store or answer.
      if (message.is_deleted || message.is_unsupported) continue;

      const isEcho = message.is_echo === true;

      /**
       * WHOSE THREAD THIS IS — and the one line most likely to be written
       * backwards.
       *
       * On an ordinary message the customer is the sender. On an ECHO the salon
       * is the sender and the customer is the recipient. Reading `sender.id`
       * either way files the salon's own replies under a thread addressed to
       * the salon itself: a conversation with its own account id, which no
       * screen can match to a customer and which the assistant would then
       * cheerfully answer.
       */
      const customerAddress = isEcho ? item.recipient?.id : item.sender?.id;
      if (!customerAddress || customerAddress === accountId) continue;

      const { body: text, type } = describe(message);

      events.push({
        channel,
        accountId,
        customerAddress,
        providerMessageId: message.mid,
        body: text,
        messageType: type,
        // Meta sends milliseconds here, unlike the WhatsApp webhook's seconds.
        // Reading one as the other puts a message in 1970 or in the year 56000.
        at: item.timestamp ? new Date(item.timestamp) : new Date(),
        isEcho,
      });
    }
  }

  return events;
}
