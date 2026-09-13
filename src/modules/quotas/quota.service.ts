import type { Channel, MeterKey, Plan, PaymentMode, TemplateCategory } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { logger } from '../../core/logger';
import { NotFound, BadRequest } from '../../core/errors';
import { dayjs, DEFAULT_TZ } from '../../core/dates';

/**
 * MESSAGE METERING
 *
 * Every plan carries a monthly allowance per meter. A salon spends the allowance
 * first; once it is gone, it spends credits it has bought; once those are gone,
 * the send is refused rather than silently costing money.
 *
 * WhatsApp is metered as two separate things — utility and marketing — because
 * their costs are not comparable. A single "messages" number would let a salon
 * burn a marketing budget out of a reminders allowance, which is exactly the
 * mistake that makes a heavy user unprofitable.
 *
 * Allowances reset on the 1st of each calendar month in the tenant's timezone.
 * Purchased credits do not reset; they carry over until spent.
 */

export const ALL_METERS: readonly MeterKey[] = [
  'WA_UTILITY',
  'WA_MARKETING',
  'WA_AUTHENTICATION',
  'SMS',
  'EMAIL',
];

export const METER_LABELS: Record<MeterKey, string> = {
  WA_UTILITY: 'WhatsApp utility',
  WA_MARKETING: 'WhatsApp marketing',
  WA_AUTHENTICATION: 'WhatsApp authentication',
  SMS: 'SMS',
  EMAIL: 'Email',
};

/** Which meter a send is charged to. IN_APP messages are free and unmetered. */
export function meterFor(channel: Channel, category: TemplateCategory = 'UTILITY'): MeterKey | null {
  switch (channel) {
    case 'WHATSAPP':
      if (category === 'MARKETING') return 'WA_MARKETING';
      if (category === 'AUTHENTICATION') return 'WA_AUTHENTICATION';
      // SERVICE messages are replies inside an open conversation; Meta bills them
      // at the utility rate from 1 Oct 2026, so they meter as utility.
      return 'WA_UTILITY';
    case 'SMS':
      return 'SMS';
    case 'EMAIL':
      return 'EMAIL';
    case 'IN_APP':
    default:
      return null;
  }
}

export function quotaOf(plan: Pick<
  Plan,
  'waUtilityQuota' | 'waMarketingQuota' | 'waAuthQuota' | 'smsQuota' | 'emailQuota'
> | null, meter: MeterKey): number {
  if (!plan) return 0;
  switch (meter) {
    case 'WA_UTILITY':        return plan.waUtilityQuota;
    case 'WA_MARKETING':      return plan.waMarketingQuota;
    case 'WA_AUTHENTICATION': return plan.waAuthQuota;
    case 'SMS':               return plan.smsQuota;
    case 'EMAIL':             return plan.emailQuota;
  }
}

export interface Period {
  start: Date;
  end: Date;
  label: string;
}

/** The calendar month containing `at`, in the tenant's timezone. */
export function periodFor(at: Date, timezone: string = DEFAULT_TZ): Period {
  const m = dayjs(at).tz(timezone);
  return {
    start: m.startOf('month').toDate(),
    end: m.endOf('month').toDate(),
    label: m.format('MMMM YYYY'),
  };
}

async function tenantWithPlan(tenantId: string) {
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } }),
  );
  if (!tenant) throw NotFound('Tenant');
  return tenant;
}

/**
 * Fetch (or create) this month's counter row. `included` is snapshotted on
 * creation so that moving a salon to a bigger plan mid-month does not rewrite
 * what they were already told they had — the new allowance starts next month,
 * and a top-up covers the gap in the meantime.
 */
async function usageRow(tenantId: string, meter: MeterKey) {
  const tenant = await tenantWithPlan(tenantId);
  const period = periodFor(new Date(), tenant.timezone);
  const included = quotaOf(tenant.plan, meter);

  const existing = await runUnscoped(() =>
    prisma.messageUsage.findUnique({
      where: { tenantId_meter_periodStart: { tenantId, meter, periodStart: period.start } },
    }),
  );
  if (existing) return existing;

  try {
    return await runUnscoped(() =>
      prisma.messageUsage.create({
        data: { tenantId, meter, periodStart: period.start, periodEnd: period.end, included },
      }),
    );
  } catch {
    // Two sends racing on the first message of the month both try to create it.
    const row = await runUnscoped(() =>
      prisma.messageUsage.findUnique({
        where: { tenantId_meter_periodStart: { tenantId, meter, periodStart: period.start } },
      }),
    );
    if (!row) throw new Error(`Could not open a usage period for ${meter}`);
    return row;
  }
}

