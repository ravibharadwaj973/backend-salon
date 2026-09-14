import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { assertWritable, isWrite } from '../src/middleware/read-only';
import { readOnlyState } from '../src/modules/auth/auth.service';
import { REMINDER_DAYS, renewalMessage } from '../src/modules/tenants/renewal.service';

const request = (method: string, url: string, readOnly: boolean): Request =>
  ({
    method,
    originalUrl: url,
    auth: readOnly
      ? { readOnly: true, readOnlyReason: 'This salon account is switched off.' }
      : { readOnly: false, readOnlyReason: null },
  }) as unknown as Request;

describe('a switched-off salon can look but not touch', () => {
  it('lets every read through', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isWrite(method), method).toBe(false);
      expect(() => assertWritable(request(method, '/api/v1/customers', true))).not.toThrow();
    }
  });

  it('refuses the writes that would be new work', () => {
    for (const [method, url] of [
      ['POST', '/api/v1/invoices'],
      ['POST', '/api/v1/appointments'],
      ['POST', '/api/v1/messages/send'],
      ['PATCH', '/api/v1/customers/c1'],
      ['PUT', '/api/v1/staff/s1/services'],
      ['DELETE', '/api/v1/services/s1'],
    ]) {
      expect(() => assertWritable(request(method!, url!, true)), `${method} ${url}`).toThrow();
    }
  });

  it('still lets them sign out and change their own password', () => {
    // Being switched off is exactly when someone finds they have lost their
    // login. Refusing these would strand them with no way back in.
    for (const url of [
      '/api/v1/auth/logout',
      '/api/v1/auth/logout-all',
      '/api/v1/auth/refresh',
      '/api/v1/auth/change-password',
    ]) {
      expect(() => assertWritable(request('POST', url, true)), url).not.toThrow();
    }
  });

  it('is not triggered by a query string on an allowed path', () => {
    expect(() => assertWritable(request('POST', '/api/v1/auth/logout?all=true', true))).not.toThrow();
  });

  it('leaves a normal salon alone', () => {
    expect(() => assertWritable(request('POST', '/api/v1/invoices', false))).not.toThrow();
  });
});

describe('which statuses switch a salon off', () => {
  it('suspended and cancelled are read-only, and say why', () => {
    for (const status of ['SUSPENDED', 'CANCELLED']) {
      const state = readOnlyState(status);
      expect(state.readOnly, status).toBe(true);
      expect(state.readOnlyReason, status).toBeTruthy();
      // The message has to tell them their records are still there, or the
      // first thing they do is panic about having lost the customer book.
      expect(state.readOnlyReason!.toLowerCase(), status).toContain('read');
    }
  });

  it('a salon merely behind on payment keeps working', () => {
    // PAST_DUE is a grace state, not a punishment. Switching off is a decision
    // someone makes; it is never a side effect of a date passing.
    for (const status of ['TRIAL', 'ACTIVE', 'PAST_DUE']) {
      expect(readOnlyState(status).readOnly, status).toBe(false);
    }
  });
});

describe('renewal reminders', () => {
  it('warns well ahead, including the three-day mark', () => {
    expect(REMINDER_DAYS).toContain(3);
    expect(REMINDER_DAYS).toContain(1);
    expect(REMINDER_DAYS).toContain(0);
  });

  it('reads as a heads-up, not a threat', () => {
    const soon = renewalMessage('Glow Studio', 'Grow', 3);
    expect(soon.subject).toContain('in 3 days');
    expect(soon.body).toContain('Nothing changes today');

    const tomorrow = renewalMessage('Glow Studio', 'Grow', 1);
    expect(tomorrow.subject).toContain('tomorrow');

    // Even on the day it lapses, nothing has been switched off — because
    // nothing here switches anything off.
    const lapsed = renewalMessage('Glow Studio', 'Grow', 0);
    expect(lapsed.body).toContain('Nothing has been switched off');
  });

  it('never threatens losing their data', () => {
    for (const days of REMINDER_DAYS) {
      const { body } = renewalMessage('Glow Studio', 'Grow', days);
      expect(body.toLowerCase(), String(days)).not.toContain('delete');
    }
  });
});
