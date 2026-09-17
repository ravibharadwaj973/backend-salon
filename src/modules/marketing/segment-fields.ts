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
  | 'text'
  | 'lifecycle';

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

  // ------------------------------------------------- their own clock -----
  /**
   * The group that makes this more than a mailing list.
   *
   * Everything above asks "how long since they came?" against one number for
   * the whole book. These ask "are they late FOR THEM?" — a three-weekly
   * haircut and a twice-a-year balayage are both 45 days out today, and only
   * one of them is a problem.
   */
  {
    key: 'lifecycleStage',
    label: 'Where they are in their cycle',
    group: 'Their own visit cycle',
    input: 'lifecycle',
    ops: ['eq', 'in', 'nin'],
    help: 'Measured against this customer’s own gap between visits, not a fixed number of days.',
  },
  {
    key: 'dueWithinDays',
    label: 'Due for a visit within (days)',
    group: 'Their own visit cycle',
    input: 'days',
    ops: ['lte'],
    placeholder: '7',
    help: 'On their own cycle. The list to offer next week’s slots to.',
  },
  {
    key: 'overdueByDays',
    label: 'Overdue by more than (days)',
    group: 'Their own visit cycle',
    input: 'days',
    ops: ['gte'],
    placeholder: '14',
    help: 'Days past when they were due — not days since they last came.',
  },
  {
    key: 'visitIntervalDays',
    label: 'Usually visits every (days)',
    group: 'Their own visit cycle',
    input: 'days',
    ops: ['lte', 'gte', 'between'],
    help: 'Their own rhythm. Under 30 is a regular haircut; over 90 is occasional colour.',
  },
  {
    key: 'hasKnownRhythm',
    label: 'Has an established rhythm',
    group: 'Their own visit cycle',
    input: 'boolean',
    ops: ['eq'],
    help: 'Four or more visits, so the cycle is real rather than a guess. Turn off to include newer customers.',
  },

  // ---------------------------------------------------------- risk -------
  {
    key: 'noShowCount',
    label: 'Missed appointments',
    group: 'Risk and reliability',
    input: 'number',
    ops: ['gte', 'lte', 'eq'],
    placeholder: '2',
    help: 'No-shows cost a chair for an hour. Two or more is a different booking policy, not a campaign.',
  },
  {
    key: 'lastServiceCategory',
    label: 'Last service was in category',
    group: 'What they buy',
    input: 'category',
    ops: ['eq', 'in'],
    help: 'What they actually bought last, so a colour reminder does not go to a waxing customer.',
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
  /**
   * THE LIFECYCLE SET.
   *
   * These come first because they are the ones that make money, and because
   * each is measured against the customer's own visit cycle rather than a
   * fixed number of days. On any given Tuesday a three-weekly haircut and a
   * twice-a-year balayage are both "45 days out"; only one of them needs a
   * message, and a fixed rule sends it to the wrong one.
   *
   * Each has one job. A segment you cannot name the message for is a segment
   * that should not exist.
   */
  {
    key: 'first_visit_win_second',
    name: 'New — win the second visit',
    why: 'One visit, recently. First-to-second conversion is the number that decides whether the salon grows, and the window is weeks, not months.',
    rules: { match: 'all', conditions: [{ field: 'lifecycleStage', op: 'in', value: ['NEW'] }] },
  },
  {
    key: 'due_this_week',
    name: 'Due for a visit this week',
    why: 'On their own cycle, not a calendar rule. The list to offer next week’s empty slots to — they were coming anyway, this just picks the day.',
    rules: { match: 'all', conditions: [{ field: 'dueWithinDays', op: 'lte', value: 7 }, { field: 'hasKnownRhythm', op: 'eq', value: true }] },
  },
  {
    key: 'drifting_regulars',
    name: 'Regulars starting to drift',
    why: 'Past their own gap but not gone. This is where a salon actually loses people, and a message here costs far less than a win-back later.',
    rules: { match: 'all', conditions: [{ field: 'lifecycleStage', op: 'in', value: ['OVERDUE', 'AT_RISK'] }, { field: 'totalVisits', op: 'gte', value: 3 }] },
  },
  {
    key: 'at_risk_high_value',
    name: 'At risk — and worth real effort',
    why: 'A ₹35,000 customer drifting away should not get the same "20% off everything" as everyone else. Call them, name their stylist, offer their usual slot.',
    rules: {
      match: 'all',
      conditions: [
        { field: 'lifecycleStage', op: 'in', value: ['AT_RISK', 'LAPSED'] },
        { field: 'totalSpent', op: 'gte', value: 25000 },
      ],
    },
  },
  {
    key: 'vip_active',
    name: 'VIPs, still coming',
    why: 'High spend, often, and on schedule. Early access and first look at anything new — not discounts they were never going to need.',
    rules: {
      match: 'all',
      conditions: [
        { field: 'totalSpent', op: 'gte', value: 25000 },
        { field: 'totalVisits', op: 'gte', value: 5 },
        { field: 'lifecycleStage', op: 'in', value: ['ACTIVE', 'DUE_SOON', 'DUE'] },
      ],
    },
  },
  {
    key: 'premium_spenders',
    name: 'Big bill every time',
    why: 'Different from lifetime value: three visits at ₹8,000 is a premium customer, twenty at ₹2,000 is a loyal one. This list is for packages and upgrades.',
    rules: { match: 'all', conditions: [{ field: 'avgBill', op: 'gte', value: 3000 }, { field: 'totalVisits', op: 'gte', value: 2 }] },
  },
  {
    key: 'dormant_over_a_year',
    name: 'Gone over a year',
    why: 'Not the same problem as a 60-day gap and not worth the same message. Treat as almost-new: reintroduce the salon rather than reminding them of it.',
    rules: { match: 'all', conditions: [{ field: 'lifecycleStage', op: 'in', value: ['DORMANT'] }] },
  },
  {
    key: 'no_show_risk',
    name: 'Misses appointments',
    why: 'Not a campaign — a booking policy. Confirm these before holding a chair, and consider a deposit for the long services.',
    rules: { match: 'all', conditions: [{ field: 'noShowCount', op: 'gte', value: 2 }] },
  },
  {
    key: 'referral_candidates',
    name: 'Happy regulars worth asking',
    why: 'Been several times and rated you well. The only list that should be asked for a referral or a public review.',
    rules: {
      match: 'all',
      conditions: [
        { field: 'totalVisits', op: 'gte', value: 5 },
        { field: 'ratedAtLeast', op: 'gte', value: 4 },
        { field: 'lifecycleStage', op: 'nin', value: ['AT_RISK', 'LAPSED', 'DORMANT'] },
      ],
    },
  },

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
