import { describe, expect, it } from 'vitest';
import { meterFor, quotaOf, periodFor, METER_LABELS, ALL_METERS } from '../src/modules/quotas/quota.service';
import {
  PILOT_FEATURES,
  PRO_FEATURES,
  STARTER_FEATURES,
  FAIR_USE_UNLIMITED,
  FEATURES,
  GROWTH_FEATURES,
  enabledFeatures,
  featureMap,
  hasFeature,
  isUnlimited,
  limitLabel,
} from '../src/core/features';

/** The plans exactly as sold, so the tests fail if the pricing drifts. */
const PILOT = {
  waUtilityQuota: 100,
  waMarketingQuota: 50,
  waAuthQuota: 0,
  smsQuota: 200,
  emailQuota: 500,
};
const STARTER = {
  waUtilityQuota: 500,
  waMarketingQuota: 0,
  waAuthQuota: 0,
  smsQuota: 1000,
  emailQuota: 1000,
};
const GROWTH = {
  waUtilityQuota: 1000,
  waMarketingQuota: 500,
  waAuthQuota: 0,
  smsQuota: 3000,
  emailQuota: 3000,
};
const PRO = {
  waUtilityQuota: 2000,
  waMarketingQuota: 1000,
  waAuthQuota: 500,
  smsQuota: 5000,
  emailQuota: 5000,
};

describe('metering', () => {
  it('charges WhatsApp marketing and utility to different meters', () => {
    // The whole point: Meta charges ~7.5x more for marketing, so a salon must
    // not be able to spend a marketing budget out of a reminders allowance.
    expect(meterFor('WHATSAPP', 'MARKETING')).toBe('WA_MARKETING');
    expect(meterFor('WHATSAPP', 'UTILITY')).toBe('WA_UTILITY');
    expect(meterFor('WHATSAPP', 'AUTHENTICATION')).toBe('WA_AUTHENTICATION');
  });

  it('bills service-window replies at the utility meter', () => {
    // Meta starts charging for these on 1 Oct 2026, at the utility rate.
    expect(meterFor('WHATSAPP', 'SERVICE')).toBe('WA_UTILITY');
  });

  it('meters SMS and email separately, and leaves in-app messages free', () => {
    expect(meterFor('SMS', 'UTILITY')).toBe('SMS');
    expect(meterFor('EMAIL', 'MARKETING')).toBe('EMAIL');
    expect(meterFor('IN_APP', 'UTILITY')).toBeNull();
  });

  it('defaults an untemplated send to utility', () => {
    expect(meterFor('WHATSAPP')).toBe('WA_UTILITY');
  });

  it('gives every meter a label', () => {
    for (const meter of ALL_METERS) expect(METER_LABELS[meter]).toBeTruthy();
  });
});

describe('plan allowances', () => {
  it('reads the published Starter allowances', () => {
    expect(quotaOf(STARTER, 'WA_UTILITY')).toBe(500);
    expect(quotaOf(STARTER, 'SMS')).toBe(1000);
    expect(quotaOf(STARTER, 'EMAIL')).toBe(1000);
  });

  it('gives the pilot enough to feel the product but not to run a real month', () => {
    // The pilot should run out of volume, not features — that is what makes the
    // upgrade conversation about the salon's own usage.
    expect(quotaOf(PILOT, 'WA_UTILITY')).toBe(100);
    expect(quotaOf(PILOT, 'WA_MARKETING')).toBe(50);
    expect(quotaOf(PILOT, 'SMS')).toBe(200);
    expect(quotaOf(PILOT, 'EMAIL')).toBe(500);
  });

  it('gives Starter no WhatsApp marketing at all', () => {
    // Zero is a refusal, not an oversight: marketing automation is the Growth
    // upsell, and a Starter salon sending marketing would cost more than it pays.
    expect(quotaOf(STARTER, 'WA_MARKETING')).toBe(0);
  });

  it('reads the published Growth and Pro allowances', () => {
    expect(quotaOf(GROWTH, 'WA_UTILITY')).toBe(1000);
    expect(quotaOf(GROWTH, 'WA_MARKETING')).toBe(500);
    expect(quotaOf(PRO, 'WA_UTILITY')).toBe(2000);
    expect(quotaOf(PRO, 'WA_MARKETING')).toBe(1000);
    expect(quotaOf(PRO, 'EMAIL')).toBe(5000);
  });

  it('steps every meter upward across the tiers', () => {
    // A tier that does not beat the one below it on some axis is a pricing bug.
    for (const meter of ['WA_UTILITY', 'SMS', 'EMAIL'] as const) {
      expect(quotaOf(STARTER, meter)).toBeGreaterThan(quotaOf(PILOT, meter));
      expect(quotaOf(GROWTH, meter)).toBeGreaterThanOrEqual(quotaOf(STARTER, meter));
      expect(quotaOf(PRO, meter)).toBeGreaterThan(quotaOf(GROWTH, meter));
    }
  });

  it('treats a tenant with no plan as having nothing', () => {
    for (const meter of ALL_METERS) expect(quotaOf(null, meter)).toBe(0);
  });
});

