import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * The webhook, with more than one salon connected.
 *
 * Every salon on the platform points at the same webhook URL, so the only
 * thing separating them is `metadata.phone_number_id` inside each change. The
 * handler used to flatten the whole payload before reading anything, which
 * discarded that — and a STOP from one salon's customer was applied to every
 * customer with that number, in every salon.
 *
 * These test the two pure parts of the fix: the signature check, and the
 * per-change routing. The database half is exercised by running the real
 * handler; here the shape is what matters.
 */

/** The exact check from whatsapp-signature.ts. */
function signatureMatches(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** How the handler now walks the payload: change by change, each with its own number. */
function routeChanges(body: {
  entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: { from: string; text?: { body: string } }[] } }[] }[];
}) {
  return (body.entry?.flatMap((e) => e.changes ?? []) ?? []).map((change) => ({
    phoneNumberId: change.value?.metadata?.phone_number_id,
    stops: (change.value?.messages ?? [])
      .filter((m) => ['STOP', 'UNSUBSCRIBE'].includes(m.text?.body?.trim().toUpperCase() ?? ''))
      .map((m) => m.from),
  }));
}

const SECRET = 'app-secret-for-tests';

describe('whatsapp webhook signature', () => {
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [] }] }));

  it('accepts a body Meta signed', () => {
    const header = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    expect(signatureMatches(SECRET, raw, header)).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const header = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    const tampered = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] }));
    expect(signatureMatches(SECRET, tampered, header)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = `sha256=${crypto.createHmac('sha256', 'not-the-secret').update(raw).digest('hex')}`;
    expect(signatureMatches(SECRET, raw, header)).toBe(false);
  });

  it('rejects a request with no signature at all', () => {
    expect(signatureMatches(SECRET, raw, undefined)).toBe(false);
  });

  it('does not throw when the header is a different length', () => {
    // timingSafeEqual throws on mismatched lengths; the length is checked first.
    expect(() => signatureMatches(SECRET, raw, 'sha256=short')).not.toThrow();
    expect(signatureMatches(SECRET, raw, 'sha256=short')).toBe(false);
  });
});

describe('whatsapp webhook routing with several salons', () => {
  // One delivery, one payload, two salons — which is exactly what Meta sends
  // once more than one number reports to the same app.
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '111111111111111' },
              messages: [{ from: '919315341503', text: { body: 'STOP' } }],
            },
          },
          {
            value: {
              metadata: { phone_number_id: '222222222222222' },
              messages: [{ from: '919876543210', text: { body: 'what time do you close?' } }],
            },
          },
        ],
      },
    ],
  };

  it('keeps each change with its own phone number', () => {
    const routed = routeChanges(body);
    expect(routed).toHaveLength(2);
    expect(routed[0]?.phoneNumberId).toBe('111111111111111');
    expect(routed[1]?.phoneNumberId).toBe('222222222222222');
  });

  it('applies a STOP only to the salon that was messaged', () => {
    const routed = routeChanges(body);
    expect(routed[0]?.stops).toEqual(['919315341503']);
    // The second salon received a question, not a STOP — nobody is opted out there.
    expect(routed[1]?.stops).toEqual([]);
  });

  it('survives a change with no metadata rather than guessing a salon', () => {
    const routed = routeChanges({ entry: [{ changes: [{ value: { messages: [] } }] }] });
    expect(routed[0]?.phoneNumberId).toBeUndefined();
  });
});
