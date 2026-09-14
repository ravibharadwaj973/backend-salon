/**
 * WHAT A SALON CAN SEGMENT ON.
 *
 * One catalogue, read by both sides: the API validates against it, and the
 * builder renders its inputs from it. Adding a field here is what makes it
 * appear in the UI with the right control — a service picker rather than a box
 * asking the owner to type a service id, which is what it used to do.
 *
 * Fields are grouped the way an owner thinks about their customers, not the way
 * the database is laid out: who they are, how often they come, what they spend,
 * what they buy, how they feel, and whether we can actually reach them.
 */

export type FieldInput =
  | 'number'
  | 'money'
  | 'days'
  | 'month'
  | 'boolean'
  | 'tier'
  | 'gender'
  | 'source'
  | 'channel'
  | 'service'
  | 'category'
  | 'staff'
  | 'branch'
  | 'tag'
  | 'text';

export interface FieldDefinition {
  key: string;
  label: string;
  group: string;
  input: FieldInput;
  ops: string[];
  /** Shown under the control. Says what the field means in salon terms. */
  help?: string;
  placeholder?: string;
  /** Applied in memory after the query — the UI warns that it costs a pass. */
  postFilter?: boolean;
}

export const SEGMENT_FIELDS: readonly FieldDefinition[] = [
  // ------------------------------------------------------------ who ------
  { key: 'tier', label: 'Tier', group: 'Who they are', input: 'tier', ops: ['eq', 'in', 'nin'] },
  { key: 'gender', label: 'Gender', group: 'Who they are', input: 'gender', ops: ['eq', 'in'] },
  { key: 'source', label: 'How they found you', group: 'Who they are', input: 'source', ops: ['eq', 'in'] },
  { key: 'tag', label: 'Has tag', group: 'Who they are', input: 'tag', ops: ['has', 'nin'], placeholder: 'bridal' },
  { key: 'city', label: 'City', group: 'Who they are', input: 'text', ops: ['eq', 'contains'] },
  { key: 'branchId', label: 'Registered at branch', group: 'Who they are', input: 'branch', ops: ['eq'] },
  {
    key: 'visitedBranch',
    label: 'Has been billed at branch',
    group: 'Who they are',
    input: 'branch',
    ops: ['eq'],
    help: 'Where they actually go, which is not always where they signed up.',
  },
  {
    key: 'newWithinDays',
    label: 'Joined in the last (days)',
    group: 'Who they are',
    input: 'days',
    ops: ['lte'],
    placeholder: '30',
    help: 'Your newest customers — the ones a welcome offer is for.',
  },

  // ------------------------------------------------------- how often -----
  {
    key: 'noVisitDays',
    label: 'Days since last visit',
    group: 'How often they come',
    input: 'days',
    ops: ['gte', 'lte'],
    placeholder: '45',
    help: 'Counts from the day they joined if they have never been in.',
  },
  { key: 'visitedWithinDays', label: 'Visited in the last (days)', group: 'How often they come', input: 'days', ops: ['lte'], placeholder: '30' },
  {
    key: 'notBilledInLastDays',
    label: 'No bill in the last (days)',
    group: 'How often they come',
    input: 'days',
    ops: ['gte'],
    placeholder: '90',
    help: 'Stronger than "last visit" — they may have booked and not turned up.',
  },
  { key: 'totalVisits', label: 'Total visits', group: 'How often they come', input: 'number', ops: ['gte', 'lte', 'eq'], placeholder: '2' },
  {
    key: 'onlyOneVisit',
    label: 'Came exactly once',
    group: 'How often they come',
    input: 'boolean',
    ops: ['eq'],
    help: 'The single biggest thing worth fixing in most salons: they tried you and never came back.',
  },
  {
    key: 'neverVisited',
    label: 'Never visited',
    group: 'How often they come',
    input: 'boolean',
    ops: ['eq'],
    help: 'On the book but never in the chair — usually an import or an abandoned booking.',
  },

  // ---------------------------------------------------- what they spend --
  { key: 'totalSpent', label: 'Lifetime spend', group: 'What they spend', input: 'money', ops: ['gte', 'lte'], placeholder: '10000' },
  { key: 'avgBill', label: 'Average bill', group: 'What they spend', input: 'money', ops: ['gte', 'lte'], placeholder: '1500' },
  { key: 'loyaltyPoints', label: 'Loyalty points', group: 'What they spend', input: 'number', ops: ['gte', 'lte'], placeholder: '500' },
  { key: 'walletBalance', label: 'Wallet balance', group: 'What they spend', input: 'money', ops: ['gte', 'lte'] },
  { key: 'hasOutstanding', label: 'Has an unpaid bill', group: 'What they spend', input: 'boolean', ops: ['eq'] },

  // ----------------------------------------------------- what they buy ---
  { key: 'usedService', label: 'Has had service', group: 'What they buy', input: 'service', ops: ['eq'] },
  {
    key: 'notUsedService',
    label: 'Has never had service',
    group: 'What they buy',
    input: 'service',
    ops: ['eq'],
    help: 'The cross-sell list: everyone who has not tried this yet.',
  },
  { key: 'usedCategory', label: 'Has had anything in category', group: 'What they buy', input: 'category', ops: ['eq'] },
  {
    key: 'notUsedCategory',
    label: 'Has never had anything in category',
    group: 'What they buy',
    input: 'category',
    ops: ['eq'],
    help: 'For example: colour customers who have never booked a spa.',
  },
  { key: 'seenStaff', label: 'Has been served by', group: 'What they buy', input: 'staff', ops: ['eq'] },
  { key: 'preferredStaffId', label: 'Asks for', group: 'What they buy', input: 'staff', ops: ['eq'] },
  { key: 'hasMembership', label: 'Has a membership', group: 'What they buy', input: 'boolean', ops: ['eq'] },
  { key: 'membershipExpiringInDays', label: 'Membership ends within (days)', group: 'What they buy', input: 'days', ops: ['lte'], placeholder: '30' },
  { key: 'hasActivePackage', label: 'Has an active package', group: 'What they buy', input: 'boolean', ops: ['eq'] },
  { key: 'packageExpiringInDays', label: 'Package ends within (days)', group: 'What they buy', input: 'days', ops: ['lte'], placeholder: '30' },

  // -------------------------------------------------- how they feel ------
  {
    key: 'ratedAtLeast',
    label: 'Has rated you at least',
    group: 'How they feel',
    input: 'number',
    ops: ['gte'],
    placeholder: '4',
    help: 'Your happy customers. The only people who should ever be asked for a Google review.',
  },
  {
    key: 'ratedBelow',
    label: 'Has rated you below',
    group: 'How they feel',
    input: 'number',
    ops: ['lte'],
    placeholder: '3',
    help: 'Handle with care. These people should hear from a person, not a campaign.',
  },
  { key: 'noFeedback', label: 'Has never left feedback', group: 'How they feel', input: 'boolean', ops: ['eq'] },

  // ------------------------------------------------------- occasions -----
  { key: 'birthdayMonth', label: 'Birthday in month', group: 'Occasions', input: 'month', ops: ['eq'], postFilter: true },
  {
    key: 'birthdayInNextDays',
    label: 'Birthday within the next (days)',
    group: 'Occasions',
    input: 'days',
    ops: ['lte'],
    placeholder: '7',
    postFilter: true,
    help: 'Ignores the year, so it works every year.',
  },
  { key: 'anniversaryInNextDays', label: 'Anniversary within the next (days)', group: 'Occasions', input: 'days', ops: ['lte'], placeholder: '7', postFilter: true },

  // ------------------------------------------------------ reachable ------
  {
    key: 'reachableOn',
    label: 'Can be reached on',
    group: 'Can you reach them',
    input: 'channel',
    ops: ['eq'],
    help: 'Has an address for that channel and has opted in. A campaign to people you cannot message is just a smaller campaign.',
  },
  { key: 'whatsappConsent', label: 'WhatsApp consent', group: 'Can you reach them', input: 'channel', ops: ['eq'] },
  { key: 'hasEmail', label: 'Has an email address', group: 'Can you reach them', input: 'boolean', ops: ['eq'] },
];

