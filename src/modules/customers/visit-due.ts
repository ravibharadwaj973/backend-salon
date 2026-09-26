import { LIFECYCLE_ORDER, type LifecycleStage } from './visit-rhythm';

/**
 * THE AUTOMATION THAT RUNS ON THE CUSTOMER'S CLOCK, NOT THE SALON'S.
 *
 * The salon already had a win-back automation. It fires at a fixed 60 days,
 * for everybody — which visit-rhythm.ts spends its opening paragraph
 * explaining is wrong for almost every customer on the book. The man who has
 * his hair cut every three weeks is a month late before anybody chases him;
 * the woman who has balayage twice a year is perfectly on schedule and gets a
 * "we miss you!" that tells her the salon does not know her.
 *
 * The rhythm engine that fixes this has existed all along and nothing was
 * triggering off it. This is the missing piece: a trigger that fires when a
 * customer crosses into a stage of THEIR OWN cycle.
 *
 * ── The decisions that make the difference ────────────────────────────────
 *
 * CROSSING, NOT SITTING. The one thing this must not do is find everybody who
 * is currently at risk and message them all tonight. A salon switching this on
 * has a book full of people who went quiet months ago; messaging all of them at
 * once is a mass send wearing an automation's clothes. It would read as
 * desperate, and WhatsApp would mark the number down for it. So the trigger is
 * the MOMENT of crossing, which is a handful of people a day.
 *
 * AND IT STILL HAS A CAP. Because the first night after this is switched on,
 * a book that has never had its stages computed produces one enormous batch of
 * "crossings" that are really just arithmetic catching up. The cap turns that
 * into a queue: fifty a night, most overdue first, until it is through. That
 * is better marketing than the alternative as well as safer.
 *
 * FORWARD ONLY. A customer who comes in resets to ACTIVE, and the ladder is
 * climbed again from there. Only a move UP the ladder is a crossing; a move
 * back down is somebody visiting, which is the opposite of a reason to chase.
 */

/** A customer moving from one stage to another during a sweep. */
export interface StageCrossing {
  customerId: string;
  tenantId: string;
  from: LifecycleStage;
  to: LifecycleStage;
  /** Days since their last billed visit, at the moment of crossing. */
  daysSince: number;
  totalVisits: number;
  /** How many intervals their cycle is based on. 0 means it is the fallback. */
  basedOnIntervals: number;
}

/** The shape of a VISIT_DUE journey's triggerConfig. */
export interface VisitDueConfig {
  /** Which crossings this journey wants. */
  stages: LifecycleStage[];
  /** Ignore customers below this many visits. One visit is a different story. */
  minVisits: number;
  /**
   * Ignore customers whose cycle is not earned yet.
   *
   * Set to 3 for a journey whose template talks about the customer's usual gap:
   * it is the difference between "you're usually back about every five weeks",
   * which they can check against their own memory, and the same sentence built
   * from a salon-wide guess, which they can also check — and will.
   */
  minBasis: number;
  /** The nightly ceiling. See the note above on why this exists. */
  maxPerRun: number;
}

export const DEFAULT_MAX_PER_RUN = 50;

/** The stages it is ever sensible to chase on. */
export const CHASEABLE_STAGES: LifecycleStage[] = ['DUE_SOON', 'DUE', 'OVERDUE', 'AT_RISK', 'LAPSED', 'DORMANT'];

export function readVisitDueConfig(raw: unknown): VisitDueConfig {
  const config = (raw ?? {}) as Partial<Record<keyof VisitDueConfig, unknown>>;

  const asked = Array.isArray(config.stages) ? (config.stages as unknown[]) : [];
  const stages = asked.filter((s): s is LifecycleStage =>
    typeof s === 'string' && (CHASEABLE_STAGES as string[]).includes(s),
  );

  const int = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

  return {
    // No stages configured means no journey, not every journey. An automation
    // that fires on everything because a field was left blank is the kind of
    // default that gets a salon's number blocked.
    stages,
    minVisits: int(config.minVisits, 2),
    minBasis: int(config.minBasis, 0),
    maxPerRun: Math.max(1, int(config.maxPerRun, DEFAULT_MAX_PER_RUN)),
  };
}

const rank = (stage: LifecycleStage) => LIFECYCLE_ORDER.indexOf(stage);

/**
 * Which of tonight's crossings this journey should act on, in the order it
 * should act on them.
 *
 * Pure, and tested on its own, because everything that can go wrong here goes
 * wrong quietly and at the scale of a whole customer book.
 */
export function selectCrossings(crossings: StageCrossing[], config: VisitDueConfig): StageCrossing[] {
  if (config.stages.length === 0) return [];
  const wanted = new Set(config.stages);

  return crossings
    .filter((crossing) => {
      if (!wanted.has(crossing.to)) return false;

      // Only a move up the ladder. Moving back down means they came in.
      if (rank(crossing.to) <= rank(crossing.from)) return false;

      /**
       * A row that has never had its stage computed sits at NEVER_VISITED
       * whatever its history says, so the first sweep moves a five-year
       * customer straight to LAPSED. That is the database catching up, not a
       * customer lapsing tonight, and chasing it would mean a "we miss you"
       * to people who were last seen in 2021 on the day the feature shipped.
       */
      if (crossing.from === 'NEVER_VISITED' && crossing.totalVisits > 0) return false;

      if (crossing.totalVisits < config.minVisits) return false;
      if (crossing.basedOnIntervals < config.minBasis) return false;
      return true;
    })
    /**
     * Most overdue first, so that when the cap bites it is the people closest
     * to being lost who are reached tonight and the rest who wait a day.
     */
    .sort((a, b) => b.daysSince - a.daysSince)
    .slice(0, config.maxPerRun);
}

const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const spell = (n: number) => WORDS[n] ?? String(n);

/**
 * A customer's cycle in the words they would use for it.
 *
 * "42" is a number off a database row. "about every six weeks" is what the
 * customer would say if you asked them, and it is the only version that can go
 * into a message — a message that quotes a figure the customer can check
 * against their own memory has to get it right in their units, not ours.
 *
 * Deliberately approximate. A cycle is a median over a handful of visits, so
 * "every 43 days" claims a precision the number does not have, and precision
 * that is not real is the fastest way to sound like a machine.
 */
export function describeGap(intervalDays: number): string {
  const days = Math.max(1, Math.round(intervalDays));

  if (days <= 10) return days === 1 ? 'about every day' : `about every ${spell(days)} days`;

  const weeks = Math.round(days / 7);
  // Up to two months, weeks are how people say it: "every six weeks", never
  // "every 1.4 months".
  if (days < 70) return weeks === 1 ? 'about every week' : `about every ${spell(weeks)} weeks`;

  const months = Math.round(days / 30);
  if (months <= 1) return 'about once a month';
  if (months === 12) return 'about once a year';
  return `about every ${spell(months)} months`;
}
