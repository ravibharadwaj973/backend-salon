import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { runUnscoped, runAsTenant } from '../../core/context';
import { Conflict } from '../../core/errors';
import { slugify } from '../../core/ids';
import { addDays } from '../../core/dates';
import { hashPassword } from '../auth/auth.service';
import { logger } from '../../core/logger';
import { DEFAULT_JOURNEYS, DEFAULT_TEMPLATES } from '../messaging/defaults';

export interface ProvisionTenantInput {
  name: string;
  slug?: string;
  legalName?: string;
  gstin?: string;
  phone: string;
  email: string;
  addressLine?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  pincode?: string;
  currency?: string;
  timezone?: string;
  planCode?: string;
  trialDays?: number;
  owner: { name: string; email: string; phone?: string; password: string };
  branch?: { name?: string; code?: string; phone?: string; addressLine?: string; city?: string };
  seedDefaults?: boolean;
}

const DEFAULT_OPENING_HOURS: Prisma.InputJsonValue = {
  '0': [{ open: '10:00', close: '20:00' }],
  '1': [{ open: '10:00', close: '20:00' }],
  '2': [{ open: '10:00', close: '20:00' }],
  '3': [{ open: '10:00', close: '20:00' }],
  '4': [{ open: '10:00', close: '20:00' }],
  '5': [{ open: '10:00', close: '21:00' }],
  '6': [{ open: '10:00', close: '21:00' }],
};

const DEFAULT_SERVICE_CATEGORIES = ['Hair', 'Skin', 'Nails', 'Spa & Massage', 'Makeup', 'Grooming'];

const DEFAULT_EXPENSE_CATEGORIES: { name: string; isFixed: boolean }[] = [
  { name: 'Rent', isFixed: true },
  { name: 'Salaries', isFixed: true },
  { name: 'Electricity & Water', isFixed: false },
  { name: 'Product Purchase', isFixed: false },
  { name: 'Marketing', isFixed: false },
  { name: 'Maintenance', isFixed: false },
  { name: 'Internet & Phone', isFixed: true },
  { name: 'Miscellaneous', isFixed: false },
];

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || 'salon';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
    const existing = await runUnscoped(() => prisma.tenant.findUnique({ where: { slug: candidate } }));
    if (!existing) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/**
 * Creates a salon account end to end: tenant, owner login, first branch and the
 * defaults that make the product usable on day one (categories, loyalty rules,
 * WhatsApp templates and the standard customer journeys).
 */
export async function provisionTenant(input: ProvisionTenantInput) {
  const slug = input.slug ? input.slug : await uniqueSlug(input.name);

  const clash = await runUnscoped(() => prisma.tenant.findUnique({ where: { slug } }));
  if (clash) throw Conflict(`The slug "${slug}" is already taken`);

  const passwordHash = await hashPassword(input.owner.password);
  const trialDays = input.trialDays ?? 14;

  const result = await runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      const plan = input.planCode ? await tx.plan.findUnique({ where: { code: input.planCode } }) : null;

      const tenant = await tx.tenant.create({
        data: {
          name: input.name,
          slug,
          legalName: input.legalName ?? null,
          gstin: input.gstin || null,
          phone: input.phone,
          email: input.email,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          stateCode: input.stateCode ?? null,
          pincode: input.pincode || null,
          currency: input.currency ?? 'INR',
          timezone: input.timezone ?? 'Asia/Kolkata',
          status: 'TRIAL',
          trialEndsAt: addDays(new Date(), trialDays),
          planId: plan?.id ?? null,
          settings: {
            gstEnabled: Boolean(input.gstin),
            defaultGstRate: 18,
            invoiceRoundOff: true,
            allowOnlineBooking: true,
            appointmentSlotMinutes: 15,
            cancellationWindowHours: 4,
            noShowAfterMinutes: 30,
            reviewRequestAfterMinutes: 120,
            rebookingReminderDays: 30,
            winbackAfterDays: 60,
          } as Prisma.InputJsonValue,
        },
      });

      const branch = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          name: input.branch?.name ?? 'Main Branch',
          code: input.branch?.code ?? 'MAIN',
          phone: input.branch?.phone ?? input.phone,
          email: input.email,
          addressLine: input.branch?.addressLine ?? input.addressLine ?? null,
          city: input.branch?.city ?? input.city ?? null,
          state: input.state ?? null,
          stateCode: input.stateCode ?? null,
          pincode: input.pincode || null,
          gstin: input.gstin || null,
          timezone: input.timezone ?? 'Asia/Kolkata',
          openingHours: DEFAULT_OPENING_HOURS,
        },
      });

      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: input.owner.name,
          email: input.owner.email,
          phone: input.owner.phone ?? null,
          passwordHash,
          role: 'OWNER',
        },
      });

      await tx.userBranch.create({
        data: { tenantId: tenant.id, userId: owner.id, branchId: branch.id },
      });

      await tx.loyaltyProgram.create({
        data: {
          tenantId: tenant.id,
          isActive: true,
          amountPerPoint: 100,
          pointValue: 0.5,
          referralPoints: 100,
          birthdayPoints: 50,
          reviewPoints: 25,
          minRedeemPoints: 100,
          maxRedeemPctOfBill: 20,
          expiryMonths: 12,
        },
      });

      if (input.seedDefaults !== false) {
        await tx.serviceCategory.createMany({
          data: DEFAULT_SERVICE_CATEGORIES.map((name, i) => ({
            tenantId: tenant.id,
            name,
            sortOrder: i,
          })),
        });

        await tx.expenseCategory.createMany({
          data: DEFAULT_EXPENSE_CATEGORIES.map((c) => ({ tenantId: tenant.id, ...c })),
        });

        await tx.messageTemplate.createMany({
          data: DEFAULT_TEMPLATES.map((t) => ({ tenantId: tenant.id, ...t })),
        });

        for (const journey of DEFAULT_JOURNEYS) {
          await tx.journey.create({
            data: {
              tenantId: tenant.id,
              name: journey.name,
              description: journey.description,
              trigger: journey.trigger,
              triggerConfig: journey.triggerConfig as Prisma.InputJsonValue,
              isActive: journey.isActive,
              steps: {
                create: await Promise.all(
                  journey.steps.map(async (step, index) => {
                    const template = step.templateName
                      ? await tx.messageTemplate.findFirst({
                          where: { tenantId: tenant.id, name: step.templateName },
                        })
                      : null;
                    return {
                      tenantId: tenant.id,
                      sortOrder: index,
                      actionType: step.actionType,
                      delayMinutes: step.delayMinutes,
                      channel: step.channel ?? null,
                      templateId: template?.id ?? null,
                      config: (step.config ?? {}) as Prisma.InputJsonValue,
                    };
                  }),
                ),
              },
            },
          });
        }
      }

      return { tenant, branch, owner };
    }),
  );

  logger.info({ tenantId: result.tenant.id, slug }, 'tenant provisioned');
  return result;
}

/** Run a callback inside a freshly provisioned tenant's context. */
export function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runAsTenant(tenantId, fn);
}
