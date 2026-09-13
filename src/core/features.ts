/**
 * Plan feature switches.
 *
 * A feature is a capability a plan either includes or does not. Keep these
 * coarse — one switch per thing a salon owner would recognise on a pricing page,
 * not one per endpoint. Permissions decide what a *user* may do inside a salon;
 * features decide what the *salon* has bought. Both are checked: an owner on
 * Starter has the `campaigns.manage` permission and still cannot open campaigns,
 * because their salon has no campaigns feature.
 */
export const FEATURES = {
  /**
   * The master switch for promotional messaging: campaigns, offers, win-backs,
   * birthday wishes, WhatsApp marketing templates — anything sent to drum up
   * business rather than to service a booking the customer already made.
   *
   * Off on Starter. That plan is the salon's diary and till: appointment
   * confirmations, reminders, bills and the feedback ask all still go out,
   * because those are UTILITY messages the customer asked for by booking.
   * Nothing MARKETING leaves the building, on any channel, whatever the
   * allowance says — the check sits above metering, so buying credits or
   * running into overdraft cannot get around it.
   */
  MARKETING: 'marketing',

  // --- Everyone, including the pilot ---
  /// The ready-written template library.
  PREBUILT_CAMPAIGNS: 'prebuiltCampaigns',
  /// Campaigns the salon writes itself. Capped per month on Starter.
  CUSTOM_CAMPAIGNS: 'customCampaigns',
  /// Journeys that fire on their own. "Basic" is this switch on its own.
  AUTOMATION: 'automation',
  /// Sends, opens and bookings per campaign.
  CAMPAIGN_ANALYTICS: 'campaignAnalytics',

  // --- Growth ---
  /// Rule-built segments rather than the handful of standard lists.
  SEGMENTS_ADVANCED: 'segmentsAdvanced',
  /// Multi-step journeys, branching and exit conditions.
  AUTOMATION_ADVANCED: 'automationAdvanced',
  /// Hair-colour formulas, allergies, before/after photos, full timeline.
  CRM_ADVANCED: 'crmAdvanced',
  /// Likewise: everyone sees a staff list and today's bookings. This adds
  /// utilisation, retention and rebooking rates per stylist.
  STAFF_ANALYTICS_ADVANCED: 'staffAnalyticsAdvanced',
  LEADS: 'leads',
  CAMPAIGNS: 'campaigns',
  JOURNEYS: 'journeys',
  SEGMENTS: 'segments',
  LOYALTY: 'loyalty',
  PACKAGES: 'packages',
  MEMBERSHIPS: 'memberships',
  CUSTOMER_PORTAL: 'customerPortal',
  ADVANCED_REPORTS: 'advancedReports',

  // --- Business ---
  MULTI_BRANCH: 'multiBranch',
  INVENTORY: 'inventory',
  SUPPLIERS: 'suppliers',
  EXPENSES: 'expenses',
  COMMISSIONS: 'commissions',
  UNIT_ECONOMICS: 'unitEconomics',
  MARKETING_ROI: 'marketingRoi',
  CAMPAIGN_ANALYTICS_ADVANCED: 'campaignAnalyticsAdvanced',
  CUSTOM_ROLES: 'customRoles',
  PRIORITY_SUPPORT: 'prioritySupport',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * "Unlimited" on the pricing page is a fair-use figure, not the absence of a
 * limit — an unbounded row count is a promise you cannot keep on shared
 * infrastructure. A plan at or above this number is *shown* as unlimited while
 * still being technically bounded, which is what the terms should say too.
 */
export const FAIR_USE_UNLIMITED = 1_000_000;

export const isUnlimited = (limit: number): boolean => limit >= FAIR_USE_UNLIMITED;

/** Format a plan limit for display: 5,000 or "Unlimited". */
export function limitLabel(limit: number): string {
  return isUnlimited(limit) ? 'Unlimited' : limit.toLocaleString('en-IN');
}

export const ALL_FEATURES: readonly FeatureKey[] = Object.values(FEATURES);

/** Human labels, used by the platform console when editing a plan. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  marketing: 'Marketing messages',
  prebuiltCampaigns: 'Pre-built campaigns',
  customCampaigns: 'Custom campaigns',
  automation: 'Automation',
  campaignAnalytics: 'Campaign analytics',
  segmentsAdvanced: 'Advanced segmentation',
  automationAdvanced: 'Advanced automation',
  campaignAnalyticsAdvanced: 'Advanced campaign analytics',
  crmAdvanced: 'Advanced CRM',
  staffAnalyticsAdvanced: 'Advanced staff analytics',
  leads: 'Lead management',
  campaigns: 'Marketing campaigns',
  journeys: 'Automated journeys',
  segments: 'Customer segmentation',
  loyalty: 'Loyalty points',
  packages: 'Service packages',
  memberships: 'Memberships',
  customerPortal: 'Customer portal',
  advancedReports: 'Advanced reports',
  multiBranch: 'Multiple branches',
  inventory: 'Inventory',
  suppliers: 'Supplier management',
  expenses: 'Expenses',
  commissions: 'Staff commissions',
  unitEconomics: 'Unit economics',
  marketingRoi: 'Marketing ROI',
  customRoles: 'Role-based permissions',
  prioritySupport: 'Priority support',
};

/**
 * The 14-day pilot. Deliberately close to Starter in *capability* and far from
 * it in *volume*: a salon should experience the whole product, not a crippled
 * version of it, and then run out of messages rather than out of features. That
 * is what makes the upgrade conversation about their own usage.
 */
export const PILOT_FEATURES: readonly FeatureKey[] = [
  FEATURES.MARKETING,
  FEATURES.PREBUILT_CAMPAIGNS,
  FEATURES.CUSTOM_CAMPAIGNS,
  FEATURES.AUTOMATION,
  FEATURES.CAMPAIGN_ANALYTICS,
  FEATURES.SEGMENTS,
  FEATURES.CAMPAIGNS,
  FEATURES.JOURNEYS,
];

/**
 * Starter runs the salon; it does not market for it.
 *
 * Automation stays on, because what it carries here is the service messages a
 * booking implies — the confirmation, the reminder, the bill, the "how was
 * it?". What it does not carry is an offer. A salon that wants to send offers
 * is on Grow.
 */
export const STARTER_FEATURES: readonly FeatureKey[] = [
  FEATURES.AUTOMATION,
];

export const GROWTH_FEATURES: readonly FeatureKey[] = [
  ...STARTER_FEATURES,
  FEATURES.MARKETING,
  FEATURES.PREBUILT_CAMPAIGNS,
  FEATURES.CUSTOM_CAMPAIGNS,
  FEATURES.CAMPAIGN_ANALYTICS,
  FEATURES.SEGMENTS_ADVANCED,
  FEATURES.AUTOMATION_ADVANCED,
  FEATURES.CRM_ADVANCED,
  FEATURES.STAFF_ANALYTICS_ADVANCED,
  FEATURES.LEADS,
  FEATURES.CAMPAIGNS,
  FEATURES.JOURNEYS,
  FEATURES.SEGMENTS,
  FEATURES.LOYALTY,
  FEATURES.PACKAGES,
  FEATURES.MEMBERSHIPS,
  FEATURES.CUSTOMER_PORTAL,
  FEATURES.ADVANCED_REPORTS,
];

/** The top tier, sold as Pro. */
export const PRO_FEATURES: readonly FeatureKey[] = [
  ...GROWTH_FEATURES,
  FEATURES.CAMPAIGN_ANALYTICS_ADVANCED,
  FEATURES.MULTI_BRANCH,
  FEATURES.INVENTORY,
  FEATURES.SUPPLIERS,
  FEATURES.EXPENSES,
  FEATURES.COMMISSIONS,
  FEATURES.UNIT_ECONOMICS,
  FEATURES.MARKETING_ROI,
  FEATURES.CUSTOM_ROLES,
  FEATURES.PRIORITY_SUPPORT,
];

/** Kept as an alias so older imports keep working. */
export const BUSINESS_FEATURES = PRO_FEATURES;

/** Turn a feature list into the JSON shape stored on Plan.features. */
export function featureMap(keys: readonly FeatureKey[]): Record<string, boolean> {
  return Object.fromEntries(ALL_FEATURES.map((key) => [key, keys.includes(key)]));
}

/** Read one switch out of a plan's stored JSON. Absent means off. */
export function hasFeature(features: unknown, key: FeatureKey): boolean {
  if (!features || typeof features !== 'object') return false;
  return (features as Record<string, unknown>)[key] === true;
}

export function enabledFeatures(features: unknown): FeatureKey[] {
  return ALL_FEATURES.filter((key) => hasFeature(features, key));
}