/**
 * SUSPENSION
 *
 * A salon that has overdrawn its allowance stops sending. Not the current
 * campaign — that finishes, because half-sent is worse for their customers than
 * either outcome — but everything after it.
 *
 * Lifting the block is a human decision by a platform operator, after the salon
 * has settled. Nothing here restores sending on its own: an automatic reset
 * would let a salon overdraw every month and never pay.
 */
export async function sendingStatus(tenantId: string) {
  const config = await runUnscoped(() =>
    prisma.tenantMessagingConfig.findUnique({ where: { tenantId } }),
  );
  return {
    blocked: config?.sendingBlocked ?? false,
    blockedAt: config?.blockedAt ?? null,
    reason: config?.blockedReason ?? null,
    owedMessages: config?.owedMessages ?? 0,
  };
}

/** Stop all new sending. Idempotent: re-blocking accumulates what is owed. */
export async function blockSending(tenantId: string, reason: string, owed = 0): Promise<void> {
  await runUnscoped(async () => {
    const existing = await prisma.tenantMessagingConfig.findUnique({ where: { tenantId } });
    if (existing?.sendingBlocked) {
      if (owed > 0) {
        await prisma.tenantMessagingConfig.update({
          where: { tenantId },
          data: { owedMessages: { increment: owed } },
        });
      }
      return;
    }

    const data = {
      sendingBlocked: true,
      blockedAt: new Date(),
      blockedReason: reason,
      owedMessages: (existing?.owedMessages ?? 0) + owed,
    };

    if (existing) {
      await prisma.tenantMessagingConfig.update({ where: { tenantId }, data });
    } else {
      await prisma.tenantMessagingConfig.create({ data: { tenantId, ...data } });
    }
  });

  logger.warn({ tenantId, reason, owed }, 'messaging blocked: allowance overdrawn');
}

/** Let a salon send again. Only a platform operator calls this. */
export async function unblockSending(tenantId: string, by: string, forgiveOwed = true) {
  return runUnscoped(() =>
    prisma.tenantMessagingConfig.upsert({
      where: { tenantId },
      create: { tenantId, sendingBlocked: false, unblockedAt: new Date(), unblockedBy: by },
      update: {
        sendingBlocked: false,
        blockedAt: null,
        blockedReason: null,
        unblockedAt: new Date(),
        unblockedBy: by,
        ...(forgiveOwed ? { owedMessages: 0 } : {}),
      },
    }),
  );
}

export type ConsumeSource = 'quota' | 'credits' | 'overdraft' | 'unmetered';

export interface ConsumeOptions {
  /**
   * True when this send belongs to work the salon already started — a campaign
   * that is part-way through its recipients, or a journey mid-run. Only these
   * may overdraw, and only to finish. A manual send or a fresh campaign never
   * does.
   */
  committed?: boolean;
}

export interface ConsumeResult {
  allowed: boolean;
  source: ConsumeSource | null;
  meter: MeterKey | null;
  /** Allowance left after this send, when it came out of the monthly allowance. */
  remaining?: number;
  /** Purchased balance left after this send, when it came out of credits. */
  credits?: number;
  reason?: string;
}

/**
 * Charge one message to a tenant. Returns whether the send may proceed.
 *
 * Both steps are single atomic statements with the condition in the WHERE clause,
 * so two concurrent sends on the last remaining message cannot both succeed —
 * whichever loses the race gets a row count of 0 and falls through to credits, or
 * is refused. Read-then-write would let a campaign of 500 messages overshoot.
 */
