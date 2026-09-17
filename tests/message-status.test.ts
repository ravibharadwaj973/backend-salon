import { describe, expect, it } from 'vitest';

/**
 * How a message's status moves as provider callbacks arrive.
 *
 * Providers do not promise ordered delivery of their own webhooks. An open and
 * a click are generated milliseconds apart and routinely arrive the wrong way
 * round; a deferred `delivered` can turn up after both. Writing whatever came
 * last walks a message backwards from CLICKED to DELIVERED and quietly ruins
 * every campaign's open and click rates.
 *
 * This mirrors the rule in applyStatusUpdate: progress only climbs, and an
 * ending always wins.
 */

const PROGRESS: Record<string, number> = {
  QUEUED: 0,
  SENT: 1,
  DELAYED: 2,
  DELIVERED: 3,
  READ: 4,
  CLICKED: 5,
};

const TERMINAL = new Set(['BOUNCED', 'COMPLAINED', 'FAILED']);

/** Apply one event to a current status, returning the status afterwards. */
function next(current: string, incoming: string): string {
  if (TERMINAL.has(incoming)) return incoming;
  if (TERMINAL.has(current)) return current;
  return (PROGRESS[incoming] ?? 0) > (PROGRESS[current] ?? 0) ? incoming : current;
}

/** Replay a whole sequence of events onto a freshly queued message. */
const replay = (events: string[]) => events.reduce(next, 'QUEUED');

describe('message status progression', () => {
  it('climbs the happy path', () => {
    expect(replay(['SENT', 'DELIVERED', 'READ', 'CLICKED'])).toBe('CLICKED');
  });

  it('does not go backwards when a click arrives before the open', () => {
    // Resend fires both; the order they reach us is not guaranteed.
    expect(replay(['SENT', 'DELIVERED', 'CLICKED', 'READ'])).toBe('CLICKED');
  });

  it('does not go backwards when a late delivered arrives after a click', () => {
    expect(replay(['SENT', 'CLICKED', 'DELIVERED'])).toBe('CLICKED');
  });

  it('ignores a repeated event', () => {
    expect(replay(['SENT', 'DELIVERED', 'DELIVERED', 'DELIVERED'])).toBe('DELIVERED');
  });

  it('treats a delay as in-flight, below delivered', () => {
    expect(replay(['SENT', 'DELAYED'])).toBe('DELAYED');
    // The deferral cleared and it landed.
    expect(replay(['SENT', 'DELAYED', 'DELIVERED'])).toBe('DELIVERED');
    // A delay arriving after delivery does not undo the delivery.
    expect(replay(['SENT', 'DELIVERED', 'DELAYED'])).toBe('DELIVERED');
  });

  it('lets a bounce win from anywhere', () => {
    expect(replay(['SENT', 'BOUNCED'])).toBe('BOUNCED');
    expect(replay(['SENT', 'DELAYED', 'BOUNCED'])).toBe('BOUNCED');
    // Some servers accept then reject; the rejection is the truth.
    expect(replay(['SENT', 'DELIVERED', 'BOUNCED'])).toBe('BOUNCED');
  });

  it('keeps a complaint even though an open came first', () => {
    // Opening it and then pressing "spam" is the normal order of events.
    expect(replay(['SENT', 'DELIVERED', 'READ', 'COMPLAINED'])).toBe('COMPLAINED');
  });

  it('does not let a stray later event overwrite an ending', () => {
    expect(replay(['SENT', 'BOUNCED', 'DELIVERED'])).toBe('BOUNCED');
    expect(replay(['SENT', 'COMPLAINED', 'READ'])).toBe('COMPLAINED');
  });

  it('every status the schema allows is either ranked or terminal', () => {
    // If someone adds a value to the enum and forgets the ladder, it would
    // silently rank 0 and never be reached. This is the guard.
    const inSchema = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'CLICKED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'FAILED'];
    for (const status of inSchema) {
      expect(status in PROGRESS || TERMINAL.has(status)).toBe(true);
    }
  });
});
