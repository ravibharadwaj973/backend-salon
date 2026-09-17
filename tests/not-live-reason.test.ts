import { describe, expect, it } from 'vitest';
import { notLiveReason } from '../src/modules/messaging/share.service';

/**
 * The sentence on the send screen when a message will be logged but not sent.
 *
 * It was written for WhatsApp and then reused for every channel, so somebody
 * on the Email tab was told they could "send it from your own WhatsApp below"
 * — next to a button that does not exist there.
 */

describe('why a message will not be delivered', () => {
  it('offers the WhatsApp fallback only on WhatsApp', () => {
    expect(notLiveReason('WHATSAPP', null)).toContain('your own WhatsApp');
    expect(notLiveReason('EMAIL', null)).not.toContain('WhatsApp');
    expect(notLiveReason('SMS', null)).not.toContain('WhatsApp');
  });

  it('names the channel the person is actually looking at', () => {
    expect(notLiveReason('EMAIL', null)).toMatch(/^Email is not connected/);
    expect(notLiveReason('SMS', null)).toMatch(/^SMS is not connected/);
  });

  it('says what is missing, so a saved-but-incomplete setup is not read as unsaved', () => {
    const reason = notLiveReason('EMAIL', 'RESEND_FROM_EMAIL on the server');
    expect(reason).toContain('RESEND_FROM_EMAIL on the server');
  });

  it('still reads as a sentence when nothing specific is known', () => {
    expect(notLiveReason('EMAIL', null)).not.toContain('undefined');
    expect(notLiveReason('EMAIL', null)).not.toContain('What is missing');
  });

  it('points to where the setup lives, except on WhatsApp where sending is still possible', () => {
    expect(notLiveReason('EMAIL', null)).toContain('Settings');
    expect(notLiveReason('SMS', null)).toContain('Settings');
  });
});
