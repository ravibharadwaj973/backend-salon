import { describe, expect, it } from 'vitest';
import { PROFILE_SECTIONS, normaliseLayout, visibleSections } from '../src/core/customer-profile';
import { resolvePermissions } from '../src/core/permissions';

const perms = (role: Parameters<typeof resolvePermissions>[0]) => resolvePermissions(role, undefined);

describe('customer profile sections', () => {
  it('shows the owner everything, whatever the layout says', () => {
    const layout = normaliseLayout({ stats: ['ADMIN'], purchases: [] });
    const keys = visibleSections('OWNER', perms('OWNER'), layout);
    expect(keys).toEqual(PROFILE_SECTIONS.map((s) => s.key));
  });

  it('keeps money sections off a stylist by default, without hiding their visit history', () => {
    const keys = visibleSections('STYLIST', perms('STYLIST'), {});
    expect(keys).not.toContain('stats');
    expect(keys).not.toContain('purchases');
    expect(keys).toContain('visits');
    expect(keys).toContain('preferences');
  });

  it('lets the owner narrow but never widen what a permission allows', () => {
    // Owner tries to show purchases to stylists — the API would refuse the data, so it stays hidden.
    const widened = visibleSections('STYLIST', perms('STYLIST'), normaliseLayout({ purchases: ['STYLIST'] }));
    expect(widened).not.toContain('purchases');

    // Owner hides visit history from receptionists — that is theirs to decide.
    const narrowed = visibleSections('RECEPTIONIST', perms('RECEPTIONIST'), normaliseLayout({ visits: ['MANAGER'] }));
    expect(narrowed).not.toContain('visits');
  });

  it('ignores unknown sections and roles, and always keeps the owner in', () => {
    const layout = normaliseLayout({ visits: ['STYLIST', 'JANITOR'], bogus: ['OWNER'] });
    expect(layout).toEqual({ visits: ['STYLIST', 'OWNER'] });
  });
});