export async function consume(
  tenantId: string,
  meter: MeterKey | null,
  quantity = 1,
  options: ConsumeOptions = {},
): Promise<ConsumeResult> {
  if (!meter) return { allowed: true, source: 'unmetered', meter: null };
  if (quantity <= 0) return { allowed: true, source: 'unmetered', meter };

  // A blocked salon sends nothing new — but work already under way still
  // finishes, so the block is checked *after* the committed flag.
  if (!options.committed) {
    const status = await sendingStatus(tenantId);
    if (status.blocked) {
      return {
        allowed: false,
        source: null,
        meter,
        reason:
          status.reason ??
          'Sending is paused on this account. Settle the outstanding messages and we will switch it back on.',
      };
    }
  }

  const row = await usageRow(tenantId, meter);

  // 1. Monthly allowance.
  const claimed = await runUnscoped(() =>
    prisma.messageUsage.updateMany({
      where: { id: row.id, used: { lte: row.included - quantity } },
      data: { used: { increment: quantity } },
    }),
  );
  if (claimed.count === 1) {
    const after = await runUnscoped(() => prisma.messageUsage.findUnique({ where: { id: row.id } }));
    return {
      allowed: true,
      source: 'quota',
      meter,
      remaining: Math.max(0, (after?.included ?? row.included) - (after?.used ?? 0)),
    };
  }

  // 2. Purchased credits.
  const spent = await runUnscoped(() =>
    prisma.creditBalance.updateMany({
      where: { tenantId, meter, balance: { gte: quantity } },
      data: { balance: { decrement: quantity } },
    }),
  );
  if (spent.count === 1) {
    const balance = await runUnscoped(() =>
      prisma.creditBalance.findUnique({ where: { tenantId_meter: { tenantId, meter } } }),
    );
    // The allowance is still counted up so the salon can see it went over.
    await runUnscoped(() =>
      prisma.messageUsage.update({ where: { id: row.id }, data: { used: { increment: quantity } } }),
    );
    await runUnscoped(() =>
      prisma.creditLedger.create({
        data: {
          tenantId,
          meter,
          delta: -quantity,
          balanceAfter: balance?.balance ?? 0,
          reason: 'CONSUMPTION',
          note: 'Monthly allowance exhausted',
        },
      }),
    );
    return { allowed: true, source: 'credits', meter, credits: balance?.balance ?? 0 };
  }

  // 3. Overdraft — only to finish work already under way, and only so far.
  if (options.committed) {
    const tenant = await tenantWithPlan(tenantId);
    const ceiling = tenant.plan?.overdraftLimit ?? 0;
    const overdrawnAlready = Math.max(0, row.used - row.included);

    if (overdrawnAlready + quantity <= ceiling) {
      await runUnscoped(() =>
        prisma.messageUsage.update({ where: { id: row.id }, data: { used: { increment: quantity } } }),
      );

      // Crossing into overdraft stops everything new, immediately. The campaign
      // that caused it still finishes — the salon's customers should not get
      // half a send because of a billing question.
      await blockSending(
        tenantId,
        `${METER_LABELS[meter]} allowance was used up mid-campaign`,
        quantity,
      );

      return {
        allowed: true,
        source: 'overdraft',
        meter,
        remaining: 0,
        reason: 'Sent on overdraft to finish the campaign. New sending is now paused until this is settled.',
      };
    }
  }

  // 4. Nothing left.
  await runUnscoped(() =>
    prisma.messageUsage.update({ where: { id: row.id }, data: { blocked: { increment: quantity } } }),
  );
  await blockSending(tenantId, `${METER_LABELS[meter]} allowance exhausted`);

  return {
    allowed: false,
    source: null,
    meter,
    reason: `The ${METER_LABELS[meter]} allowance for this month is used up and there are no top-up credits left.`,
  };
}

/** Give back a message that was charged but never sent (provider hard failure). */
export async function refund(tenantId: string, meter: MeterKey | null, quantity = 1): Promise<void> {
  if (!meter || quantity <= 0) return;
  const row = await usageRow(tenantId, meter);
  await runUnscoped(() =>
    prisma.messageUsage.updateMany({
      where: { id: row.id, used: { gte: quantity } },
      data: { used: { decrement: quantity } },
    }),
  );
}

