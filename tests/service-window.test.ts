import { describe, expect, it } from 'vitest';
import {
  SERVICE_WINDOW_HOURS,
  allowedShape,
  minutesLeftInWindow,
  windowExpiresAt,
  windowIsOpen,
} from '../src/messaging/service-window';

/**
 * Meta's 24-hour customer-service window. Getting this wrong is silent in both
 * directions: too strict and a reachable customer is never messaged, too loose
 * and every reply dies at Meta with a 131047 the salon never sees.
 */
describe('the WhatsApp service window', () => {
  const wrote = new Date('2026-09-29T10:00:00Z');

  it('runs 24 hours from the customer’s last message', () => {
    expect(SERVICE_WINDOW_HOURS).toBe(24);
    expect(windowExpiresAt(wrote).toISOString()).toBe('2026-09-30T10:00:00.000Z');
  });

  it('is open right up to the boundary and shut on it', () => {
    expect(windowIsOpen(wrote, new Date('2026-09-30T09:59:00Z'))).toBe(true);
    expect(windowIsOpen(wrote, new Date('2026-09-30T10:00:00Z'))).toBe(false);
  });

  it('is shut for a customer who has never written', () => {
    // The common case: every customer, until the day they reply to something.
    expect(windowIsOpen(null)).toBe(false);
    expect(windowIsOpen(undefined)).toBe(false);
    expect(minutesLeftInWindow(null)).toBe(0);
  });

  it('says which SHAPE is allowed, not whether to message at all', () => {
    // A shut window means "use a template", never "leave them alone" — the
    // misreading that would suppress reminders to reachable customers.
    expect(allowedShape(wrote, new Date('2026-09-29T12:00:00Z'))).toBe('FREE_FORM');
    expect(allowedShape(wrote, new Date('2026-10-02T12:00:00Z'))).toBe('TEMPLATE');
    expect(allowedShape(null)).toBe('TEMPLATE');
  });

  it('counts down and never goes negative', () => {
    expect(minutesLeftInWindow(wrote, new Date('2026-09-29T22:00:00Z'))).toBe(12 * 60);
    expect(minutesLeftInWindow(wrote, new Date('2026-10-05T10:00:00Z'))).toBe(0);
  });
});