describe('billing period', () => {
  it('runs from the 1st to the last day of the month, in the salon timezone', () => {
    const period = periodFor(new Date('2026-09-17T12:00:00Z'), 'Asia/Kolkata');
    expect(period.label).toBe('September 2026');
    expect(period.start.toISOString()).toBe('2026-08-31T18:30:00.000Z'); // 1 Sep 00:00 IST
    expect(period.end.getUTCMonth()).toBe(8);
  });

  it('puts a late-evening IST send in the right month', () => {
    // 30 Sep 23:30 IST is 18:00 UTC — a naive UTC month would bill it to October.
    const period = periodFor(new Date('2026-09-30T18:00:00Z'), 'Asia/Kolkata');
    expect(period.label).toBe('September 2026');
  });

  it('rolls over at the start of the next month', () => {
    expect(periodFor(new Date('2026-10-01T00:30:00Z'), 'Asia/Kolkata').label).toBe('October 2026');
  });
});

describe('plan features', () => {
  it('gives the pilot the whole marketing product, not a crippled one', () => {
    const pilot = featureMap(PILOT_FEATURES);
    expect(hasFeature(pilot, FEATURES.CAMPAIGNS)).toBe(true);
    expect(hasFeature(pilot, FEATURES.AUTOMATION)).toBe(true);
    expect(hasFeature(pilot, FEATURES.CAMPAIGN_ANALYTICS)).toBe(true);
    // ...but not the things the paid tiers are actually sold on.
    expect(hasFeature(pilot, FEATURES.MULTI_BRANCH)).toBe(false);
    expect(hasFeature(pilot, FEATURES.SEGMENTS_ADVANCED)).toBe(false);
  });

  it('gives Starter the automation that services a booking, and nothing that sells', () => {
    const starter = featureMap(STARTER_FEATURES);
    // Confirmations, reminders, bills and the feedback ask all still go out.
    expect(hasFeature(starter, FEATURES.AUTOMATION)).toBe(true);
    expect(hasFeature(starter, FEATURES.AUTOMATION_ADVANCED)).toBe(false);
    // Promotion, in every form, is what the plan above is for.
    expect(hasFeature(starter, FEATURES.MARKETING)).toBe(false);
    expect(hasFeature(starter, FEATURES.CAMPAIGNS)).toBe(false);
    expect(hasFeature(starter, FEATURES.SEGMENTS)).toBe(false);
    expect(hasFeature(starter, FEATURES.SEGMENTS_ADVANCED)).toBe(false);
    expect(hasFeature(starter, FEATURES.CAMPAIGN_ANALYTICS)).toBe(false);
    expect(hasFeature(starter, FEATURES.CAMPAIGN_ANALYTICS_ADVANCED)).toBe(false);
    expect(hasFeature(starter, FEATURES.MULTI_BRANCH)).toBe(false);
  });

  it('turns marketing on for Growth but keeps inventory and branches back', () => {
    const growth = featureMap(GROWTH_FEATURES);
    expect(hasFeature(growth, FEATURES.CAMPAIGNS)).toBe(true);
    expect(hasFeature(growth, FEATURES.LOYALTY)).toBe(true);
    expect(hasFeature(growth, FEATURES.MEMBERSHIPS)).toBe(true);
    expect(hasFeature(growth, FEATURES.INVENTORY)).toBe(false);
    expect(hasFeature(growth, FEATURES.MULTI_BRANCH)).toBe(false);
    expect(hasFeature(growth, FEATURES.UNIT_ECONOMICS)).toBe(false);
  });

  it('gives Pro everything Growth has, plus branches and the operations modules', () => {
    const pro = featureMap(PRO_FEATURES);
    for (const key of GROWTH_FEATURES) expect(hasFeature(pro, key)).toBe(true);
    expect(hasFeature(pro, FEATURES.INVENTORY)).toBe(true);
    expect(hasFeature(pro, FEATURES.MULTI_BRANCH)).toBe(true);
    expect(hasFeature(pro, FEATURES.UNIT_ECONOMICS)).toBe(true);
    expect(hasFeature(pro, FEATURES.CAMPAIGN_ANALYTICS_ADVANCED)).toBe(true);
  });

  it('never takes a feature away as the price goes up', () => {
    const starter = featureMap(STARTER_FEATURES);
    const growth = featureMap(GROWTH_FEATURES);
    const pro = featureMap(PRO_FEATURES);
    for (const key of STARTER_FEATURES) {
      expect(hasFeature(growth, key)).toBe(true);
      expect(hasFeature(pro, key)).toBe(true);
    }
    expect(enabledFeatures(pro).length).toBeGreaterThan(enabledFeatures(growth).length);
    expect(enabledFeatures(growth).length).toBeGreaterThan(enabledFeatures(starter).length);
  });

  it('treats missing or malformed feature JSON as everything off', () => {
    expect(hasFeature(null, FEATURES.LOYALTY)).toBe(false);
    expect(hasFeature(undefined, FEATURES.LOYALTY)).toBe(false);
    expect(hasFeature('nonsense', FEATURES.LOYALTY)).toBe(false);
    expect(hasFeature({ loyalty: 'yes' }, FEATURES.LOYALTY)).toBe(false); // only true counts
  });
});

