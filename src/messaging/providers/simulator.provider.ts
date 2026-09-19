import type { Channel } from '@prisma/client';
import { logger } from '../../core/logger';
import { enqueue } from '../../jobs/queue';
import type { MessageProvider, OutboundMessage, SendResult } from './types';

/**
 * A PRETEND CARRIER, FOR BUILDING AGAINST.
 *
 * Signing up for MSG91 takes a company, a DLT registration and a week. Until
 * that is done there is no way to exercise the SMS half of the product at all
 * — not the queue, not the delivery report, not the tracked link, not the
 * funnel that reads all three. This stands in for the carrier so the whole
 * path can be built and watched end to end.
 *
 * It differs from the console provider in one way that matters: the console
 * provider logs and stops, so every message sits at SENT forever. Real SMS
 * moves on — the carrier reports back a few seconds later — and a status that
 * never arrives is exactly the bug this feature exists to catch. So this one
 * schedules the delivery report too.
 *
 * Three rules keep it from lying:
 *
 *  - It refuses to run in production. A simulated delivery shown to a salon
 *    as a real one is worse than no SMS feature at all, and the check is at
 *    the point of use rather than in a comment asking someone to be careful.
 *  - Its message ids are prefixed `sim_`, so a simulated message is
 *    identifiable in the database forever, not just while it is on screen.
 *  - It fails a share of messages on purpose. A simulator where everything
 *    succeeds teaches you nothing about the failure path, which is the half
 *    of the product a salon actually reads.
 */

/**
 * Roughly what an Indian carrier does on a decent list: most arrive, a few
 * bounce off switched-off handsets and DND registrations.
 */
const FAILURE_RATE = 0.06;

/** How long a real carrier takes to report back, give or take. */
const REPORT_DELAY_MS = 4000;

export class SimulatorProvider implements MessageProvider {
  readonly name = 'simulator';

  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const providerMessageId = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    logger.info(
      { channel: this.channel, to: message.to, body: message.body, providerMessageId },
      'SIMULATED send — no message left the building',
    );

    // The delivery report a carrier would post to our webhook a few seconds
    // later. Queued rather than awaited, so the send returns at the speed a
    // real one would and the status genuinely arrives afterwards.
    const failed = Math.random() < FAILURE_RATE;
    await enqueue(
      'message.simulate_report',
      { providerMessageId, failed },
      { tenantId: null, runAt: new Date(Date.now() + REPORT_DELAY_MS) },
    ).catch((err: unknown) =>
      logger.warn({ err, providerMessageId }, 'simulated delivery report not scheduled'),
    );

    return { ok: true, providerMessageId, cost: 0 };
  }
}
