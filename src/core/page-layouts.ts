import type { UserRole } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from './permissions';

/**
 * Some pages are made of sections, and which sections a person sees is two
 * questions layered on each other:
 *
 *   1. May they see this data at all?   — the permission (the server's rule)
 *   2. Does the owner want them to?     — the layout (the salon's rule)
 *
 * A stylist has `customer.view`, so the API will hand them a customer's visit
 * history; whether the owner wants the stylist to see lifetime spend at the
 * same time is a business decision, not a security one, and it belongs to the
 * owner. The layout can only narrow what a permission allows, never widen it.
 *
 * The owner always sees everything; the matrix in settings has no OWNER
 * column because turning a section off for yourself is never what you meant.
 *
 * Some sections are also visible to a person looking at *their own* record —
 * a stylist sees their own earnings without holding `commission.view` for the
 * whole team. That is `selfPermission`.
 */

export type PageKey = 'customer' | 'staff';

export interface PageSection {
  key: string;
  label: string;
  description: string;
  /** What the API demands before it will serve this section's data. */
  permission: Permission;
  /** A weaker permission that suffices when the viewer is the subject. */
  selfPermission?: Permission;
  /** Who sees it until the owner says otherwise. */
  defaultRoles: UserRole[];
}

export interface PageDefinition {
  page: PageKey;
  title: string;
  description: string;
  /** The tenant setting the owner's choices live under. */
  settingKey: string;
  sections: PageSection[];
}

export const ALL_ROLES: UserRole[] = ['OWNER', 'ADMIN', 'REGIONAL_MANAGER', 'MANAGER', 'RECEPTIONIST', 'STYLIST', 'ACCOUNTANT'];
const NOT_STYLIST = ALL_ROLES.filter((r) => r !== 'STYLIST');
const MANAGEMENT: UserRole[] = ['OWNER', 'ADMIN', 'REGIONAL_MANAGER', 'MANAGER'];
const MONEY: UserRole[] = [...MANAGEMENT, 'ACCOUNTANT'];

// ------------------------------------------------------------- customer ----

