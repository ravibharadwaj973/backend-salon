import type { Channel, JourneyActionType, JourneyTrigger, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runAsTenant, runUnscoped } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { dayjs } from '../../core/dates';
import { enqueue } from '../../jobs/queue';
import { queueMessage, buildVariables } from '../../messaging/dispatcher';
import { buildSegmentWhere, type SegmentRules } from './segment.service';
import { logger } from '../../core/logger';

export interface JourneyStepInput {
  actionType: JourneyActionType;
  delayMinutes: number;
  channel?: Channel;
  templateId?: string;
  config?: Record<string, unknown>;
  condition?: Record<string, unknown>;
}

export interface JourneyInput {
  name: string;
  description?: string;
  trigger: JourneyTrigger;
  triggerConfig?: Record<string, unknown>;
  audienceRules?: SegmentRules;
  isActive?: boolean;
  steps: JourneyStepInput[];
}

export async function listJourneys(input: { page?: number; pageSize?: number; isActive?: boolean }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.JourneyWhereInput = {
    tenantId,
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.journey.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        steps: { orderBy: { sortOrder: 'asc' }, include: { template: { select: { id: true, name: true } } } },
        _count: { select: { runs: true } },
      },
    }),
    prisma.journey.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getJourney(id: string) {
  const journey = await prisma.journey.findUnique({
    where: { id },
    include: { steps: { orderBy: { sortOrder: 'asc' }, include: { template: true } } },
  });
  if (!journey) throw NotFound('Journey');

  const [runStats, messageStats] = await Promise.all([
    prisma.journeyRun.groupBy({ by: ['status'], where: { journeyId: id }, _count: { _all: true } }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where: { journeyRun: { journeyId: id } },
      _count: { _all: true },
    }),
  ]);

  return {
    ...journey,
    stats: {
      runs: Object.fromEntries(runStats.map((r) => [r.status, r._count._all])),
      messages: Object.fromEntries(messageStats.map((m) => [m.status, m._count._all])),
    },
  };
}

export async function createJourney(input: JourneyInput) {
  const tenantId = requireTenantId();
  const clash = await prisma.journey.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('A journey with this name already exists');

  return prisma.journey.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      triggerConfig: (input.triggerConfig ?? {}) as Prisma.InputJsonValue,
      audienceRules: (input.audienceRules ?? {}) as unknown as Prisma.InputJsonValue,
      isActive: input.isActive ?? false,
      steps: {
        create: input.steps.map((step, index) => ({
          tenantId,
          sortOrder: index,
          actionType: step.actionType,
          delayMinutes: step.delayMinutes,
          channel: step.channel ?? null,
          templateId: step.templateId ?? null,
          config: (step.config ?? {}) as Prisma.InputJsonValue,
          condition: (step.condition ?? {}) as Prisma.InputJsonValue,
        })),
      },
    },
    include: { steps: { orderBy: { sortOrder: 'asc' } } },
  });
}

export async function updateJourney(id: string, input: Partial<JourneyInput>) {
  const tenantId = requireTenantId();
  const journey = await prisma.journey.findUnique({ where: { id } });
  if (!journey) throw NotFound('Journey');

  const { steps, triggerConfig, audienceRules, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    if (steps) {
      await tx.journeyStep.deleteMany({ where: { journeyId: id } });
      await tx.journeyStep.createMany({
        data: steps.map((step, index) => ({
          tenantId,
          journeyId: id,
          sortOrder: index,
          actionType: step.actionType,
          delayMinutes: step.delayMinutes,
          channel: step.channel ?? null,
          templateId: step.templateId ?? null,
          config: (step.config ?? {}) as Prisma.InputJsonValue,
          condition: (step.condition ?? {}) as Prisma.InputJsonValue,
        })),
      });
    }

    return tx.journey.update({
      where: { id },
      data: {
        ...(rest as Prisma.JourneyUpdateInput),
        ...(triggerConfig ? { triggerConfig: triggerConfig as Prisma.InputJsonValue } : {}),
        ...(audienceRules ? { audienceRules: audienceRules as unknown as Prisma.InputJsonValue } : {}),
      },
      include: { steps: { orderBy: { sortOrder: 'asc' } } },
    });
  });
}

export async function setJourneyActive(id: string, isActive: boolean) {
  const journey = await prisma.journey.findUnique({ where: { id }, include: { steps: true } });
  if (!journey) throw NotFound('Journey');
  if (isActive && journey.steps.length === 0) throw Conflict('Add at least one step before activating this journey');
  return prisma.journey.update({ where: { id }, data: { isActive } });
}

export interface TriggerContext {
  tenantId: string;
  trigger: JourneyTrigger;
  customerId?: string | null;
  leadId?: string | null;
  appointmentId?: string | null;
  invoiceId?: string | null;
  membershipId?: string | null;
  packagePurchaseId?: string | null;
  extra?: Record<string, string>;
}

