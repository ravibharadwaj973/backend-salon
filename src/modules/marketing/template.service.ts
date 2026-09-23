import type { Channel, Prisma, TemplateApprovalStatus, TemplateCategory } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { renderTemplate, missingVariables, buildVariables } from '../../messaging/dispatcher';
import { DEFAULT_TEMPLATES } from '../messaging/defaults';

export interface TemplateInput {
  name: string;
  channel: Channel;
  category?: TemplateCategory;
  language?: string;
  providerTemplateName?: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttons?: unknown[];
  variables?: string[];
  approvalStatus?: TemplateApprovalStatus;
  isActive?: boolean;
}

/** Pulls {{placeholders}} out of the body so the UI can list them. */
export function extractVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!))];
}

/**
 * Add any starter templates this salon is missing, without touching the ones
 * it has.
 *
 * Templates are seeded once, when the salon is created. A salon provisioned
 * before email and SMS starters existed has an empty picker on those tabs
 * forever — which reads as a broken screen, not an empty cupboard — and the
 * only way out was to write every message by hand.
 *
 * `skipDuplicates` against (tenantId, name, channel) is what makes this safe
 * to run any number of times: a salon that has rewritten its confirmation
 * message keeps its own wording, and only genuinely absent rows are added.
 * Nothing here ever overwrites.
 */
export async function restoreDefaultTemplates() {
  const tenantId = requireTenantId();

  const existing = await prisma.messageTemplate.findMany({
    where: { tenantId },
    select: { name: true, channel: true },
  });
  const have = new Set(existing.map((t) => `${t.name}::${t.channel}`));

  const missing = DEFAULT_TEMPLATES.filter((t) => !have.has(`${t.name}::${t.channel}`));
  if (missing.length === 0) return { added: 0, byChannel: {} as Record<string, number> };

  await prisma.messageTemplate.createMany({
    data: missing.map((t) => ({ tenantId, ...t })),
    skipDuplicates: true,
  });

  const byChannel = missing.reduce<Record<string, number>>((acc, t) => {
    acc[t.channel] = (acc[t.channel] ?? 0) + 1;
    return acc;
  }, {});

  return { added: missing.length, byChannel };
}

/**
 * Archived templates are hidden by default.
 *
 * deleteTemplate has always been a soft delete -- it sets isActive false so
 * that campaigns, journeys and the message log keep pointing at something
 * real. But this listing never filtered on it, so pressing Delete removed
 * nothing anybody could see, and the only way to tell was that the card was
 * still there after the page refreshed.
 */
export async function listTemplates(input: {
  page?: number;
  pageSize?: number;
  channel?: Channel;
  category?: TemplateCategory;
  includeArchived?: boolean;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.MessageTemplateWhereInput = {
    tenantId,
    ...(input.includeArchived ? {} : { isActive: true }),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.category ? { category: input.category } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.messageTemplate.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
    prisma.messageTemplate.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getTemplate(id: string) {
  const template = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!template) throw NotFound('Message template');
  return template;
}

export async function createTemplate(input: TemplateInput) {
  const tenantId = requireTenantId();
  const clash = await prisma.messageTemplate.findFirst({
    where: { tenantId, name: input.name, channel: input.channel },
  });
  if (clash) throw Conflict('A template with this name already exists for that channel');

  return prisma.messageTemplate.create({
    data: {
      tenantId,
      ...input,
      buttons: (input.buttons ?? []) as Prisma.InputJsonValue,
      variables: input.variables ?? extractVariables(input.bodyText),
    },
  });
}

export async function updateTemplate(id: string, input: Partial<TemplateInput>) {
  const template = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!template) throw NotFound('Message template');

  return prisma.messageTemplate.update({
    where: { id },
    data: {
      ...input,
      ...(input.buttons ? { buttons: input.buttons as Prisma.InputJsonValue } : {}),
      ...(input.bodyText && !input.variables ? { variables: extractVariables(input.bodyText) } : {}),
    },
  });
}

/**
 * Archive, or actually delete.
 *
 * Archiving is the default and the right answer nearly always: the row stays,
 * so every message ever sent from it keeps its wording and every journey that
 * points at it still resolves.
 *
 * Permanent deletion exists for the case archiving does not answer — a
 * template that is not on Meta and never will be: a test, a mistake, or one
 * deleted in WhatsApp Manager. Those are clutter rather than history, and a
 * list nobody can tidy stops being read.
 *
 * It is refused while Meta still holds the template. Deleting our record would
 * not delete Meta's copy; it would only lose the id that links the two, and the
 * next sync would offer the same template back as an import. Meta first, then
 * here — which is also what the salon means when they say it is gone.
 */
export async function deleteTemplate(id: string, options?: { permanent?: boolean }) {
  const template = await getTemplate(id);

  const inUse = await prisma.campaign.count({ where: { templateId: id, status: { in: ['SCHEDULED', 'RUNNING'] } } });
  if (inUse) throw Conflict('This template is used by a scheduled or running campaign');

  if (!options?.permanent) {
    return { ...(await prisma.messageTemplate.update({ where: { id }, data: { isActive: false } })), permanent: false };
  }

  if (template.providerTemplateId && template.approvalStatus !== 'DISABLED') {
    throw Conflict(
      `"${template.name}" still exists on your WhatsApp account (${template.approvalStatus.toLowerCase()}). ` +
        'Delete it in WhatsApp Manager first, then press Sync with Meta — deleting it here alone would only lose ' +
        'the link between the two, and the next sync would offer it back as an import.',
    );
  }

  // Counted before the delete, because afterwards there is nothing to count.
  // MessageLog, Campaign and JourneyStep all hold templateId as a nullable
  // SetNull reference, so none of them are destroyed by this — a sent message
  // keeps the wording it was sent with, and a journey step loses its template
  // and says so rather than silently sending nothing.
  const [sent, steps] = await Promise.all([
    prisma.messageLog.count({ where: { templateId: id } }),
    prisma.journeyStep.count({ where: { templateId: id } }),
  ]);

  await prisma.messageTemplate.delete({ where: { id } });

  return { id, name: template.name, permanent: true, sentMessages: sent, journeySteps: steps };
}

/** Renders the template against sample data so the owner sees the real message. */
export async function previewTemplate(id: string, sample: { customerId?: string; variables?: Record<string, string> }) {
  const tenantId = requireTenantId();
  const template = await getTemplate(id);

  const resolved = await buildVariables({
    tenantId,
    customerId: sample.customerId ?? null,
    extra: sample.variables,
  });

  const merged = {
    customer_name: 'Priya',
    salon_name: 'Your Salon',
    appointment_date: '12 Sep 2026',
    appointment_time: '4:30 PM',
    staff_name: 'Riya',
    services: 'Hair Spa, Haircut',
    amount: '₹1,650',
    ...resolved,
    ...(sample.variables ?? {}),
  };

  return {
    template,
    rendered: renderTemplate(template.bodyText, merged),
    unresolved: missingVariables(template.bodyText, merged),
    variablesUsed: extractVariables(template.bodyText),
  };
}
