/**
 * EVERY CUSTOMER HAS THEIR OWN CLOCK.
 *
 * "Not seen in 45 days" is the segmentation every salon CRM ships with, and it
 * is wrong for almost everybody. A man who has his hair cut every three weeks
 * is a month late at 45 days and nobody chased him. A woman who has balayage
 * twice a year is perfectly on schedule at 45 days and just got a "we miss
 * you!" message that makes the salon look like it does not know her.
 *
 * The fix is to measure each customer against their own history rather than
 * against one number for the whole book. That single change turns a blunt
 * "lapsed" list into a lifecycle: due soon, due, overdue, at risk, lapsed,
 * dormant — each one a different conversation at a different moment.
 *
 * Three decisions in here are worth stating plainly, because they are the
 * difference between a number that is right and a number that merely exists:
 *
 *  1. THE MEDIAN, NOT THE MEAN. A regular who visits monthly and then spends a
 *     year abroad has one 380-day gap in an otherwise tidy series. A mean turns
 *     their 30-day rhythm into 60 and the salon stops chasing them exactly when
 *     it should start. The median ignores the holiday.
 *
 *  2. TWO VISITS IS NOT A RHYTHM. One interval is a coincidence; it might be a
 *     fringe trim booked the week after a colour. A cycle is only claimed from
 *     three intervals (four visits) up, and what is known is reported honestly
 *     rather than dressed up as fact.
 *
 *  3. RECENT BEHAVIOUR COUNTS FOR MORE. People's habits change — a new job, a
 *     new baby, a wedding coming up. Only the last several intervals are used,
 *     so a rhythm from three years ago does not outvote the way they behave now.
 */

/** Where a customer sits against their own cycle. */
export type LifecycleStage =
  /** Has never been billed. A lead who booked, or an import that never visited. */
  | 'NEVER_VISITED'
  /** One visit, recently. The most valuable moment in the whole list. */
  | 'NEW'
  /** One visit, and they did not come back. Tried the salon, formed no habit. */
  | 'ONE_TIME'
  /** Comfortably inside their own cycle. Nothing to do; do not message them. */
  | 'ACTIVE'
  /** Approaching their usual gap. The right moment to offer the next booking. */
  | 'DUE_SOON'
  /** At their usual gap. */
  | 'DUE'
  /** Past it, but not alarmingly. */
  | 'OVERDUE'
  /** Well past it. This is where a salon actually loses people. */
  | 'AT_RISK'
  /** Long past any reasonable reading of their cycle. */
  | 'LAPSED'
  /** Over a year. Recoverable, but not with the same message as a 60-day gap. */
  | 'DORMANT';

export interface Rhythm {
  /** The customer's own gap between visits, in days. Null until it is earned. */
  intervalDays: number | null;
  /** How many intervals it is based on — 0 means the fallback was used. */
  basedOnIntervals: number;
  /** When they are due, on their own clock. */
  expectedNextVisitAt: Date | null;
  /** daysSinceLastVisit / intervalDays. 1.0 means due today. */
  overdueRatio: number | null;
  stage: LifecycleStage;
}

/**
 * Only the most recent intervals are considered. Long enough to be stable,
 * short enough that a change of habit shows up within a few visits.
 */
const WINDOW = 6;

/** Below this many intervals, the number is a guess rather than a rhythm. */
const MIN_INTERVALS = 3;

/**
 * Used when a customer has no rhythm of their own yet. A salon-wide default is
 * a worse answer than their own history but a much better one than nothing,
 * and it is what makes a second-visit nudge possible at all.
 */
export const DEFAULT_INTERVAL_DAYS = 45;

/** Beyond this, the gap says more than any ratio does. */
const DORMANT_DAYS = 365;

/** A single visit that recent still counts as new rather than lost. */
const NEW_WINDOW_DAYS = 45;

const DAY = 24 * 60 * 60 * 1000;

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Work out a customer's rhythm and where they currently stand in it.
 *
 * `visitDates` is every billed visit, in any order; duplicates on the same day
 * are collapsed, because two invoices in one afternoon is one visit and would
 * otherwise inject a zero-day interval that drags the median to nothing.
 */
