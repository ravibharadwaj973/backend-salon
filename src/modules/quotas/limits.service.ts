import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { PaymentRequired, NotFound } from '../../core/errors';
import { hasFeature, type FeatureKey } from '../../core/features';
import { dayjs } from '../../core/dates';

/**
 * PLAN LIMITS
 *
 * maxBranches / maxStaff / maxCustomers are what a salon bought. They are checked
 * here, on the way in, rather than reported after the fact — a salon on a
 * one-branch plan gets a clear 402 when it tries to open a second branch, not a
 * surprise on next month's invoice.
 *
 * Every check counts what exists *now* rather than trusting a stored counter,
 * because a counter drifts the first time a row is deleted outside the app.
 */

interface LimitCheck {
  allowed: boolean;
  limit: number;
  current: number;
  remaining: number;
}

async function planFor(tenantId: string) {
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } }),
  );
  if (!tenant) throw NotFound('Tenant');
  return tenant.plan;
}

async function check(tenantId: string, limit: number, current: number, adding: number): Promise<LimitCheck> {
  return {
    allowed: current + adding <= limit,
    limit,
    current,
    remaining: Math.max(0, limit - current),
  };
}

export async function branchLimit(tenantId: string, adding = 1): Promise<LimitCheck> {
  const plan = await planFor(tenantId);
  const current = await runUnscoped(() => prisma.branch.count({ where: { tenantId, isActive: true } }));
  return check(tenantId, plan?.maxBranches ?? 1, current, adding);
}

export async function staffLimit(tenantId: string, adding = 1): Promise<LimitCheck> {
  const plan = await planFor(tenantId);
  const current = await runUnscoped(() => prisma.user.count({ where: { tenantId, isActive: true } }));
  return check(tenantId, plan?.maxStaff ?? 10, current, adding);
}

export async function customerLimit(tenantId: string, adding = 1): Promise<LimitCheck> {
  const plan = await planFor(tenantId);
  const current = await runUnscoped(() => prisma.customer.count({ where: { tenantId } }));
  return check(tenantId, plan?.maxCustomers ?? 5000, current, adding);
}

/** Throw the 402 a salon should see, naming the number they hit. */
function refuse(what: string, result: LimitCheck, upgradeHint: string): never {
  throw PaymentRequired(
    `Your plan includes ${result.limit} ${what}, and you already have ${result.current}. ${upgradeHint}`,
    { limit: result.limit, current: result.current, resource: what },
  );
}

export async function assertBranchAllowed(tenantId: string, adding = 1): Promise<void> {
  const result = await branchLimit(tenantId, adding);
  if (!result.allowed) {
    const plan = await planFor(tenantId);
    refuse(
      'branches',
      result,
      plan?.extraBranchPrice
        ? `Additional branches are ₹${Number(plan.extraBranchPrice).toLocaleString('en-IN')} each per month — ask us to add one.`
        : 'Move to a plan with more branches to add another.',
    );
  }
}

export async function assertStaffAllowed(tenantId: string, adding = 1): Promise<void> {
  const result = await staffLimit(tenantId, adding);
  if (!result.allowed) refuse('staff logins', result, 'Move to a larger plan to add more people.');
}

export async function assertCustomerAllowed(tenantId: string, adding = 1): Promise<void> {
  const result = await customerLimit(tenantId, adding);
  if (!result.allowed) {
    refuse(
      'customers',
      result,
      adding > 1
        ? 'This import would go past that. Move to a larger plan, or import fewer rows.'
        : 'Move to a larger plan to keep adding customers.',
    );
  }
}

/**
 * Campaigns started this calendar month. Counted rather than stored, so a
 * deleted draft frees the slot back up — a salon on three a month should not
 * lose one to a mistake.
 */
export async function campaignLimit(tenantId: string, adding = 1): Promise<LimitCheck> {
  const plan = await planFor(tenantId);
  const monthStart = dayjs().startOf('month').toDate();
  const current = await runUnscoped(() =>
    prisma.campaign.count({ where: { tenantId, createdAt: { gte: monthStart } } }),
  );
  return check(tenantId, plan?.maxCampaignsPerMonth ?? 3, current, adding);
}

export async function assertCampaignAllowed(tenantId: string, adding = 1): Promise<void> {
  const result = await campaignLimit(tenantId, adding);
  if (!result.allowed) {
    throw PaymentRequired(
      `Your plan includes ${result.limit} campaigns a month and you have already created ${result.current}. ` +
        'The count resets on the 1st, or move to a larger plan for unlimited campaigns.',
      { limit: result.limit, current: result.current, resource: 'campaigns' },
    );
  }
}

// --------------------------------------------------------------- features --

export async function tenantHasFeature(tenantId: string, feature: FeatureKey): Promise<boolean> {
  const plan = await planFor(tenantId);
  return hasFeature(plan?.features, feature);
}

export async function assertFeature(tenantId: string, feature: FeatureKey, label: string): Promise<void> {
  if (!(await tenantHasFeature(tenantId, feature))) {
    throw PaymentRequired(`${label} is not included in your plan.`, { feature });
  }
}

export async function limitsSummary(tenantId: string) {
  const [plan, branches, staff, customers] = await Promise.all([
    planFor(tenantId),
    branchLimit(tenantId, 0),
    staffLimit(tenantId, 0),
    customerLimit(tenantId, 0),
  ]);

  return {
    plan: plan ? { code: plan.code, name: plan.name, extraBranchPrice: plan.extraBranchPrice } : null,
    branches,
    staff,
    customers,
    campaigns: await campaignLimit(tenantId, 0),
  };
}
