import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PER_RUN,
  describeGap,
  readVisitDueConfig,
  selectCrossings,
  type StageCrossing,
} from '../src/modules/customers/visit-due';
import type { LifecycleStage } from '../src/modules/customers/visit-rhythm';

/**
 * CHASING A CUSTOMER ON THEIR OWN CLOCK.
 *
 * Everything in this file protects against the same class of mistake: sending
 * a message to somebody it is not true of. A win-back to a regular who came in
 * last week, a "you're usually back every six weeks" to somebody who has
 * visited twice, eight hundred messages in one night because the database
 * caught up with itself. None of these throw. All of them reach real people.
 */

const crossing = (over: Partial<StageCrossing> = {}): StageCrossing => ({
  customerId: 'c1',
  tenantId: 't1',
  from: 'ACTIVE',
  to: 'DUE_SOON',
  daysSince: 40,
  totalVisits: 6,
  basedOnIntervals: 5,
  ...over,
});

const config = (over: Partial<ReturnType<typeof readVisitDueConfig>> = {}) => ({
  ...readVisitDueConfig({ stages: ['DUE_SOON'] }),
  ...over,
});

describe('who tonight’s crossings actually reach', () => {
  it('takes a customer who crossed into the stage this sweep', () => {
    expect(selectCrossings([crossing()], config())).toHaveLength(1);
  });

  it('ignores a crossing into a stage this journey did not ask for', () => {
    expect(selectCrossings([crossing({ to: 'AT_RISK' })], config())).toHaveLength(0);
  });

  it('never fires on a customer moving back down the ladder', () => {
    // AT_RISK -> ACTIVE means they came in. A journey configured for ACTIVE
    // would otherwise send "we miss you" to somebody sitting in the chair.
    const back = crossing({ from: 'AT_RISK', to: 'ACTIVE' });
    expect(selectCrossings([back], config({ stages: ['ACTIVE' as LifecycleStage] }))).toHaveLength(0);
  });

  it('does not chase a whole back catalogue the first time stages are computed', () => {
    /**
     * The failure this exists for. A row that has never been swept sits at
     * NEVER_VISITED whatever its history says, so the first run moves a
     * five-year customer straight to LAPSED. That is arithmetic catching up,
     * not somebody lapsing tonight — and acting on it means a "we miss you"
     * to people last seen in 2021, on the day the feature ships.
     */
    const stale = crossing({ from: 'NEVER_VISITED', to: 'LAPSED', totalVisits: 9, daysSince: 700 });
    expect(selectCrossings([stale], config({ stages: ['LAPSED'] }))).toHaveLength(0);
  });

  it('still fires for somebody who genuinely has no visits yet', () => {
    // Same transition, no history behind it: this one really did just happen.
    const real = crossing({ from: 'NEVER_VISITED', to: 'NEW' as LifecycleStage, totalVisits: 0 });
    expect(
      selectCrossings([real], config({ stages: ['NEW' as LifecycleStage], minVisits: 0 })),
    ).toHaveLength(1);
  });

  it('holds back customers whose cycle is still a guess when the journey needs a real one', () => {
    // The template says "you're usually back about every six weeks". With two
    // intervals behind it, that sentence is a salon-wide default wearing the
    // customer's name — and they are the one person who can disprove it.
    const thin = crossing({ basedOnIntervals: 2 });
    expect(selectCrossings([thin], config({ minBasis: 3 }))).toHaveLength(0);
    expect(selectCrossings([crossing()], config({ minBasis: 3 }))).toHaveLength(1);
  });

  it('leaves one-visit customers to a different conversation', () => {
    expect(selectCrossings([crossing({ totalVisits: 1 })], config({ minVisits: 2 }))).toHaveLength(0);
  });

  it('sends nobody when no stage is configured', () => {
    // A blank field must mean "no journey", never "every journey". This is the
    // default that gets a salon's WhatsApp number rate-limited.
    expect(selectCrossings([crossing()], readVisitDueConfig({}))).toHaveLength(0);
    expect(selectCrossings([crossing()], readVisitDueConfig({ stages: ['nonsense'] }))).toHaveLength(0);
  });
});

describe('the nightly cap', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    crossing({ customerId: `c${i}`, daysSince: 30 + i }),
  );

  it('caps the night, so switching this on is not a mass send', () => {
    const picked = selectCrossings(many, config({ maxPerRun: 50 }));
    expect(picked).toHaveLength(50);
  });

  it('reaches the most overdue first, because the cap decides who waits a day', () => {
    const picked = selectCrossings(many, config({ maxPerRun: 5 }));
    expect(picked.map((c) => c.daysSince)).toEqual([149, 148, 147, 146, 145]);
  });

  it('defaults to a cap rather than to no cap', () => {
    expect(readVisitDueConfig({ stages: ['DUE_SOON'] }).maxPerRun).toBe(DEFAULT_MAX_PER_RUN);
    // A hand-edited zero must not be read as "unlimited".
    expect(readVisitDueConfig({ stages: ['DUE_SOON'], maxPerRun: 0 }).maxPerRun).toBeGreaterThan(0);
  });
});

describe('a cycle said the way a customer would say it', () => {
  it('speaks in weeks up to a couple of months', () => {
    expect(describeGap(21)).toBe('about every three weeks');
    expect(describeGap(42)).toBe('about every six weeks');
    // 43 and 42 are the same fortnight to a human. A median over five visits
    // does not support the precision that "every 43 days" claims.
    expect(describeGap(43)).toBe('about every six weeks');
  });

  it('speaks in days when the gap is short', () => {
    expect(describeGap(7)).toBe('about every seven days');
  });

  it('speaks in months for a colour client', () => {
    expect(describeGap(150)).toBe('about every five months');
    expect(describeGap(365)).toBe('about once a year');
  });

  it('never returns an empty string', () => {
    // An empty variable is a message that does not get sent, silently. Every
    // input has to produce words.
    for (const days of [0, 1, 0.4, 9, 70, 200, 4000]) {
      expect(describeGap(days).length).toBeGreaterThan(0);
    }
  });
});
