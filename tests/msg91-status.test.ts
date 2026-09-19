import { describe, expect, it } from 'vitest';
import { parseReport, parseReports } from '../src/modules/webhooks/msg91-status';

/**
 * SMS reports the least of the three channels, which makes the little it does
 * report worth getting exactly right: a failed SMS shown as delivered is a
 * customer the salon believes it reached and did not.
 *
 * The sample payload below is MSG91's own, from their delivery-report docs.
 */

const SAMPLE = {
  pluginsource: '',
  requestedAt: '2026-03-19T16:57:59+05:30',
  status: '1',
  deliveryTime: '2026-03-19T16:58:07+05:30',
  telNum: '919876543210',
  credit: '0.25',
  senderId: 'GLOWST',
  campaignName: 'GLOWST',
  route: '4',
  requestId: '69abcdef0123456789abcdef',
  eventName: 'delivered',
  failureReason: '',
  smsLength: '1',
};

describe('an MSG91 delivery report', () => {
  it('reads their documented payload', () => {
    const report = parseReport(SAMPLE)!;
    expect(report.requestId).toBe('69abcdef0123456789abcdef');
    expect(report.status).toBe('DELIVERED');
    expect(report.reason).toBeNull();
    expect(report.at?.toISOString()).toBe(new Date('2026-03-19T16:58:07+05:30').toISOString());
  });

  it('treats the status as a string, because that is how it arrives', () => {
    // "status": "1", not 1. Comparing as a number would quietly fail every
    // report and leave every SMS stuck at "sent".
    expect(parseReport({ ...SAMPLE, status: '1' })!.status).toBe('DELIVERED');
  });

  it('separates the three outcomes', () => {
    expect(parseReport({ ...SAMPLE, status: '0' })!.status).toBe('SENT');
    expect(parseReport({ ...SAMPLE, status: '1' })!.status).toBe('DELIVERED');
    expect(parseReport({ ...SAMPLE, status: '2' })!.status).toBe('FAILED');
  });

  it('says plainly when a number is on the Do Not Disturb register', () => {
    // Not a network problem — a legal one, and the salon needs to know the
    // difference before it tries again.
    const report = parseReport({ ...SAMPLE, status: '9', failureReason: '' })!;
    expect(report.status).toBe('FAILED');
    expect(report.reason).toMatch(/Do Not Disturb/i);
  });

  it('explains a rejection as the sender-ID problem it usually is', () => {
    expect(parseReport({ ...SAMPLE, status: '16', failureReason: '' })!.reason).toMatch(/sender ID or template/);
    expect(parseReport({ ...SAMPLE, status: '17', failureReason: '' })!.reason).toMatch(/blocked/i);
  });

  it('prefers MSG91’s own wording when they give one', () => {
    const report = parseReport({ ...SAMPLE, status: '2', failureReason: 'Handset switched off' })!;
    expect(report.reason).toBe('Handset switched off');
  });

  it('treats an unknown code as a failure rather than a success', () => {
    // Wrong in the safe direction: a salon chasing a delivery that worked is a
    // smaller problem than one that believes a message arrived when it did not.
    expect(parseReport({ ...SAMPLE, status: '77' })!.status).toBe('FAILED');
  });

  it('ignores a report with no request id, since nothing can be done with it', () => {
    expect(parseReport({ ...SAMPLE, requestId: '' })).toBeNull();
    expect(parseReport({ status: '1' })).toBeNull();
  });

  it('survives a bad timestamp instead of storing an invalid date', () => {
    const report = parseReport({ ...SAMPLE, deliveryTime: 'not a date', requestedAt: '' })!;
    expect(report.at).toBeNull();
  });
});

describe('batching', () => {
  it('accepts one object, as documented', () => {
    expect(parseReports(SAMPLE)).toHaveLength(1);
  });

  it('also accepts an array, so a provider change does not stop every status', () => {
    expect(parseReports([SAMPLE, { ...SAMPLE, requestId: 'b2', status: '2' }])).toHaveLength(2);
  });

  it('drops the unusable rows and keeps the rest', () => {
    const rows = parseReports([SAMPLE, null, 'nonsense', { status: '1' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe(SAMPLE.requestId);
  });
});
