import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Sent 4 · Delivered 0 · 4 did not get this far."
 *
 * That screen asserted four failures. What had actually happened is that
 * WhatsApp accepted all four messages and never sent a status callback, so the
 * app knew nothing about them either way.
 *
 * Those are opposite conclusions, and the salon acts very differently on each:
 * "did not arrive" means correct the customers' phone numbers, "nothing heard
 * back" means fix the webhook. Printing the first when you mean the second
 * sends somebody to edit four perfectly good numbers.
 *
 * Zero is a measurement. The absence of one is not, and no screen may render
 * them the same way.
 */
describe('the count of messages nobody has heard back about', () => {
  const SERVICE = readFileSync(
    join(__dirname, '..', 'src/modules/marketing/campaign.service.ts'),
    'utf8',
  );

  it('counts only messages with no receipt AND no error', () => {
    // A message that failed IS known about — it belongs in "did not arrive",
    // not in "we have not heard". Including it would hide real failures behind
    // a reassuring "no receipt yet".
    const start = SERVICE.indexOf('prisma.messageLog.count({');
    expect(start, 'the awaiting-receipt count must exist').toBeGreaterThan(-1);
    const query = SERVICE.slice(start, SERVICE.indexOf('}),', start));

    expect(query).toContain("status: 'SENT'");
    expect(query).toContain('deliveredAt: null');
    // The important one: a message that FAILED is known about, and belongs in
    // "did not arrive" rather than "we have not heard".
    expect(query).toContain('errorCode: null');
  });

  it('checks the whole salon before blaming the webhook', () => {
    // One quiet campaign is not evidence. "No receipt has EVER arrived for any
    // message" is, and it is the difference between a confident diagnosis and
    // a guess that sends somebody to reconfigure a working webhook.
    expect(SERVICE).toContain('looksUnwired');
    const verdict = SERVICE.slice(SERVICE.indexOf('looksUnwired:'));
    expect(verdict.slice(0, 120)).toContain('tenantLastReceipt');
  });
});

/**
 * The display half of this lives in the frontend repo and is checked by its own
 * build and types: FunnelStage gained an `unreported` field, the "did not get
 * this far" sentence is now reachable only for a shortfall that is genuinely
 * lost, and the percentage is withheld while a stage is unreported. A test here
 * cannot read that file — they are separate repositories, and reaching across
 * would pass on a developer's laptop and fail in CI.
 */
