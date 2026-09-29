import { describe, expect, it } from 'vitest';
import { attributeJourney, type AttributableMessage } from '../src/modules/marketing/journey-outcomes';

const sent = (over: Partial<AttributableMessage> = {}): AttributableMessage => ({
  runId: 'run1',
  customerId: 'cust1',
  status: 'DELIVERED',
  queuedAt: new Date('2026-01-01T09:00:00Z'),
  sentAt: new Date('2026-01-01T09:00:00Z'),
  deliveredAt: null,
  readAt: null,
  clickedAt: null,
  repliedAt: null,
  ...over,
});

describe('what an automation actually brought back', () => {
  /**
   * THE MISTAKE THIS FILE EXISTS TO PREVENT.
   *
   * A campaign sends each customer one message, so per-message and per-customer
   * are the same. An automation sends a sequence — confirmation, reminder,
   * thank-you, review request. Attribute per message and one visit is counted
   * four times, and the automation appears to have quadrupled the takings.
   */
  it('counts one visit once, however many messages the sequence sent', () => {
    const out = attributeJourney({
      messages: [
        sent({ sentAt: new Date('2026-01-01T09:00:00Z') }),
        sent({ sentAt: new Date('2026-01-03T09:00:00Z') }),
        sent({ sentAt: new Date('2026-01-05T09:00:00Z') }),
        sent({ sentAt: new Date('2026-01-07T09:00:00Z') }),
      ],
      bookings: [],
      sales: [{ customerId: 'cust1', at: new Date('2026-01-08T10:00:00Z'), amount: 2000 }],
      windowDays: 14,
    });

    expect(out.reached).toBe(1);
    expect(out.visited).toBe(1);
    expect(out.revenue).toBe(2000);
  });

  it('treats two customers as two runs', () => {
    const out = attributeJourney({
      messages: [sent(), sent({ runId: 'run2', customerId: 'cust2' })],
      bookings: [],
      sales: [
        { customerId: 'cust1', at: new Date('2026-01-02T10:00:00Z'), amount: 1000 },
        { customerId: 'cust2', at: new Date('2026-01-02T10:00:00Z'), amount: 500 },
      ],
      windowDays: 14,
    });
    expect(out.reached).toBe(2);
    expect(out.visited).toBe(2);
    expect(out.revenue).toBe(1500);
  });

  it('closes the window after the LAST message, not the first', () => {
    // A sequence spread over a fortnight must not be judged on a window that
    // shut while it was still sending.
    const out = attributeJourney({
      messages: [
        sent({ sentAt: new Date('2026-01-01T09:00:00Z') }),
        sent({ sentAt: new Date('2026-01-20T09:00:00Z') }),
      ],
      bookings: [{ customerId: 'cust1', decidedAt: new Date('2026-01-25T09:00:00Z') }],
      sales: [],
      windowDays: 7,
    });
    expect(out.booked).toBe(1);
  });

  it('ignores a run where nothing was actually sent', () => {
    // No consent, no address, template refused — the customer never heard from
    // us, so their behaviour is not evidence about this automation.
    const out = attributeJourney({
      messages: [sent({ status: 'SKIPPED' }), sent({ runId: 'r2', status: 'FAILED' })],
      bookings: [{ customerId: 'cust1', decidedAt: new Date('2026-01-02T09:00:00Z') }],
      sales: [{ customerId: 'cust1', at: new Date('2026-01-02T09:00:00Z'), amount: 999 }],
      windowDays: 14,
    });
    expect(out).toMatchObject({ reached: 0, booked: 0, visited: 0, revenue: 0 });
  });

  it('counts the sequence as engaged if any one message was', () => {
    const out = attributeJourney({
      messages: [sent(), sent({ readAt: new Date('2026-01-03T10:00:00Z') })],
      bookings: [],
      sales: [],
      windowDays: 14,
    });
    expect(out.engaged).toBe(1);
  });

  it('leaves out what happened outside the window', () => {
    const out = attributeJourney({
      messages: [sent()],
      bookings: [{ customerId: 'cust1', decidedAt: new Date('2026-03-01T09:00:00Z') }],
      sales: [{ customerId: 'cust1', at: new Date('2026-03-01T09:00:00Z'), amount: 5000 }],
      windowDays: 14,
    });
    expect(out).toMatchObject({ reached: 1, booked: 0, visited: 0, revenue: 0 });
  });

  it('survives an empty automation without dividing by anything', () => {
    expect(attributeJourney({ messages: [], bookings: [], sales: [], windowDays: 14 })).toEqual({
      reached: 0,
      engaged: 0,
      booked: 0,
      visited: 0,
      revenue: 0,
    });
  });
});
