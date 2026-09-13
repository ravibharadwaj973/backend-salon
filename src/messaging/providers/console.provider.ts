import type { Channel } from '@prisma/client';
import { logger } from '../../core/logger';
import type { MessageProvider, OutboundMessage, SendResult } from './types';

/**
 * Development provider: logs the message instead of sending it. Lets the whole
 * journey/campaign engine be exercised without provider credentials.
 */
export class ConsoleProvider implements MessageProvider {
  readonly name = 'console';

  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    logger.info(
      { channel: this.channel, to: message.to, template: message.templateName, body: message.body },
      'message (console provider)',
    );
    return {
      ok: true,
      providerMessageId: `console_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      cost: 0,
    };
  }
}