/**
 * Entry point for every automation: something happened, so start any journey
 * that listens for it. Runs are deduplicated per journey + customer + trigger
 * reference so a retried job cannot double-message a customer.
 */
export async function triggerJourney(context: TriggerContext) {
  const journeys = await runUnscoped(() =>
    prisma.journey.findMany({
      where: { tenantId: context.tenantId, trigger: context.trigger, isActive: true },
      include: { steps: { orderBy: { sortOrder: 'asc' } } },
    }),
  );
  if (!journeys.length) return { started: 0 };

  let started = 0;

  for (const journey of journeys) {
    if (!journey.steps.length) continue;

    // Audience filter: only customers matching the journey's rules enter it.
    if (context.customerId) {
      const rules = journey.audienceRules as unknown as SegmentRules;
      if (rules?.conditions?.length) {
        const where = await buildSegmentWhere(context.tenantId, rules);
        const matches = await runUnscoped(() =>
          prisma.customer.count({ where: { ...where, id: context.customerId! } }),
        );
        if (!matches) continue;
      }

      const referenceId = context.appointmentId ?? context.invoiceId ?? context.membershipId ?? null;
      const duplicate = await runUnscoped(() =>
        prisma.journeyRun.findFirst({
          where: {
            journeyId: journey.id,
            customerId: context.customerId,
            status: 'ACTIVE',
            ...(referenceId ? { context: { path: ['referenceId'], equals: referenceId } } : {}),
          },
        }),
      );
      if (duplicate) continue;
    }

    const firstStep = journey.steps[0]!;

    await runUnscoped(async () => {
      const run = await prisma.journeyRun.create({
        data: {
          tenantId: context.tenantId,
          journeyId: journey.id,
          customerId: context.customerId ?? null,
          leadId: context.leadId ?? null,
          currentStep: 0,
          nextRunAt: dayjs().add(firstStep.delayMinutes, 'minute').toDate(),
          context: {
            appointmentId: context.appointmentId ?? null,
            invoiceId: context.invoiceId ?? null,
            membershipId: context.membershipId ?? null,
            packagePurchaseId: context.packagePurchaseId ?? null,
            referenceId: context.appointmentId ?? context.invoiceId ?? context.membershipId ?? null,
            extra: context.extra ?? {},
          } as Prisma.InputJsonValue,
        },
      });

      await enqueue(
        'journey.advance',
        { runId: run.id },
        { tenantId: context.tenantId, runAt: run.nextRunAt ?? new Date(), uniqueKey: `journey:${run.id}:0` },
      );
    });

    started += 1;
  }

  return { started };
}

