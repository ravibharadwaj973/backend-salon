import type { Channel, Prisma, TemplateApprovalStatus, TemplateCategory } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { renderTemplate, missingVariables, buildVariables } from '../../messaging/dispatcher';

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

export async function listTemplates(input: { page?: number; pageSize?: number; channel?: Channel; category?: TemplateCategory }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.MessageTemplateWhereInput = {
    tenantId,
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

export async function deleteTemplate(id: string) {
  const inUse = await prisma.campaign.count({ where: { templateId: id, status: { in: ['SCHEDULED', 'RUNNING'] } } });
  if (inUse) throw Conflict('This template is used by a scheduled or running campaign');
  return prisma.messageTemplate.update({ where: { id }, data: { isActive: false } });
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
