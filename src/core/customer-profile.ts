/**
 * The customer page's sections now live with every other sectioned page in
 * ./page-layouts. This file keeps the older names working.
 */
import type { UserRole } from '@prisma/client';
import { CUSTOMER_PAGE, normaliseLayout as normalise, rolesFor as roles, visibleSections as visible, type Layout } from './page-layouts';

export type ProfileSectionKey =
  | 'details'
  | 'stats'
  | 'visits'
  | 'purchases'
  | 'paidFor'
  | 'loyalty'
  | 'preferences'
  | 'notes'
  | 'photos'
  | 'feedback'
  | 'contact';

export const PROFILE_SECTIONS = CUSTOMER_PAGE.sections;
export const PROFILE_LAYOUT_SETTING = CUSTOMER_PAGE.settingKey;
export type ProfileLayout = Layout;

export const normaliseLayout = (stored: unknown): Layout => normalise(CUSTOMER_PAGE, stored);
export const rolesFor = (section: (typeof PROFILE_SECTIONS)[number], layout: Layout): UserRole[] => roles(section, layout);
export const visibleSections = (role: UserRole, permissions: ReadonlySet<string> | string[], layout: Layout): string[] =>
  visible(CUSTOMER_PAGE, { role, permissions }, layout);
