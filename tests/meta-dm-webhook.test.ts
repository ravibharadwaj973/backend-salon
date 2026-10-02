import { describe, expect, it } from 'vitest';
import { parseMetaDmWebhook } from '../src/modules/webhooks/meta-dm';

/**
 * THE PARSER THAT DECIDES WHOSE MESSAGE THIS IS.
 *
 * Every case here is a way the salon loses a customer or the assistant talks to
 * itself, and none of them would be visible from reading the code — the shapes
 * are nested and two of them differ only in which side of the payload the
 * customer is on.
 */

const igMessage = (over: Record<string, unknown> = {}) => ({
  object: 'instagram',
  entry: [
    {
      id: 'ig-salon-1',
      messaging: [
        {
          sender: { id: 'igsid-priya' },
          recipient: { id: 'ig-salon-1' },
          timestamp: 1_767_000_000_000,
          message: { mid: 'mid-1', text: 'hi, haircut kitne ka hai?', ...over },
        },
      ],
    },
  ],
});

describe('which salon, and which customer', () => {
  it('reads an Instagram DM', () => {
    const [event] = parseMetaDmWebhook(igMessage());
    expect(event).toMatchObject({
      channel: 'INSTAGRAM',
      accountId: 'ig-salon-1',
      customerAddress: 'igsid-priya',
      providerMessageId: 'mid-1',
      body: 'hi, haircut kitne ka hai?',
      isEcho: false,
    });
  });

  it('reads a Messenger DM from the same endpoint', () => {
    const [event] = parseMetaDmWebhook({
      object: 'page',
      entry: [
        {
          id: 'page-salon-9',
          messaging: [
            {
              sender: { id: 'psid-anita' },
              recipient: { id: 'page-salon-9' },
              timestamp: 1_767_000_000_000,
              message: { mid: 'mid-2', text: 'are you open tomorrow' },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({ channel: 'MESSENGER', accountId: 'page-salon-9', customerAddress: 'psid-anita' });
  });

  it('keeps two salons in one delivery apart', () => {
    // Meta batches entries, and each entry is a different business. Reading the
    // account once and applying it to every message would file one salon's
    // customers under another — and they would see each other's DMs.
    const events = parseMetaDmWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig-salon-1',
          messaging: [{ sender: { id: 'a' }, recipient: { id: 'ig-salon-1' }, message: { mid: 'm1', text: 'one' } }],
        },
        {
          id: 'ig-salon-2',
          messaging: [{ sender: { id: 'b' }, recipient: { id: 'ig-salon-2' }, message: { mid: 'm2', text: 'two' } }],
        },
      ],
    });
    expect(events.map((e) => [e.accountId, e.customerAddress])).toEqual([
      ['ig-salon-1', 'a'],
      ['ig-salon-2', 'b'],
    ]);
  });

  it('ignores an object it does not know', () => {
    expect(parseMetaDmWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([]);
    expect(parseMetaDmWebhook({})).toEqual([]);
    expect(parseMetaDmWebhook(null)).toEqual([]);
  });
});

describe('the echo — the salon answering from their own phone', () => {
  it('takes the customer from the RECIPIENT, not the sender', () => {
    // The one line most likely to be written backwards. On an echo the salon is
    // the sender; reading sender.id here would open a thread addressed to the
    // salon's own account, which no screen can match to a customer and which
    // the assistant would then answer.
    const [event] = parseMetaDmWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig-salon-1',
          messaging: [
            {
              sender: { id: 'ig-salon-1' },
              recipient: { id: 'igsid-priya' },
              message: { mid: 'mid-echo', text: 'haircut is ₹400', is_echo: true },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({ customerAddress: 'igsid-priya', isEcho: true, body: 'haircut is ₹400' });
  });

  it('never produces a thread addressed to the salon itself', () => {
    const events = parseMetaDmWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig-salon-1',
          // Malformed, and seen in the wild: both sides the business.
          messaging: [{ sender: { id: 'ig-salon-1' }, recipient: { id: 'ig-salon-1' }, message: { mid: 'x', text: 'hm' } }],
        },
      ],
    });
    expect(events).toEqual([]);
  });
});

describe('what is not a message', () => {
  it('drops read receipts, reactions and postbacks', () => {
    const events = parseMetaDmWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'ig-salon-1',
          messaging: [
            { sender: { id: 'a' }, recipient: { id: 'ig-salon-1' }, read: { mid: 'm1' } },
            { sender: { id: 'a' }, recipient: { id: 'ig-salon-1' }, reaction: { emoji: '❤️' } },
            { sender: { id: 'a' }, recipient: { id: 'ig-salon-1' }, postback: { title: 'Book' } },
          ] as never,
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('drops a deleted or unsupported message', () => {
    expect(parseMetaDmWebhook(igMessage({ is_deleted: true }))).toEqual([]);
    expect(parseMetaDmWebhook(igMessage({ is_unsupported: true }))).toEqual([]);
  });

  it('drops a message with no id, because there is then no way to dedupe it', () => {
    // Meta retries until it gets a 200. Without the id a retry is a second
    // message to a real person, so losing one is better than answering twice.
    const events = parseMetaDmWebhook({
      object: 'instagram',
      entry: [{ id: 'ig-salon-1', messaging: [{ sender: { id: 'a' }, message: { text: 'hello' } }] }],
    });
    expect(events).toEqual([]);
  });
});

describe('messages that are not words', () => {
  it('says a photo arrived rather than storing an empty bubble', () => {
    // Most of what a salon gets on Instagram is a picture of the hair somebody
    // wants. An empty row in the inbox reads as a bug, and the salon never
    // knows to go and look.
    const [event] = parseMetaDmWebhook(
      igMessage({ text: undefined, attachments: [{ type: 'image' }] }),
    );
    expect(event).toMatchObject({ body: '[photo]', messageType: 'image' });
  });

  it('keeps the caption when there is both text and an attachment', () => {
    const [event] = parseMetaDmWebhook(igMessage({ text: 'like this one', attachments: [{ type: 'image' }] }));
    expect(event).toMatchObject({ body: 'like this one', messageType: 'image' });
  });

  it('names a story mention and a voice note', () => {
    expect(parseMetaDmWebhook(igMessage({ text: undefined, attachments: [{ type: 'story_mention' }] }))[0])
      .toMatchObject({ body: '[mentioned you in a story]' });
    expect(parseMetaDmWebhook(igMessage({ text: undefined, attachments: [{ type: 'audio' }] }))[0])
      .toMatchObject({ body: '[voice note]' });
  });

  it('marks a reply to a story as one', () => {
    const [event] = parseMetaDmWebhook(igMessage({ reply_to: { story: { id: 's1' } } }));
    expect(event.messageType).toBe('story_reply');
  });
});

describe('time', () => {
  it('reads Meta DM timestamps as milliseconds', () => {
    // The WhatsApp webhook sends SECONDS and this one sends milliseconds.
    // Reading one as the other puts the message in 1970 or in the year 56000,
    // and the inbox sorts on it.
    const [event] = parseMetaDmWebhook(igMessage());
    expect(event.at.getUTCFullYear()).toBe(2025);
  });
});

describe('which ad sent them', () => {
  /**
   * Meta attaches the referral to the FIRST message of a thread and to no
   * other. Miss it there and that DM is unattributable forever — there is no
   * backfill and no second delivery. It is the only way a direct message can
   * ever be tied to the thing that produced it.
   */
  it('reads a referral nested inside the message, as Instagram sends it', () => {
    const [event] = parseMetaDmWebhook(
      igMessage({ referral: { ref: 'diwali-reel', ad_id: '120210000000000000' } }),
    );
    expect(event.referral).toEqual({ ref: 'diwali-reel', adId: '120210000000000000' });
  });

  it('reads a referral alongside the message, as Messenger sends it', () => {
    // The two products put it in different places. A parser that knows only one
    // loses attribution on half the traffic and nothing says so.
    const [event] = parseMetaDmWebhook({
      object: 'page',
      entry: [
        {
          id: 'page-salon-9',
          messaging: [
            {
              sender: { id: 'psid-anita' },
              recipient: { id: 'page-salon-9' },
              referral: { ref: 'bridal-oct', ad_id: '120299999999999999', source: 'ADS' },
              message: { mid: 'mid-ref-2', text: 'hi' },
            },
          ],
        },
      ],
    });
    expect(event.referral).toEqual({ ref: 'bridal-oct', adId: '120299999999999999' });
  });

  it('is null on an ordinary DM, so nothing is attributed by accident', () => {
    expect(parseMetaDmWebhook(igMessage())[0]!.referral).toBeNull();
  });

  it('is null when the referral is present but empty', () => {
    // An empty ref is not an attribution. Storing '' would file every organic
    // DM under one blank source.
    expect(parseMetaDmWebhook(igMessage({ referral: { ref: '  ', ad_id: '' } }))[0]!.referral).toBeNull();
  });

  it('keeps the ad id even when the salon set no ref', () => {
    // Boosting a post from the phone gives an ad id and no ref at all, which is
    // the commonest paid thing an Indian salon does.
    expect(parseMetaDmWebhook(igMessage({ referral: { ad_id: '12021' } }))[0]!.referral).toEqual({
      ref: null,
      adId: '12021',
    });
  });
});