/** Executes the run's current step, then schedules the next one. */
export async function advanceRun(runId: string) {
  const run = await runUnscoped(() =>
    prisma.journeyRun.findUnique({
      where: { id: runId },
      include: { journey: { include: { steps: { orderBy: { sortOrder: 'asc' } } } } },
    }),
  );
  if (!run) return { status: 'not_found' as const };
  if (run.status !== 'ACTIVE') return { status: 'inactive' as const };

  const step = run.journey.steps[run.currentStep];
  if (!step) {
    await runUnscoped(() =>
      prisma.journeyRun.update({
        where: { id: runId },
        data: { status: 'COMPLETED', completedAt: new Date(), nextRunAt: null },
      }),
    );
    return { status: 'completed' as const };
  }

  const runContext = (run.context as Record<string, unknown>) ?? {};
  const config = (step.config as Record<string, unknown>) ?? {};

  try {
    await runAsTenant(run.tenantId, async () => {
      switch (step.actionType) {
        case 'SEND_MESSAGE': {
          if (!step.templateId || !step.channel) break;
          const variables = await buildVariables({
            tenantId: run.tenantId,
            customerId: run.customerId,
            leadId: run.leadId,
            appointmentId: (runContext.appointmentId as string | null) ?? null,
            invoiceId: (runContext.invoiceId as string | null) ?? null,
            membershipId: (runContext.membershipId as string | null) ?? null,
            packagePurchaseId: (runContext.packagePurchaseId as string | null) ?? null,
            extra: {
              ...((runContext.extra as Record<string, string>) ?? {}),
              ...(config as Record<string, string>),
            },
          });

          await queueMessage({
            tenantId: run.tenantId,
            channel: step.channel,
            customerId: run.customerId,
            leadId: run.leadId,
            templateId: step.templateId,
            journeyRunId: run.id,
            variables,
          });
          break;
        }

        case 'ADD_TAG': {
          const tag = String(config.tag ?? '');
          if (run.customerId && tag) {
            const customer = await prisma.customer.findUnique({ where: { id: run.customerId } });
            if (customer && !customer.tags.includes(tag)) {
              await prisma.customer.update({
                where: { id: run.customerId },
                data: { tags: { set: [...customer.tags, tag] } },
              });
            }
          }
          break;
        }

        case 'REMOVE_TAG': {
          const tag = String(config.tag ?? '');
          if (run.customerId && tag) {
            const customer = await prisma.customer.findUnique({ where: { id: run.customerId } });
            if (customer) {
              await prisma.customer.update({
                where: { id: run.customerId },
                data: { tags: { set: customer.tags.filter((t) => t !== tag) } },
              });
            }
          }
          break;
        }

        case 'ADD_LOYALTY_POINTS': {
          const points = Number(config.points ?? 0);
          if (run.customerId && points > 0) {
            const customer = await prisma.customer.findUnique({ where: { id: run.customerId } });
            if (customer) {
              const balance = customer.loyaltyPoints + points;
              await prisma.customer.update({ where: { id: run.customerId }, data: { loyaltyPoints: balance } });
              await prisma.loyaltyTransaction.create({
                data: {
                  tenantId: run.tenantId,
                  customerId: run.customerId,
                  type: 'BONUS',
                  points,
                  balanceAfter: balance,
                  reason: String(config.reason ?? 'Journey bonus'),
                },
              });
            }
          }
          break;
        }

        case 'ADD_TO_SEGMENT': {
          const segmentId = String(config.segmentId ?? '');
          if (run.customerId && segmentId) {
            await prisma.segmentMember
              .create({ data: { tenantId: run.tenantId, segmentId, customerId: run.customerId } })
              .catch(() => undefined);
          }
          break;
        }

        case 'CREATE_TASK': {
          await prisma.businessAlert
            .create({
              data: {
                tenantId: run.tenantId,
                type: String(config.type ?? 'JOURNEY_TASK'),
                title: String(config.title ?? 'Follow up with customer'),
                body: String(config.body ?? ''),
                severity: 'INFO',
                data: { customerId: run.customerId, journeyId: run.journeyId } as Prisma.InputJsonValue,
                forDate: new Date(new Date().toISOString().slice(0, 10)),
              },
            })
            .catch(() => undefined);
          break;
        }

        case 'EXIT_IF_BOOKED': {
          // Retention journeys stop the moment the customer books again.
          if (run.customerId) {
            const booked = await prisma.appointment.count({
              where: { customerId: run.customerId, createdAt: { gte: run.startedAt }, status: { not: 'CANCELLED' } },
            });
            if (booked > 0) {
              await prisma.journeyRun.update({
                where: { id: runId },
                data: { status: 'EXITED', completedAt: new Date(), nextRunAt: null },
              });
              return;
            }
          }
          break;
        }

        case 'WAIT':
        default:
          break;
      }
    });
  } catch (err) {
    logger.error({ err, runId, step: step.sortOrder }, 'journey step failed');
    await runUnscoped(() =>
      prisma.journeyRun.update({
        where: { id: runId },
        data: { lastError: err instanceof Error ? err.message : 'Step failed' },
      }),
    );
  }

  const refreshed = await runUnscoped(() => prisma.journeyRun.findUnique({ where: { id: runId } }));
  if (!refreshed || refreshed.status !== 'ACTIVE') return { status: 'exited' as const };

  const nextIndex = run.currentStep + 1;
  const nextStep = run.journey.steps[nextIndex];

  if (!nextStep) {
    await runUnscoped(() =>
      prisma.journeyRun.update({
        where: { id: runId },
        data: { status: 'COMPLETED', completedAt: new Date(), nextRunAt: null, currentStep: nextIndex },
      }),
    );
    return { status: 'completed' as const };
  }

  const nextRunAt = dayjs().add(nextStep.delayMinutes, 'minute').toDate();
  await runUnscoped(() =>
    prisma.journeyRun.update({ where: { id: runId }, data: { currentStep: nextIndex, nextRunAt } }),
  );
  await enqueue(
    'journey.advance',
    { runId },
    { tenantId: run.tenantId, runAt: nextRunAt, uniqueKey: `journey:${runId}:${nextIndex}` },
  );

  return { status: 'advanced' as const, nextStep: nextIndex };
}

export async function listRuns(journeyId: string, input: { page?: number; pageSize?: number; status?: string }) {
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.JourneyRunWhereInput = {
    journeyId,
    ...(input.status ? { status: input.status as Prisma.EnumJourneyRunStatusFilter['equals'] } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.journeyRun.findMany({
      where,
      skip,
      take,
      orderBy: { startedAt: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        messages: { select: { id: true, status: true, channel: true, sentAt: true } },
      },
    }),
    prisma.journeyRun.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function cancelRun(id: string) {
  return prisma.journeyRun.update({
    where: { id },
    data: { status: 'CANCELLED', nextRunAt: null, completedAt: new Date() },
  });
}
