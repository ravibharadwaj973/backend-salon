import { describe, expect, it, vi } from 'vitest';

/**
 * THE THREAD, AND WHO IS SPEAKING IN IT.
 *
 * Two things here can go wrong silently, which is why they are the two things
 * pinned.
 *
 * The thread is assembled from two tables rather than stored in one — the
 * customer's messages and the salon's live apart, and are merged by time on
 * read. Get that wrong and a salon reads its own conversation out of order,
 * which is not a rendering bug: it changes what the conversation appears to
 * mean, and nothing errors.
 *
 * And a staff reply and the assistant's are identical on the wire — free-form
 * WhatsApp, no template, purpose OTHER. Telling them apart is most of why
 * anybody opens the inbox, and the only thing that can is who is recorded as
 * having typed it.
 */

const db = {
  inbound: [] as { id: string; body: string; receivedAt: Date; messageType: string }[],
  outbound: [] as {
    id: string;
    renderedBody: string | null;
    queuedAt: Date;
    status: string;
    errorMessage: string | null;
    campaignId: string | null;
    journeyRunId: string | null;
    sentByUserId: string | null;
  }[],
};

vi.mock('../src/core/prisma', () => ({
  prisma: {
    inboundMessage: { findMany: () => Promise.resolve(db.inbound) },
    messageLog: { findMany: () => Promise.resolve(db.outbound) },
  },
}));
vi.mock('../src/core/context', () => ({ runUnscoped: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../src/messaging/dispatcher', () => ({ queueMessage: () => Promise.resolve() }));
vi.mock('../src/config/env', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
  isTest: true,
  isProd: false,
  aiReady: false,
}));

const { speakerFor, threadFor } = await import('../src/modules/messaging/conversation.service');

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 12, minute, 0));

function customerSaid(id: string, body: string, minute: number) {
  return { id, body, receivedAt: at(minute), messageType: 'text' };
}

function salonSaid(
  id: string,
  body: string,
  minute: number,
  extra: Partial<(typeof db.outbound)[number]> = {},
) {
  return {
    id,
    renderedBody: body,
    queuedAt: at(minute),
    status: 'DELIVERED',
    errorMessage: null,
    campaignId: null,
    journeyRunId: null,
    sentByUserId: null,
    ...extra,
  };
}

describe('the thread, merged from two tables', () => {
  it('interleaves both sides in the order they were said', async () => {
    /**
     * The whole risk of assembling rather than storing. Read as two blocks —
     * everything the customer said, then everything the salon said — a booking
     * conversation becomes nonsense, and nothing anywhere reports an error.
     */
    db.inbound = [customerSaid('i1', 'I want a hair spa', 1), customerSaid('i2', 'tomorrow at 6', 3)];
    db.outbound = [salonSaid('o1', 'Which day suits you?', 2), salonSaid('o2', '6pm is free. Book it?', 4)];

    const turns = await threadFor('c1');

    expect(turns.map((t) => t.body)).toEqual([
      'I want a hair spa',
      'Which day suits you?',
      'tomorrow at 6',
      '6pm is free. Book it?',
    ]);
  });

  it('marks each turn with the side that said it', async () => {
    db.inbound = [customerSaid('i1', 'hello', 1)];
    db.outbound = [salonSaid('o1', 'hello back', 2)];

    const turns = await threadFor('c1');
    expect(turns.map((t) => t.from)).toEqual(['CUSTOMER', 'AI']);
  });

  it('keeps the newest when a thread is longer than the limit', async () => {
    // A conversation running for weeks must not open on its first week.
    db.inbound = Array.from({ length: 10 }, (_, i) => customerSaid(`i${i}`, `message ${i}`, i));
    db.outbound = [];

    const turns = await threadFor('c1', 3);
    expect(turns.map((t) => t.body)).toEqual(['message 7', 'message 8', 'message 9']);
  });

  it('carries the delivery status and the reason a send failed', async () => {
    // The reason belongs on the message it happened to. Without it somebody
    // goes to the message log to guess which one did not arrive.
    db.inbound = [];
    db.outbound = [
      salonSaid('o1', 'are you free Tuesday?', 1, {
        status: 'FAILED',
        errorMessage: 'Message failed to send because more than 24 hours have passed',
      }),
    ];

    const [turn] = await threadFor('c1');
    expect(turn?.status).toBe('FAILED');
    expect(turn?.error).toMatch(/24 hours/);
  });

  it('shows an empty body for a photo rather than dropping the turn', async () => {
    // A salon should see that something arrived even when nothing here can
    // display it; a missing turn reads as the customer never writing.
    db.inbound = [{ id: 'i1', body: '', receivedAt: at(1), messageType: 'image' }];
    db.outbound = [];

    const [turn] = await threadFor('c1');
    expect(turn?.messageType).toBe('image');
    expect(turn?.from).toBe('CUSTOMER');
  });
});

describe('telling the assistant from a person', () => {
  it('calls it HUMAN when somebody typed it', () => {
    expect(speakerFor({ campaignId: null, journeyRunId: null, sentByUserId: 'user_1' })).toBe('HUMAN');
  });

  it('calls it AI when nobody did', () => {
    expect(speakerFor({ campaignId: null, journeyRunId: null, sentByUserId: null })).toBe('AI');
  });

  it('calls a campaign send SYSTEM, not the assistant', () => {
    /**
     * A blast going out to four hundred people is not the assistant answering
     * this customer, and labelling it so would make the assistant look like it
     * says things it never said.
     */
    expect(speakerFor({ campaignId: 'camp_1', journeyRunId: null, sentByUserId: null })).toBe('SYSTEM');
    expect(speakerFor({ campaignId: null, journeyRunId: 'run_1', sentByUserId: null })).toBe('SYSTEM');
  });

  it('calls an automated send SYSTEM even when a user triggered it', () => {
    // Somebody pressing "send campaign" did not type this message to this
    // customer, so the thread must not show it as their words.
    expect(speakerFor({ campaignId: 'camp_1', journeyRunId: null, sentByUserId: 'user_1' })).toBe('SYSTEM');
  });
});