export const FIELD_BY_KEY = new Map(SEGMENT_FIELDS.map((field) => [field.key, field]));

export const FIELD_GROUPS = [...new Set(SEGMENT_FIELDS.map((field) => field.group))];

/**
 * Segments a salon would build anyway, written out so they do not have to.
 *
 * Each is a real working list rather than a demo: the name is what an owner
 * would call it, and `why` says what you would actually send them.
 */
export interface SegmentPreset {
  key: string;
  name: string;
  why: string;
  rules: { match: 'all' | 'any'; conditions: { field: string; op: string; value: unknown }[] };
}

export const SEGMENT_PRESETS: readonly SegmentPreset[] = [
  {
    key: 'one_visit_wonders',
    name: 'Came once, never again',
    why: 'They tried you and did not come back. Winning one of these back is cheaper than finding a new customer.',
    rules: { match: 'all', conditions: [{ field: 'onlyOneVisit', op: 'eq', value: true }, { field: 'noVisitDays', op: 'gte', value: 60 }] },
  },
  {
    key: 'lapsed_regulars',
    name: 'Lapsed regulars',
    why: 'They used to come often and have gone quiet. The most valuable win-back list you have.',
    rules: { match: 'all', conditions: [{ field: 'totalVisits', op: 'gte', value: 4 }, { field: 'noVisitDays', op: 'gte', value: 60 }] },
  },
  {
    key: 'big_spenders',
    name: 'Your best customers',
    why: 'Worth a personal message, an early slot, or a first look at anything new.',
    rules: { match: 'all', conditions: [{ field: 'totalSpent', op: 'gte', value: 25000 }, { field: 'visitedWithinDays', op: 'lte', value: 120 }] },
  },
  {
    key: 'new_this_month',
    name: 'New this month',
    why: 'First impressions. A thank-you and a reason to book the second visit.',
    rules: { match: 'all', conditions: [{ field: 'newWithinDays', op: 'lte', value: 30 }] },
  },
  {
    key: 'happy_customers',
    name: 'Happy customers',
    why: 'Rated you 4 or 5. The only list that should ever be asked for a public review.',
    rules: { match: 'all', conditions: [{ field: 'ratedAtLeast', op: 'gte', value: 4 }] },
  },
  {
    key: 'membership_ending',
    name: 'Membership ending soon',
    why: 'Renewal is a conversation, not a surprise. Reach them before it lapses.',
    rules: { match: 'all', conditions: [{ field: 'membershipExpiringInDays', op: 'lte', value: 30 }] },
  },
  {
    key: 'birthdays_this_week',
    name: 'Birthdays this week',
    why: 'The one message a year nobody minds receiving.',
    rules: { match: 'all', conditions: [{ field: 'birthdayInNextDays', op: 'lte', value: 7 }] },
  },
  {
    key: 'unpaid',
    name: 'Owes you money',
    why: 'Not a campaign — a list to work through at the counter.',
    rules: { match: 'all', conditions: [{ field: 'hasOutstanding', op: 'eq', value: true }] },
  },
];
