import type { UserRole } from '@prisma/client';

/**
 * Permissions are `<module>.<action>` strings. Roles map to sets of them, and a
 * user can be granted or denied individual permissions on top of their role
 * (PermissionOverride).
 */
export const PERMISSIONS = {
  // org
  BRANCH_VIEW: 'branch.view',
  BRANCH_MANAGE: 'branch.manage',
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  TENANT_MANAGE: 'tenant.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',

  // crm
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_MANAGE: 'customer.manage',
  CUSTOMER_EXPORT: 'customer.export',
  CUSTOMER_IMPORT: 'customer.import',

  // catalog
  SERVICE_VIEW: 'service.view',
  SERVICE_MANAGE: 'service.manage',

  // staff
  STAFF_VIEW: 'staff.view',
  STAFF_MANAGE: 'staff.manage',
  STAFF_SELF: 'staff.self',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MANAGE: 'attendance.manage',
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_MANAGE: 'payroll.manage',
  COMMISSION_VIEW: 'commission.view',
  COMMISSION_MANAGE: 'commission.manage',

  // appointments
  APPOINTMENT_VIEW: 'appointment.view',
  APPOINTMENT_VIEW_OWN: 'appointment.view_own',
  APPOINTMENT_MANAGE: 'appointment.manage',
  APPOINTMENT_CANCEL: 'appointment.cancel',

  // billing
  INVOICE_VIEW: 'invoice.view',
  INVOICE_CREATE: 'invoice.create',
  INVOICE_VOID: 'invoice.void',
  /** Remove a voided bill from the books. Owner only until granted. */
  INVOICE_DELETE: 'invoice.delete',
  INVOICE_DISCOUNT: 'invoice.discount',
  /** Choose, bill by bill, whether GST is charged — the salon default applies otherwise. */
  INVOICE_GST_CHOICE: 'invoice.gst_choice',
  PAYMENT_MANAGE: 'payment.manage',
  REFUND_MANAGE: 'refund.manage',
  COUPON_MANAGE: 'coupon.manage',

  // packages, memberships, loyalty
  PACKAGE_VIEW: 'package.view',
  PACKAGE_MANAGE: 'package.manage',
  MEMBERSHIP_VIEW: 'membership.view',
  MEMBERSHIP_MANAGE: 'membership.manage',
  LOYALTY_VIEW: 'loyalty.view',
  LOYALTY_MANAGE: 'loyalty.manage',

  // inventory
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  PURCHASE_MANAGE: 'purchase.manage',
  SUPPLIER_MANAGE: 'supplier.manage',

  // money
  EXPENSE_VIEW: 'expense.view',
  EXPENSE_MANAGE: 'expense.manage',

  // growth
  LEAD_VIEW: 'lead.view',
  LEAD_MANAGE: 'lead.manage',
  CAMPAIGN_VIEW: 'campaign.view',
  CAMPAIGN_MANAGE: 'campaign.manage',
  SEGMENT_MANAGE: 'segment.manage',
  TEMPLATE_MANAGE: 'template.manage',
  JOURNEY_MANAGE: 'journey.manage',
  MESSAGE_SEND: 'message.send',
  FEEDBACK_VIEW: 'feedback.view',
  FEEDBACK_MANAGE: 'feedback.manage',
  GAMIFICATION_MANAGE: 'gamification.manage',

  // intelligence
  REPORT_VIEW: 'report.view',
  REPORT_FINANCIAL: 'report.financial',
  DASHBOARD_VIEW: 'dashboard.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL: Permission[] = Object.values(PERMISSIONS);

const RECEPTIONIST: Permission[] = [
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.INVOICE_GST_CHOICE,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.CUSTOMER_MANAGE,
  PERMISSIONS.SERVICE_VIEW,
  PERMISSIONS.STAFF_VIEW,
  PERMISSIONS.APPOINTMENT_VIEW,
  PERMISSIONS.APPOINTMENT_MANAGE,
  PERMISSIONS.APPOINTMENT_CANCEL,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.INVOICE_CREATE,
  PERMISSIONS.PAYMENT_MANAGE,
  PERMISSIONS.PACKAGE_VIEW,
  PERMISSIONS.PACKAGE_MANAGE,
  PERMISSIONS.MEMBERSHIP_VIEW,
  PERMISSIONS.MEMBERSHIP_MANAGE,
  PERMISSIONS.LOYALTY_VIEW,
  PERMISSIONS.LEAD_VIEW,
  PERMISSIONS.LEAD_MANAGE,
  PERMISSIONS.FEEDBACK_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.MESSAGE_SEND,
  PERMISSIONS.DASHBOARD_VIEW,
];

const STYLIST: Permission[] = [
  PERMISSIONS.STAFF_SELF,
  PERMISSIONS.APPOINTMENT_VIEW_OWN,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.SERVICE_VIEW,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.FEEDBACK_VIEW,
];

const ACCOUNTANT: Permission[] = [
  PERMISSIONS.BRANCH_VIEW,
  PERMISSIONS.CUSTOMER_VIEW,
  PERMISSIONS.SERVICE_VIEW,
  PERMISSIONS.STAFF_VIEW,
  PERMISSIONS.INVOICE_VIEW,
  PERMISSIONS.PAYMENT_MANAGE,
  PERMISSIONS.REFUND_MANAGE,
  PERMISSIONS.EXPENSE_VIEW,
  PERMISSIONS.EXPENSE_MANAGE,
  PERMISSIONS.COMMISSION_VIEW,
  PERMISSIONS.PAYROLL_VIEW,
  PERMISSIONS.PAYROLL_MANAGE,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.PURCHASE_MANAGE,
  PERMISSIONS.SUPPLIER_MANAGE,
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.REPORT_FINANCIAL,
  PERMISSIONS.DASHBOARD_VIEW,
];

const MANAGER: Permission[] = [
  ...RECEPTIONIST,
  PERMISSIONS.SERVICE_MANAGE,
  PERMISSIONS.STAFF_MANAGE,
  PERMISSIONS.ATTENDANCE_VIEW,
  PERMISSIONS.ATTENDANCE_MANAGE,
  PERMISSIONS.COMMISSION_VIEW,
  PERMISSIONS.INVOICE_DISCOUNT,
  PERMISSIONS.INVOICE_VOID,
  PERMISSIONS.REFUND_MANAGE,
  PERMISSIONS.COUPON_MANAGE,
  PERMISSIONS.INVENTORY_MANAGE,
  PERMISSIONS.PURCHASE_MANAGE,
  PERMISSIONS.SUPPLIER_MANAGE,
  PERMISSIONS.EXPENSE_VIEW,
  PERMISSIONS.EXPENSE_MANAGE,
  PERMISSIONS.CAMPAIGN_VIEW,
  PERMISSIONS.CAMPAIGN_MANAGE,
  PERMISSIONS.SEGMENT_MANAGE,
  PERMISSIONS.FEEDBACK_MANAGE,
  PERMISSIONS.LOYALTY_MANAGE,
  PERMISSIONS.CUSTOMER_IMPORT,
  PERMISSIONS.CUSTOMER_EXPORT,
  PERMISSIONS.REPORT_VIEW,
  PERMISSIONS.USER_VIEW,
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: ALL,
  // Deleting a bill is the owner's call alone until they hand it to someone by name.
  ADMIN: ALL.filter((p) => p !== PERMISSIONS.TENANT_MANAGE && p !== PERMISSIONS.INVOICE_DELETE),
  REGIONAL_MANAGER: [...MANAGER, PERMISSIONS.REPORT_FINANCIAL, PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.BRANCH_VIEW],
  MANAGER,
  RECEPTIONIST,
  STYLIST,
  ACCOUNTANT,
};

export function permissionsForRole(role: UserRole): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

export function resolvePermissions(
  role: UserRole,
  overrides: { permission: string; allow: boolean }[] = [],
): Set<string> {
  const set = new Set<string>(permissionsForRole(role));
  for (const o of overrides) {
    if (o.allow) set.add(o.permission);
    else set.delete(o.permission);
  }
  return set;
}

/** Roles that may see every branch in the tenant without explicit assignment. */
export const ALL_BRANCH_ROLES: UserRole[] = ['OWNER', 'ADMIN'];