export function visitRhythm(visitDates: Date[], now: Date = new Date()): Rhythm {
  const days = [...new Set(visitDates.map((d) => Math.floor(d.getTime() / DAY)))].sort((a, b) => a - b);

  if (days.length === 0) {
    return {
      intervalDays: null,
      basedOnIntervals: 0,
      expectedNextVisitAt: null,
      overdueRatio: null,
      stage: 'NEVER_VISITED',
    };
  }

  const lastVisit = new Date(days[days.length - 1]! * DAY);
  const daysSince = Math.max(0, daysBetween(lastVisit, now));

  // Gaps between consecutive visits, most recent WINDOW of them.
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i += 1) gaps.push(days[i]! - days[i - 1]!);
  const recent = gaps.slice(-WINDOW);

  const earned = recent.length >= MIN_INTERVALS;
  const intervalDays = earned ? Math.max(1, Math.round(median(recent))) : null;

  // The ratio is still worth having before a rhythm is earned; it just leans on
  // the salon-wide default and says so through basedOnIntervals.
  const against = intervalDays ?? DEFAULT_INTERVAL_DAYS;
  const overdueRatio = Math.round((daysSince / against) * 100) / 100;

  const expectedNextVisitAt = new Date(lastVisit.getTime() + against * DAY);

  return {
    intervalDays,
    basedOnIntervals: recent.length,
    expectedNextVisitAt,
    overdueRatio,
    stage: stageFor({ visits: days.length, daysSince, ratio: overdueRatio }),
  };
}

/**
 * The ladder.
 *
 * A single visit is its own story — the first-to-second conversion is the one
 * number that decides whether a salon grows — so it never enters the ratio
 * ladder, where one interval of history would make the answer meaningless.
 *
 * The bands are deliberately tight near 1.0 and wide after it: the difference
 * between "due" and "a bit late" is worth a different message, while everything
 * past twice their cycle is the same problem.
 */
export function stageFor({
  visits,
  daysSince,
  ratio,
}: {
  visits: number;
  daysSince: number;
  ratio: number;
}): LifecycleStage {
  if (visits === 0) return 'NEVER_VISITED';

  // A year away is a year away, whatever their cycle used to be. Checked before
  // everything else so a six-month-cycle customer is not called "due".
  if (daysSince >= DORMANT_DAYS) return 'DORMANT';

  if (visits === 1) return daysSince <= NEW_WINDOW_DAYS ? 'NEW' : 'ONE_TIME';

  if (ratio < 0.8) return 'ACTIVE';
  if (ratio < 1.0) return 'DUE_SOON';
  if (ratio < 1.25) return 'DUE';
  if (ratio < 1.5) return 'OVERDUE';
  if (ratio < 2.5) return 'AT_RISK';
  return 'LAPSED';
}

/** The stages, in the order a customer travels through them. */
export const LIFECYCLE_ORDER: LifecycleStage[] = [
  'NEVER_VISITED',
  'NEW',
  'ONE_TIME',
  'ACTIVE',
  'DUE_SOON',
  'DUE',
  'OVERDUE',
  'AT_RISK',
  'LAPSED',
  'DORMANT',
];

/** What each stage means, in the words the screen uses. */
export const LIFECYCLE_LABELS: Record<LifecycleStage, { label: string; description: string }> = {
  NEVER_VISITED: { label: 'Never visited', description: 'On the books but never billed.' },
  NEW: { label: 'New', description: 'One visit, recently. Win the second one.' },
  ONE_TIME: { label: 'One-time', description: 'Came once and never came back.' },
  ACTIVE: { label: 'Active', description: 'Comfortably inside their usual gap.' },
  DUE_SOON: { label: 'Due soon', description: 'Approaching their usual gap — the moment to offer a booking.' },
  DUE: { label: 'Due', description: 'At their usual gap now.' },
  OVERDUE: { label: 'Overdue', description: 'Past their usual gap, but not badly.' },
  AT_RISK: { label: 'At risk', description: 'Well past their gap. This is where salons lose people.' },
  LAPSED: { label: 'Lapsed', description: 'More than twice their usual gap.' },
  DORMANT: { label: 'Dormant', description: 'Over a year. Recoverable, but not with an ordinary message.' },
};