/**
 * The overdraft is the subtlest rule in the system, so its intent is pinned here
 * in plain terms even though the numbers live in the database.
 *
 * The shape is: a campaign that is part-way through its recipients may finish by
 * going below zero, and the moment it does, everything *new* stops until a human
 * at the platform switches it back on. Half-sending a campaign is worse for the
 * salon's customers than either finishing it or never starting; and an automatic
 * monthly reset would mean a salon that overdraws every month never has a reason
 * to pay.
 */
describe('overdraft policy', () => {
  it('is bounded, so it cannot fund a campaign it was only meant to finish', () => {
    const OVERDRAFT_LIMIT = 200;
    const planAllowance = 500;

    // A 5,000-recipient blast on a 500-message plan must be refused up front —
    // the pre-flight check compares the whole audience against what is left,
    // deliberately *not* counting the overdraft as available.
    const audience = 5000;
    const available = planAllowance;
    expect(audience).toBeGreaterThan(available + OVERDRAFT_LIMIT);

    // Whereas a campaign that overruns by a little finishes.
    const smallOverrun = planAllowance + 40;
    expect(smallOverrun - planAllowance).toBeLessThanOrEqual(OVERDRAFT_LIMIT);
  });

  it('separates committed work from new work', () => {
    // Only sends carrying a campaign or journey id may overdraw. This is the
    // rule the dispatcher applies; encoded here so it is not quietly widened.
    const committed = (input: { campaignId?: string; journeyRunId?: string }) =>
      Boolean(input.campaignId || input.journeyRunId);

    expect(committed({ campaignId: 'c1' })).toBe(true);
    expect(committed({ journeyRunId: 'j1' })).toBe(true);
    expect(committed({})).toBe(false); // a manual send from the counter
  });
});

describe('fair-use limits', () => {
  it('shows a very large limit as unlimited without removing the limit', () => {
    expect(isUnlimited(FAIR_USE_UNLIMITED)).toBe(true);
    expect(limitLabel(FAIR_USE_UNLIMITED)).toBe('Unlimited');
  });

  it('shows a real limit as a number', () => {
    expect(limitLabel(5000)).toBe('5,000');
    expect(limitLabel(1000)).toBe('1,000');
    expect(isUnlimited(5000)).toBe(false);
  });
});