export const CUSTOMER_PAGE: PageDefinition = {
  page: 'customer',
  title: "A customer's page",
  description: 'What each role sees when they open a customer.',
  settingKey: 'customerProfile.sections',
  sections: [
    { key: 'details', label: 'Personal details', description: 'Birthday, anniversary, address, how they found you, who referred them.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'stats', label: 'Money at a glance', description: 'Lifetime spend, average bill, outstanding balance.', permission: PERMISSIONS.INVOICE_VIEW, defaultRoles: NOT_STYLIST },
    // Served by /customers/:id/history, which asks for customer.view — a
    // stylist with only appointment.view_own still gets to see who they are cutting.
    { key: 'visits', label: 'Visit history', description: 'Every appointment: services, stylist, rating, what was billed.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'purchases', label: 'Purchases', description: 'Invoices line by line — services, products, packages, memberships bought.', permission: PERMISSIONS.INVOICE_VIEW, defaultRoles: NOT_STYLIST },
    { key: 'paidFor', label: 'Already paid for', description: 'Active membership and package sessions still to redeem.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'loyalty', label: 'Loyalty & wallet', description: 'Points earned and redeemed, wallet balance.', permission: PERMISSIONS.LOYALTY_VIEW, defaultRoles: NOT_STYLIST },
    { key: 'preferences', label: 'Preferences & hair profile', description: 'Favourite stylist, usual services, colour formula, allergies.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'notes', label: 'Notes', description: 'Free-text notes the team leaves for each other.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'photos', label: 'Photos', description: 'Before / after and reference photos.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'feedback', label: 'Feedback', description: 'Recent ratings and comments.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
    { key: 'contact', label: 'Reachable on', description: 'WhatsApp, SMS and email consent.', permission: PERMISSIONS.CUSTOMER_VIEW, defaultRoles: ALL_ROLES },
  ],
};

// ---------------------------------------------------------------- staff ----

export const STAFF_PAGE: PageDefinition = {
  page: 'staff',
  title: "A staff member's page",
  description: 'What each role sees when they open a team member. Everyone always sees their own page, within what their permissions allow.',
  settingKey: 'staffProfile.sections',
  sections: [
    { key: 'details', label: 'Employment details', description: 'Phone, email, designation, branch, login role, joined.', permission: PERMISSIONS.STAFF_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: ALL_ROLES },
    { key: 'performance', label: 'Performance', description: 'Revenue, services, customers, retention, rating, target.', permission: PERMISSIONS.REPORT_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: MANAGEMENT },
    { key: 'earnings', label: 'Commission', description: 'Commission rate and every commission entry, paid and unpaid.', permission: PERMISSIONS.COMMISSION_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: MONEY },
    { key: 'pay', label: 'Salary & payslips', description: 'Base salary and payroll history.', permission: PERMISSIONS.PAYROLL_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: MONEY },
    { key: 'attendance', label: 'Attendance', description: 'Days present, hours worked, recent punches.', permission: PERMISSIONS.ATTENDANCE_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: [...MANAGEMENT, 'RECEPTIONIST'] },
    { key: 'leave', label: 'Leave', description: 'Leave requests and their status.', permission: PERMISSIONS.ATTENDANCE_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: [...MANAGEMENT, 'RECEPTIONIST'] },
    { key: 'schedule', label: 'Weekly schedule', description: 'Working hours by day and time off.', permission: PERMISSIONS.STAFF_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: ALL_ROLES },
    { key: 'services', label: 'Services offered', description: 'What this person can be booked for.', permission: PERMISSIONS.STAFF_VIEW, selfPermission: PERMISSIONS.STAFF_SELF, defaultRoles: ALL_ROLES },
  ],
};

export const PAGES: Record<PageKey, PageDefinition> = { customer: CUSTOMER_PAGE, staff: STAFF_PAGE };

export type Layout = Record<string, UserRole[]>;

const ROLE_SET = new Set<string>(ALL_ROLES);

/** Whatever is stored, reduced to known sections and known roles, with OWNER always present. */
export function normaliseLayout(def: PageDefinition, stored: unknown): Layout {
  const known = new Set(def.sections.map((s) => s.key));
  const layout: Layout = {};
  if (!stored || typeof stored !== 'object') return layout;
  for (const [key, roles] of Object.entries(stored as Record<string, unknown>)) {
    if (!known.has(key) || !Array.isArray(roles)) continue;
    const clean = roles.filter((r): r is UserRole => typeof r === 'string' && ROLE_SET.has(r));
    if (!clean.includes('OWNER')) clean.push('OWNER');
    layout[key] = clean;
  }
  return layout;
}

/** Roles that see a section: the owner's choice if made, otherwise the default. */
export function rolesFor(section: PageSection, layout: Layout): UserRole[] {
  return layout[section.key] ?? section.defaultRoles;
}

/** Roles whose permissions include the section at all — the matrix locks the rest. */
export function eligibleRoles(section: PageSection): UserRole[] {
  return ALL_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(section.permission));
}

export interface Viewer {
  role: UserRole;
  permissions: ReadonlySet<string> | string[];
  /** The viewer is looking at their own record. */
  self?: boolean;
}

/**
 * The sections this person gets, given both rules. Permission is checked
 * first so nobody is handed a section the API would refuse to fill.
 */
export function visibleSections(def: PageDefinition, viewer: Viewer, layout: Layout): string[] {
  const perms = viewer.permissions instanceof Set ? viewer.permissions : new Set(viewer.permissions);
  return def.sections
    .filter((section) => {
      const permitted =
        perms.has(section.permission) || (viewer.self === true && section.selfPermission !== undefined && perms.has(section.selfPermission));
      if (!permitted) return false;
      if (viewer.role === 'OWNER' || viewer.self) return true;
      return rolesFor(section, layout).includes(viewer.role);
    })
    .map((section) => section.key);
}

/** The shape the settings matrix and the pages read. */
export function describeLayout(def: PageDefinition, viewer: Viewer, layout: Layout, canManage: boolean) {
  const visible = new Set(visibleSections(def, viewer, layout));
  return {
    page: def.page,
    title: def.title,
    description: def.description,
    canManage,
    sections: def.sections.map((section) => ({
      key: section.key,
      label: section.label,
      description: section.description,
      permission: section.permission,
      roles: rolesFor(section, layout),
      eligibleRoles: eligibleRoles(section),
      isDefault: layout[section.key] === undefined,
      visible: visible.has(section.key),
    })),
  };
}
