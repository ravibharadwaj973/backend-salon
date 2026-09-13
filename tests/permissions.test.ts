import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, resolvePermissions } from '../src/core/permissions';
import { renderTemplate, missingVariables, consentAllows } from '../src/messaging/dispatcher';
import { normalizePhone, toE164, slugify, sequenceNumber } from '../src/core/ids';

describe('permissions', () => {
  it('gives the owner everything', () => {
    const owner = resolvePermissions('OWNER');
    expect(owner.has(PERMISSIONS.TENANT_MANAGE)).toBe(true);
    expect(owner.size).toBe(Object.values(PERMISSIONS).length);
  });

  it('withholds tenant management from an admin', () => {
    expect(resolvePermissions('ADMIN').has(PERMISSIONS.TENANT_MANAGE)).toBe(false);
  });

  it('keeps a receptionist out of the financials', () => {
    const reception = resolvePermissions('RECEPTIONIST');
    expect(reception.has(PERMISSIONS.INVOICE_CREATE)).toBe(true);
    expect(reception.has(PERMISSIONS.REPORT_FINANCIAL)).toBe(false);
    expect(reception.has(PERMISSIONS.INVOICE_VOID)).toBe(false);
    expect(reception.has(PERMISSIONS.PAYROLL_VIEW)).toBe(false);
  });

  it('limits a stylist to their own work', () => {
    const stylist = resolvePermissions('STYLIST');
    expect(stylist.has(PERMISSIONS.APPOINTMENT_VIEW_OWN)).toBe(true);
    expect(stylist.has(PERMISSIONS.APPOINTMENT_VIEW)).toBe(false);
    expect(stylist.has(PERMISSIONS.CUSTOMER_MANAGE)).toBe(false);
  });

  it('applies per-user overrides on top of the role', () => {
    const granted = resolvePermissions('RECEPTIONIST', [{ permission: PERMISSIONS.INVOICE_VOID, allow: true }]);
    expect(granted.has(PERMISSIONS.INVOICE_VOID)).toBe(true);

    const revoked = resolvePermissions('MANAGER', [{ permission: PERMISSIONS.INVOICE_DISCOUNT, allow: false }]);
    expect(revoked.has(PERMISSIONS.INVOICE_DISCOUNT)).toBe(false);
  });

  it('defines a permission set for every role', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions.length, `${role} has no permissions`).toBeGreaterThan(0);
    }
  });
});

describe('messaging', () => {
  it('renders template variables', () => {
    const body = 'Hi {{customer_name}}, your appointment at {{salon_name}} is at {{ appointment_time }}.';
    const rendered = renderTemplate(body, {
      customer_name: 'Priya',
      salon_name: 'Glow Studio',
      appointment_time: '4:30 PM',
    });
    expect(rendered).toBe('Hi Priya, your appointment at Glow Studio is at 4:30 PM.');
  });

  it('reports unresolved variables instead of sending "undefined"', () => {
    const body = 'Hi {{customer_name}}, here is {{offer}}.';
    expect(renderTemplate(body, { customer_name: 'Priya' })).toBe('Hi Priya, here is .');
    expect(missingVariables(body, { customer_name: 'Priya' })).toEqual(['offer']);
  });

  it('requires an opt-in for marketing but not for transactional messages', () => {
    expect(consentAllows('MARKETING', 'OPTED_IN')).toBe(true);
    expect(consentAllows('MARKETING', 'UNKNOWN')).toBe(false);
    expect(consentAllows('MARKETING', 'OPTED_OUT')).toBe(false);

    expect(consentAllows('UTILITY', 'UNKNOWN')).toBe(true);
    expect(consentAllows('UTILITY', 'OPTED_IN')).toBe(true);
    expect(consentAllows('UTILITY', 'OPTED_OUT')).toBe(false);
  });
});

describe('identifiers', () => {
  it('normalises Indian phone numbers to 10 digits', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
    expect(normalizePhone('9876543210')).toBe('9876543210');
    expect(normalizePhone('98765-43210')).toBe('9876543210');
  });

  it('converts to E.164 for providers', () => {
    expect(toE164('9876543210')).toBe('+919876543210');
    expect(toE164('+91 98765 43210')).toBe('+919876543210');
  });

  it('slugifies salon names', () => {
    expect(slugify('Glow Studio Salon & Spa')).toBe('glow-studio-salon-spa');
    expect(slugify('  Naturals   Unisex  ')).toBe('naturals-unisex');
  });

  it('pads sequence numbers', () => {
    expect(sequenceNumber('C', 42, 5)).toBe('C-00042');
    expect(sequenceNumber('PO', 7)).toBe('PO-000007');
  });
});
