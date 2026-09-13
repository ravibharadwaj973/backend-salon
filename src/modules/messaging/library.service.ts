import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { TEMPLATE_LIBRARY, LIBRARY_OCCASIONS, findLibraryTemplate, type LibraryTemplate } from './library';

/**
 * Installing a library template copies it into the salon's own templates. From
 * that moment it is theirs: they rename it, rewrite it, change the offer, and
 * the library never touches it again. Nothing is ever sent from the library
 * directly — a shared template that a hundred salons send verbatim would make
 * every one of them sound the same.
 */

export interface LibraryListItem extends LibraryTemplate {
  /** True when this salon has already installed it. */
  installed: boolean;
  installedId?: string;
}

function suggestedName(template: LibraryTemplate): string {
  return template.title;
}

export async function browseLibrary(filter: { occasion?: string; channel?: string; q?: string } = {}) {
  const tenantId = requireTenantId();

  const existing = await prisma.messageTemplate.findMany({
    where: { tenantId },
    select: { id: true, name: true, libraryKey: true },
  });

  const byKey = new Map(existing.filter((t) => t.libraryKey).map((t) => [t.libraryKey!, t]));
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));

  const q = filter.q?.toLowerCase();

  const items: LibraryListItem[] = TEMPLATE_LIBRARY.filter((t) => {
    if (filter.occasion && t.occasion !== filter.occasion) return false;
    if (filter.channel && t.channel !== filter.channel) return false;
    if (q && !`${t.title} ${t.purpose} ${t.bodyText}`.toLowerCase().includes(q)) return false;
    return true;
  }).map((t) => {
    const match = byKey.get(t.key) ?? byName.get(suggestedName(t).toLowerCase());
    return { ...t, installed: Boolean(match), installedId: match?.id };
  });

  return {
    occasions: LIBRARY_OCCASIONS.map((occasion) => ({
      ...occasion,
      count: TEMPLATE_LIBRARY.filter((t) => t.occasion === occasion.key).length,
    })),
    items,
    total: items.length,
  };
}

export interface InstallOptions {
  /** Override the name — useful when installing a second variant. */
  name?: string;
  /** Replace the body at install time, so a salon can edit before saving. */
  bodyText?: string;
}

export async function installTemplate(key: string, options: InstallOptions = {}) {
  const tenantId = requireTenantId();
  const source = findLibraryTemplate(key);
  if (!source) throw NotFound('Library template');

  const name = options.name?.trim() || suggestedName(source);

  const clash = await prisma.messageTemplate.findFirst({
    where: { tenantId, name, channel: source.channel },
  });
  if (clash) {
    throw BadRequest(`You already have a ${source.channel.toLowerCase()} template called "${name}"`, {
      templateId: clash.id,
    });
  }

  return prisma.messageTemplate.create({
    data: {
      tenantId,
      libraryKey: source.key,
      name,
      channel: source.channel,
      category: source.category,
      language: source.language,
      bodyText: options.bodyText ?? source.bodyText,
      footerText: source.footerText ?? null,
      headerText: source.subject ?? null,
      variables: source.variables,
      // WhatsApp requires Meta's approval before a template can be sent, so a
      // freshly installed one is a draft until the salon registers it.
      approvalStatus: 'DRAFT',
      isActive: true,
      buttons: [] as unknown as Prisma.InputJsonValue,
    },
  });
}

/** Install a whole occasion at once — "set up all my festival messages". */
export async function installOccasion(occasion: string) {
  const templates = TEMPLATE_LIBRARY.filter((t) => t.occasion === occasion);
  if (!templates.length) throw NotFound('Occasion');

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const template of templates) {
    try {
      const created = await installTemplate(template.key);
      installed.push(created.name);
    } catch {
      // Already present, or a name clash — either way, leave what they have.
      skipped.push(template.title);
    }
  }

  return { installed, skipped, total: templates.length };
}