export interface AffordCheck {
  affordable: boolean;
  meter: MeterKey;
  needed: number;
  available: number;
  shortfall: number;
  reason: string | null;
}

/**
 * Can this salon afford to send `count` messages on this meter right now?
 *
 * Checked before a campaign is launched rather than discovered half-way
 * through. The overdraft exists to let a *running* campaign finish, not to
 * absorb a 5,000-recipient blast on a 500-message plan — so it is deliberately
 * not counted as available here.
 */
export async function canAfford(tenantId: string, meter: MeterKey, count: number): Promise<AffordCheck> {
  const status = await sendingStatus(tenantId);
  if (status.blocked) {
    return {
      affordable: false,
      meter,
      needed: count,
      available: 0,
      shortfall: count,
      reason:
        'Sending is paused on this account until the outstanding messages are settled. Nothing new can be started.',
    };
  }

  const summary = await usageSummary(tenantId);
  const available = summary.meters.find((m) => m.meter === meter)?.available ?? 0;
  const shortfall = Math.max(0, count - available);

  return {
    affordable: shortfall === 0,
    meter,
    needed: count,
    available,
    shortfall,
    reason:
      shortfall === 0
        ? null
        : `This campaign needs ${count.toLocaleString('en-IN')} ${METER_LABELS[meter]} messages and you have ` +
          `${available.toLocaleString('en-IN')} left — ${shortfall.toLocaleString('en-IN')} short. ` +
          'Add a top-up, or send it to a smaller segment.',
  };
}

export interface MeterSummary {
  meter: MeterKey;
  label: string;
  included: number;
  used: number;
  remaining: number;
  blocked: number;
  credits: number;
  /** Allowance plus credits — what the salon can actually still send. */
  available: number;
  percentUsed: number;
}

export interface UsageSummary {
  sending: { blocked: boolean; blockedAt: Date | null; reason: string | null; owedMessages: number };
  period: { start: Date; end: Date; label: string; daysLeft: number };
  plan: { code: string; name: string } | null;
  meters: MeterSummary[];
}

/** What the salon sees on its usage screen, and what alerts are built from. */
export async function usageSummary(tenantId: string): Promise<UsageSummary> {
  const tenant = await tenantWithPlan(tenantId);
  const period = periodFor(new Date(), tenant.timezone);

  const [rows, balances] = await runUnscoped(() =>
    Promise.all([
      prisma.messageUsage.findMany({ where: { tenantId, periodStart: period.start } }),
      prisma.creditBalance.findMany({ where: { tenantId } }),
    ]),
  );

  const meters = ALL_METERS.map((meter) => {
    const row = rows.find((r) => r.meter === meter);
    const included = row?.included ?? quotaOf(tenant.plan, meter);
    const used = row?.used ?? 0;
    const credits = balances.find((b) => b.meter === meter)?.balance ?? 0;
    const remaining = Math.max(0, included - used);
    return {
      meter,
      label: METER_LABELS[meter],
      included,
      used,
      remaining,
      blocked: row?.blocked ?? 0,
      credits,
      available: remaining + credits,
      percentUsed: included > 0 ? Math.min(100, Math.round((used / included) * 100)) : used > 0 ? 100 : 0,
    };
  });

  const blocked = await sendingStatus(tenantId);

  return {
    sending: blocked,
    period: {
      start: period.start,
      end: period.end,
      label: period.label,
      daysLeft: Math.max(0, dayjs(period.end).diff(dayjs(), 'day')),
    },
    plan: tenant.plan ? { code: tenant.plan.code, name: tenant.plan.name } : null,
    meters,
  };
}

export interface GrantInput {
  meter: MeterKey;
  quantity: number;
  packId?: string;
  amountPaid?: number;
  paymentMode?: PaymentMode;
  reference?: string;
  note?: string;
  createdBy?: string;
}

/**
 * Add credits to a tenant after they have paid for a pack.
 *
 * Payment happens off-platform — bank transfer, UPI, cash — and a platform
 * operator records it here. Nothing in this system talks to a payment gateway,
 * so credits only ever appear because a human confirmed the money arrived.
 */
