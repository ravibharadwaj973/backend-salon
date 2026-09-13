import { describe, expect, it } from 'vitest';
import { CUSTOMER_PAGE, STAFF_PAGE, normaliseLayout, visibleSections } from '../src/core/page-layouts';
import { PERMISSIONS, ROLE_PERMISSIONS, resolvePermissions } from '../src/core/permissions';

const perms = (role: Parameters<typeof resolvePermissions>[0]) => resolvePermissions(role, undefined);

describe('staff page sections', () => {
  it('lets a stylist see their own earnings and hours, but nobody else’s', () => {
    const own = visibleSections(STAFF_PAGE, { role: 'STYLIST', permissions: perms('STYLIST'), self: true }, {});
    expect(own).toEqual(expect.arrayContaining(['earnings', 'pay', 'attendance', 'performance']));

    const someoneElse = visibleSections(STAFF_PAGE, { role: 'STYLIST', permissions: perms('STYLIST'), self: false }, {});
    expect(someoneElse).toEqual([]); // no staff.view at all
  });

  it('keeps salary off a receptionist by default, and lets the owner narrow it to regional managers', () => {
    expect(visibleSections(STAFF_PAGE, { role: 'RECEPTIONIST', permissions: perms('RECEPTIONIST') }, {})).not.toContain('pay');
    expect(visibleSections(STAFF_PAGE, { role: 'ACCOUNTANT', permissions: perms('ACCOUNTANT') }, {})).toContain('pay');

    const layout = normaliseLayout(STAFF_PAGE, { pay: ['REGIONAL_MANAGER'] });
    expect(visibleSections(STAFF_PAGE, { role: 'REGIONAL_MANAGER', permissions: perms('REGIONAL_MANAGER') }, layout)).toContain('pay');
    expect(visibleSections(STAFF_PAGE, { role: 'ACCOUNTANT', permissions: perms('ACCOUNTANT') }, layout)).not.toContain('pay');
  });

  it('cannot widen: ticking salary for stylists does nothing without payroll.view', () => {
    const layout = normaliseLayout(STAFF_PAGE, { pay: ['STYLIST'] });
    expect(visibleSections(STAFF_PAGE, { role: 'STYLIST', permissions: perms('STYLIST') }, layout)).not.toContain('pay');
  });

  it('the owner’s own layout choices never hide anything from the owner', () => {
    const layout = normaliseLayout(CUSTOMER_PAGE, { stats: [], purchases: ['ADMIN'] });
    expect(visibleSections(CUSTOMER_PAGE, { role: 'OWNER', permissions: perms('OWNER') }, layout)).toHaveLength(CUSTOMER_PAGE.sections.length);
  });
});

describe('deleting a bill', () => {
  it('is the owner’s alone until granted by name', () => {
    expect(ROLE_PERMISSIONS.OWNER).toContain(PERMISSIONS.INVOICE_DELETE);
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain(PERMISSIONS.INVOICE_DELETE);
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain(PERMISSIONS.INVOICE_DELETE);
    // …and an override can hand it to one person without changing the role.
    expect(resolvePermissions('ADMIN', [{ permission: PERMISSIONS.INVOICE_DELETE, allow: true }]).has(PERMISSIONS.INVOICE_DELETE)).toBe(true);
  });
});

describe('choosing GST per bill', () => {
  it('is available to the front desk by default, and can be taken away by name', () => {
    expect(ROLE_PERMISSIONS.RECEPTIONIST).toContain(PERMISSIONS.INVOICE_GST_CHOICE);
    expect(ROLE_PERMISSIONS.STYLIST).not.toContain(PERMISSIONS.INVOICE_GST_CHOICE);
    expect(resolvePermissions('RECEPTIONIST', [{ permission: PERMISSIONS.INVOICE_GST_CHOICE, allow: false }]).has(PERMISSIONS.INVOICE_GST_CHOICE)).toBe(false);
  });
});