export async function grantCredits(tenantId: string, input: GrantInput) {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) {
    throw BadRequest('Quantity must be a non-zero whole number');
  }

  return runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.creditBalance.findUnique({
        where: { tenantId_meter: { tenantId, meter: input.meter } },
      });

      const balance = existing
        ? await tx.creditBalance.update({
            where: { id: existing.id },
            data: { balance: { increment: input.quantity } },
          })
        : await tx.creditBalance.create({
            data: { tenantId, meter: input.meter, balance: Math.max(0, input.quantity) },
          });

      const entry = await tx.creditLedger.create({
        data: {
          tenantId,
          meter: input.meter,
          delta: input.quantity,
          balanceAfter: balance.balance,
          reason: input.quantity > 0 ? 'PURCHASE' : 'ADJUSTMENT',
          packId: input.packId ?? null,
          amountPaid: input.amountPaid ?? null,
          paymentMode: input.paymentMode ?? null,
          reference: input.reference ?? null,
          note: input.note ?? null,
          createdBy: input.createdBy ?? null,
        },
      });

      return { balance, entry };
    }),
  );
}

/** Buy a pack by code — resolves quantity and price from the catalogue. */
export async function redeemPack(
  tenantId: string,
  packCode: string,
  payment: { amountPaid?: number; paymentMode?: PaymentMode; reference?: string; createdBy?: string },
) {
  const pack = await runUnscoped(() => prisma.creditPack.findUnique({ where: { code: packCode } }));
  if (!pack || !pack.isActive) throw NotFound('Credit pack');

  return grantCredits(tenantId, {
    meter: pack.meter,
    quantity: pack.quantity,
    packId: pack.id,
    amountPaid: payment.amountPaid ?? Number(pack.price),
    paymentMode: payment.paymentMode,
    reference: payment.reference,
    note: `${pack.name} (${pack.code})`,
    createdBy: payment.createdBy,
  });
}

/** Salons that cannot send right now — the platform's own worklist. */
export async function blockedTenants() {
  const rows = await runUnscoped(() =>
    prisma.tenantMessagingConfig.findMany({
      where: { sendingBlocked: true },
      orderBy: { blockedAt: 'asc' },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true, plan: { select: { name: true } } } } },
    }),
  );

  return rows.map((row) => ({
    tenantId: row.tenantId,
    name: row.tenant.name,
    slug: row.tenant.slug,
    status: row.tenant.status,
    plan: row.tenant.plan?.name ?? null,
    blockedAt: row.blockedAt,
    reason: row.blockedReason,
    owedMessages: row.owedMessages,
  }));
}

export async function creditHistory(tenantId: string, limit = 50) {
  return runUnscoped(() =>
    prisma.creditLedger.findMany({
      where: { tenantId, reason: { not: 'CONSUMPTION' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { pack: { select: { code: true, name: true } } },
    }),
  );
}

// ------------------------------------------------------------------ packs --

export async function listPacks(options: { activeOnly?: boolean; planId?: string } = {}) {
  return runUnscoped(() =>
    prisma.creditPack.findMany({
      where: {
        ...(options.activeOnly ? { isActive: true } : {}),
        ...(options.planId ? { OR: [{ planId: null }, { planId: options.planId }] } : {}),
      },
      orderBy: [{ meter: 'asc' }, { sortOrder: 'asc' }, { quantity: 'asc' }],
    }),
  );
}

export interface PackInput {
  code: string;
  name: string;
  meter: MeterKey;
  quantity: number;
  price: number;
  planId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export async function createPack(input: PackInput) {
  const existing = await runUnscoped(() => prisma.creditPack.findUnique({ where: { code: input.code } }));
  if (existing) throw BadRequest(`A pack with code "${input.code}" already exists`);
  return runUnscoped(() => prisma.creditPack.create({ data: input }));
}

export async function updatePack(id: string, input: Partial<PackInput>) {
  const pack = await runUnscoped(() => prisma.creditPack.findUnique({ where: { id } }));
  if (!pack) throw NotFound('Credit pack');
  const { code: _code, ...rest } = input;
  return runUnscoped(() => prisma.creditPack.update({ where: { id }, data: rest }));
}
